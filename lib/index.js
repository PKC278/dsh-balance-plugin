/**
* Host half of the DeepSeek balance card.
 *
 * The browser cannot access provider credentials, so this half owns the single
 * privileged operation: resolve the credential of the model the user selected,
 * request the DeepSeek balance endpoint with it, and hand the browser only the
 * resulting amounts. The credential itself never crosses into the page.
 *
 * The cache belongs to this half as well, so the page never has to judge it: a
 * request either allows reuse, in which case an entry still inside its window is
 * answered as it stands, or forces a platform read. Every successful answer
 * carries how long its entry stays usable, which is what the page schedules its
 * next automatic request from, so a reconfigured `cacheTtlMs` moves the page's
 * cadence with it instead of leaving a second constant behind. The window itself
 * is floored at `MIN_CACHE_TTL_MS`, since the page no longer clamps what it is
 * given. Requests that arrive together for one credential share a
 * single platform call, so several open pages cost one query per window rather
 * than one per page.
 *
 * Only the two DeepSeek routes are queried, matching the providers whose
 * balances this endpoint reports: the official API key and the signed-in
 * account. Any other selected provider resolves to `unsupported`, so no
 * credential of an unrelated vendor is ever accessed.
 *
 * The endpoint follows the selected provider rather than being carried here, so a
 * deployment that points DeepSeek at another Messages-compatible root reports its
 * balance from that root too. Only the origin is taken, because the balance route
 * sits at the platform root while the provider endpoint carries its protocol
 * prefix.
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
/**
 * Official endpoint of the DeepSeek Messages API. It stands in for a deployment
 * that configures no endpoint of its own, and the balance route shares its origin.
 */
const OFFICIAL_BASE_URL = "https://api.deepseek.com/anthropic";
/** Origin of that endpoint, admitted for the account credential when nothing overrides it. */
const OFFICIAL_ORIGIN = new URL(OFFICIAL_BASE_URL).origin;
/** Environment variable naming the provider endpoint, resolved in the provider's own order. */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
/** Balance route, relative to the origin of the provider endpoint. */
const BALANCE_PATH = "/user/balance";
/** Request timeout; the card retries on the next poll after a failure. */
const REQUEST_TIMEOUT_MS = 8000;
/** Cap on the response body read from DeepSeek. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** How long a successful read is reused for the same credential. */
const DEFAULT_CACHE_TTL_MS = 300000;
/**
 * Shortest cache window this half honours. It lives here because the page
 * schedules its next read straight from that window and no longer clamps it
 * itself: a window of zero would have the page re-ask at network speed, and every
 * one of those reads would reach the platform.
 */
const MIN_CACHE_TTL_MS = 1000;
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
* Origin of one candidate provider endpoint, or undefined when it is not a usable
* absolute HTTP(S) URL. Only the origin is taken, because the balance route sits
* at the platform root while the provider endpoint carries its protocol prefix.
* @param value - candidate endpoint from configuration or from the launch environment.
* @returns the origin, or undefined when the candidate supplies none.
*/
function parseOrigin(value) {
	if (typeof value !== "string" || value === "") return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
	} catch (_invalid) {
		return undefined;
	}
}

/**
* Fingerprint one request for the cache. The credential is hashed rather than
* stored, so the map never holds a secret, and two sessions that end up sending
* the same credential share a single entry. The origin is part of the key, so a
* redeployed endpoint never answers from another endpoint's entry.
* @param provider - LLM provider route.
* @param origin - origin the request will reach.
* @param headers - the credential headers about to be sent.
* @returns a stable cache key.
*/
function fingerprint(provider, origin, headers) {
	return createHash("sha256").update(CACHE_KEY_PREFIX).update("\0").update(provider).update("\0").update(origin).update("\0").update(JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)))).digest("hex");
}

/**
* DeepSeek balance card: endpoint, credential resolution, and the single platform request.
 * @param ctx - Host plugin context.
 * @param config - optional `cacheTtlMs` override.
 */
export function apply(ctx, config = {}) {
	const configuredTtlMs = Number.isFinite(config.cacheTtlMs) && config.cacheTtlMs >= 0 ? config.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
	// A window shorter than the floor is served as the floor: the page schedules
	// whatever it is told, so a very short window would only make it ask again.
	const cacheTtlMs = Math.max(MIN_CACHE_TTL_MS, configuredTtlMs);
	/** Successful reads by credential fingerprint; a new read for the same credential replaces its entry. */
	const cache = new Map();
	/** Platform read in progress per fingerprint, awaited by every request that arrives while it runs. */
	const inFlight = new Map();
	/**
	* Resolved endpoint origin per provider. Reading it costs a profile reload and a
	* form projection per entry, which is far more than the one field it yields, so
	* the value is resolved once per provider and only discarded when a
	* configuration document changes.
	*/
	const origins = new Map();
	// The settings service publishes one event per entry whose raw configuration
	// changed. Two cached origins at most, so invalidating all of them costs nothing
	// and avoids asking which provider the event belonged to.
	ctx.effect(() => ctx.on("settings/document-updated", () => origins.clear()), "ui-balance: endpoint cache");

	/**
	* Endpoint the selected provider requests, resolved the way that provider
	* resolves it: an explicit configuration value first, then the launch
	* environment, then the official root. Either service may be absent in a
	* composition that mounts the card without the LLM directory, and then the
	* official root stands.
	* @param provider - LLM provider route.
	* @returns the configured endpoint, or undefined when nothing supplies one.
	*/
	const providerBaseUrl = (provider) => {
		try {
			const llm = ctx.get("llm");
			const settings = ctx.get("settings");
			if (llm !== undefined && settings !== undefined) {
				// The directory locates the provider's configuration, so this half never
				// depends on how a profile happens to spell the entry id.
				const declared = llm.listConfigurableProviders().find((candidate) => candidate.provider === provider);
				if (declared !== undefined) {
					const descriptor = settings.describe().find((candidate) => candidate.ns === declared.settingsNs);
					let section = descriptor === undefined ? undefined : descriptor.value;
					for (const key of declared.settingsPath ?? []) {
						section = section === undefined || section === null ? undefined : section[key];
					}
					const configured = section === undefined || section === null ? undefined : section.baseURL;
					if (typeof configured === "string" && configured !== "") return configured;
				}
			}
		} catch (_unavailableDirectory) {
			// A directory that cannot answer is treated exactly like an absent one.
		}
		const fromEnvironment = ctx.get("launchEnvironment")?.get(BASE_URL_ENV)?.value;
		return typeof fromEnvironment === "string" && fromEnvironment !== "" ? fromEnvironment : undefined;
	};

	/**
	* Origin the balance read is sent to. The card follows the provider's own
	* endpoint rather than carrying one, so a deployment that redirects DeepSeek
	* traffic gets its balance from that deployment too, and the account token is
	* granted for exactly the origin the read will reach.
	* @param provider - LLM provider route.
	* @returns the resolved origin, or the official one when nothing overrides it.
	*/
	const providerOrigin = (provider) => {
		const cached = origins.get(provider);
		if (cached !== undefined) return cached;
		const origin = parseOrigin(providerBaseUrl(provider)) ?? OFFICIAL_ORIGIN;
		origins.set(provider, origin);
		return origin;
	};

	/** Resolve the credential of one provider route, authorized for the origin it will be sent to. */
	const resolveCredential = async (entry, provider, origin) => {
		if (entry.account === true) {
			const account = ctx.get("deepseekAccount");
			const session = account === undefined ? undefined : await account.resolveToken(`${origin}/`);
			return session === undefined ? { kind: "missing-credential", provider, source: entry.label } : { kind: "ok", provider, source: entry.label, headers: { "x-dsh-auth-token": session } };
		}
		const credentials = ctx.get("credentials");
		const resolved = credentials === undefined ? undefined : await credentials.resolve(entry.ref);
		return resolved === undefined || resolved.value === "" ? { kind: "missing-credential", provider, source: entry.label } : { kind: "ok", provider, source: entry.label, headers: { authorization: `Bearer ${resolved.value}` } };
	};

	/** Ask the platform for the wallets this credential can see. */
	const fetchBalance = async (origin, headers) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${origin}${BALANCE_PATH}`, {
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
	* Read the platform at most once per credential at a time. A request that
	* arrives while a read for the same credential is running awaits that read
	* instead of starting a second one, which is what keeps several pages whose
	* entry expires together from spending one query each.
	* @param key - credential fingerprint.
	* @param origin - origin the read is sent to.
	* @param headers - credential headers for this request.
	* @returns the platform result, shared by every waiter and storing the entry.
	*/
	const upstreamOnce = (key, origin, headers) => {
		const pending = inFlight.get(key);
		if (pending !== undefined) return pending;
		const started = fetchBalance(origin, headers).then((result) => {
			if (result.kind === "ok") {
				if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
					const oldest = cache.keys().next();
					if (!oldest.done) cache.delete(oldest.value);
				}
				cache.set(key, { at: Date.now(), result });
			}
			return result;
		}).finally(() => {
			// Only this call may clear the slot: deleting by key could drop the pending
			// read a later request has already registered under the same fingerprint.
			if (inFlight.get(key) === started) inFlight.delete(key);
		});
		inFlight.set(key, started);
		return started;
	};

	/**
	* How long one cached entry stays usable. It is the only cache fact the page is
	* allowed to schedule from, which keeps the subtraction on this side of the
	* route. A partly spent entry can therefore report a few milliseconds; the next
	* read then finds the window closed and refreshes it.
	* @param entry - the cached entry, or undefined when no read has stored one.
	* @returns milliseconds left of that entry's window.
	*/
	const remainingOf = (entry) => Math.max(0, cacheTtlMs - (entry === undefined ? 0 : Date.now() - entry.at));

	/**
	* Request once through the cache. A plain request is answered from a valid
	* entry and reaches the platform once it has expired; a forced request always
	* reaches the platform. Only a successful answer is stored, so a failure or an
	* unavailable account is retried on the next request instead of being frozen
	* for the whole window, and every successful request restarts that window from
	* now.
	* @param key - credential fingerprint.
	* @param origin - origin the read is sent to.
	* @param headers - credential headers for this request.
	* @param force - bypass the entry and refresh it.
	* @returns the answer, carrying the remaining lifetime of its entry.
	*/
	const readBalance = async (key, origin, headers, force) => {
		const entry = cache.get(key);
		if (!force && entry !== undefined && Date.now() - entry.at < cacheTtlMs) {
			return { ...entry.result, cached: true, expiresInMs: remainingOf(entry) };
		}
		const result = await upstreamOnce(key, origin, headers);
		if (result.kind !== "ok") return { ...result, cached: false };
		return { ...result, cached: false, expiresInMs: remainingOf(cache.get(key)) };
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
					const entry = providerEntry(provider);
					if (entry === undefined) {
						sendJson(response, 200, { kind: "unsupported", provider });
						return;
					}
					// The endpoint is resolved first: the account token is granted for exactly
					// the origin this read will reach.
					const origin = providerOrigin(provider);
					const credential = await resolveCredential(entry, provider, origin);
					if (credential.kind !== "ok") {
						sendJson(response, 200, credential);
						return;
					}
					const key = fingerprint(provider, origin, credential.headers);
					// `force` is the whole cache decision the page gets to make: it is
					// absent on the automatic path and set by a click and by the end of a
					// turn, which are the two moments the page knows the amount is stale.
					const result = await readBalance(key, origin, credential.headers, body.force === true);
					sendJson(response, 200, result.kind === "ok"
						? { kind: "ok", provider, source: credential.source, cached: result.cached, expiresInMs: result.expiresInMs, ...result.payload }
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
