/**
* Host half of the DeepSeek balance card.
 *
 * The browser cannot access provider credentials, so this half owns the single
 * privileged operation: resolve the credential of the model the user selected,
 * request the DeepSeek balance endpoint with it, and hand the browser only the
 * resulting amounts. The credential itself never crosses into the page.
 *
 * Only the two DeepSeek routes are queried, matching the providers whose
 * balances this endpoint reports: the official API key and the signed-in
 * account. Any other selected provider resolves to `unsupported`, so no
 * credential of an unrelated vendor is ever accessed.
 *
 * The route borrows the Connection service's Host/Origin fence and browser
 * authentication instead of carrying an access token of its own. A token would
 * have to reach the page through the boot payload, which the desktop shell
 * snapshots once at host start, so a plugin installed mid-session could never
 * obtain it. Connection's checks are already satisfied by the page's session
 * cookie, which means the card works the moment the bundle is installed.
 */
import { createHash } from "node:crypto";

/** Exact route the balance card calls. */
const ROUTE = "/api/dsh-balance";
/** Balance endpoint of the DeepSeek platform API. */
const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** Request timeout; the card retries on the next poll after a failure. */
const REQUEST_TIMEOUT_MS = 8000;
/** Cap on the response body read from DeepSeek. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** How long a successful read is reused for the same credential. */
const DEFAULT_CACHE_TTL_MS = 300000;
/** Entries kept before the oldest is dropped, so a stream of credentials cannot grow the cache without bound. */
const MAX_CACHE_ENTRIES = 32;
/** Domain separator of the cache key; it keeps the key construction explicit. */
const CACHE_KEY_PREFIX = "dsh-balance-cache-v1";

/**
 * The only providers this plugin authenticates, keyed by LLM route. A route that
 * is absent here is refused rather than guessed at, so no credential of another
 * vendor is ever accessed or sent.
 * `ref` is the credential reference of the API-key route; `account` marks the
 * route whose credential is the signed-in DeepSeek account token.
 */
const PROVIDERS = {
	"deepseek-official": { ref: "DEEPSEEK_API_KEY", label: "DeepSeek API Key" },
	"deepseek-account": { account: true, label: "DeepSeek Account" }
};

/** Credential reference of a provider route, when it is one of the DeepSeek routes. */
function providerEntry(provider) {
	if (typeof provider !== "string" || provider === "") return undefined;
	return Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
}

/** Write one JSON response and end it. */
function sendJson(response, status, body) {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	response.end(payload);
}

/** Read and parse the request body, rejecting anything that is not a small JSON object. */
async function readJsonBody(request) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > 16 * 1024) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}

/** Read one decimal amount from the platform payload without losing precision. */
function amountOf(value) {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
* Normalize the platform payload into the small shape the card renders.
* The platform names the headline amount `total_balance`; older payloads call it
* `balance`, so both are accepted in that order.
*/
function summarize(payload) {
	const wallets = Array.isArray(payload.balance_infos)
		? payload.balance_infos.map((wallet) => {
			const source = wallet !== null && typeof wallet === "object" ? wallet : {};
			return {
				currency: typeof source.currency === "string" ? source.currency : "CNY",
				balance: amountOf(source.total_balance) ?? amountOf(source.balance),
				granted: amountOf(source.granted_balance),
				toppedUp: amountOf(source.topped_up_balance)
			};
		}).filter((wallet) => wallet.balance !== undefined)
		: [];
	return { isAvailable: payload.is_available === true, wallets };
}

/**
* Fingerprint one request for the cache. The credential is hashed rather than
* stored, so the map never holds a secret, and two sessions that end up sending
* the same credential share a single entry.
* @param provider - LLM provider route.
* @param headers - the credential headers about to be sent.
* @returns a stable cache key.
*/
function fingerprint(provider, headers) {
	return createHash("sha256").update(CACHE_KEY_PREFIX).update("\0").update(provider).update("\0").update(JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)))).digest("hex");
}

/** Origin of the balance endpoint, used to admit the account credential for exactly that destination. */
function originOf(baseUrl) {
	try {
		return new URL(baseUrl).origin;
	} catch (_invalid) {
		return baseUrl;
	}
}

/**
* DeepSeek balance card: endpoint, credential resolution, and the single platform request.
 * @param ctx - Host plugin context.
 * @param config - optional `baseUrl` and `cacheTtlMs` overrides.
 */
export function apply(ctx, config = {}) {
	const baseUrl = typeof config.baseUrl === "string" && config.baseUrl !== "" ? config.baseUrl.replace(/\/+$/u, "") : DEFAULT_BASE_URL;
	const cacheTtlMs = Number.isFinite(config.cacheTtlMs) && config.cacheTtlMs >= 0 ? config.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
	/** Successful reads by credential fingerprint; a new read for the same credential replaces its entry. */
	const cache = new Map();

	/** Resolve the credential of one provider route. */
	const resolveCredential = async (provider) => {
		const entry = providerEntry(provider);
		if (entry === undefined) return { kind: "unsupported", provider };
		if (entry.account === true) {
			const account = ctx.get("deepseekAccount");
			const session = account === undefined ? undefined : await account.resolveToken(`${originOf(baseUrl)}/`);
			return session === undefined ? { kind: "missing-credential", provider, source: entry.label } : { kind: "ok", provider, source: entry.label, headers: { "x-dsh-auth-token": session } };
		}
		const credentials = ctx.get("credentials");
		const resolved = credentials === undefined ? undefined : await credentials.resolve(entry.ref);
		return resolved === undefined || resolved.value === "" ? { kind: "missing-credential", provider, source: entry.label } : { kind: "ok", provider, source: entry.label, headers: { authorization: `Bearer ${resolved.value}` } };
	};

	/** Ask the platform for the wallets this credential can see. */
	const fetchBalance = async (headers) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${baseUrl}/user/balance`, {
				method: "GET",
				headers: { accept: "application/json", ...headers },
				signal: controller.signal
			});
			const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
			if (!response.ok) return { kind: "http-error", status: response.status, message: text.slice(0, 400) };
			let payload;
			try {
				payload = JSON.parse(text);
			} catch (_invalid) {
				return { kind: "invalid-response", message: text.slice(0, 200) };
			}
			return { kind: "ok", payload: summarize(payload) };
		} catch (error) {
			return { kind: "network-error", message: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	};

	/**
	* Report one credential's cache state without touching the platform. The client
	* asks this first, so a request that another session has already paid for is not
	* paid for again.
	* @param key - credential fingerprint.
	* @returns freshness, the age of the entry, and the amount it holds.
	*/
	const cacheStatus = (key) => {
		const hit = cache.get(key);
		if (hit === undefined) return { fresh: false };
		const ageMs = Date.now() - hit.at;
		// The payload is spread flat, so a client that reuses this answer sees the
		// same shape it would receive from a fresh request.
		return { fresh: ageMs < cacheTtlMs, ageMs, ...hit.result.payload };
	};

	/**
	* Request once through the cache. Only a successful answer is stored, so a
	* failure or an unavailable account is retried on the next request instead of
	* being frozen for the whole window, and every successful request restarts that
	* window from now.
	* @param key - credential fingerprint.
	* @param headers - credential headers for this request.
	* @param force - bypass the entry and refresh it.
	* @returns the fresh or cached answer, carrying the cache state.
	*/
	const readBalance = async (key, headers, force) => {
		const hit = cache.get(key);
		if (!force && hit !== undefined && Date.now() - hit.at < cacheTtlMs) return { ...hit.result, cached: true };
		const result = await fetchBalance(headers);
		if (result.kind === "ok") {
			if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
				const oldest = cache.keys().next();
				if (!oldest.done) cache.delete(oldest.value);
			}
			cache.set(key, { at: Date.now(), result });
		}
		return { ...result, cached: false };
	};

	ctx.inject(["webServer", "connection"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: ROUTE,
			handler: async (request, response) => {
				try {
					const rejection = webCtx.connection.requestRejection({ headers: request.headers });
					if (rejection !== undefined) {
						sendJson(response, rejection, { kind: rejection === 401 ? "unauthorized" : "forbidden" });
						return;
					}
					if (request.method !== "POST") {
						sendJson(response, 405, { kind: "method-not-allowed" });
						return;
					}
					const body = await readJsonBody(request);
					const provider = typeof body.provider === "string" ? body.provider : "";
					const credential = await resolveCredential(provider);
					if (credential.kind !== "ok") {
						sendJson(response, 200, credential);
						return;
					}
					const key = fingerprint(provider, credential.headers);
					// `status` answers from the cache alone; every other action requests the
					// platform, and the client asks for a forced one whenever it wants
					// current data.
					if (body.action === "status") {
						sendJson(response, 200, { kind: "ok", provider, source: credential.source, ...cacheStatus(key) });
						return;
					}
					const result = await readBalance(key, credential.headers, body.force === true);
					sendJson(response, 200, result.kind === "ok"
						? { kind: "ok", provider, source: credential.source, cached: result.cached, ...result.payload }
						: { kind: result.kind, provider, source: credential.source, status: result.status, message: result.message });
				} catch (error) {
					ctx.logger?.warn(error instanceof Error ? error : new Error(String(error)));
					sendJson(response, 400, { kind: "bad-request" });
				}
			}
		}), "ui-balance: balance route");
	});
}

export const name = "ui-balance";
