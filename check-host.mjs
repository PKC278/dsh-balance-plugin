/**
 * Offline contract check for the host half.
 *
 * A throwaway HTTP server stands in for the DeepSeek platform, so the whole
 * privileged path is exercised: provider gating, credential resolution, the
* balance request, and the response shaping the card consumes.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { apply } = await import("./lib/index.js");

const seen = [];
const platform = createServer((request, response) => {
	seen.push({ url: request.url, headers: request.headers });
	if (request.headers["x-dsh-auth-token"] === "account-token") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "0.54", granted_balance: "0.00", topped_up_balance: "0.54" }] }));
		return;
	}
	if (request.headers.authorization === "Bearer api-key") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "223.06", granted_balance: "0.00", topped_up_balance: "223.06" }] }));
		return;
	}
	response.writeHead(401, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message: "invalid key" } }));
});
await new Promise((resolve) => platform.listen(0, "127.0.0.1", resolve));
const platformUrl = `http://127.0.0.1:${String(platform.address().port)}`;

// A second stand-in with a different amount, so a moved endpoint is observable.
const moved = createServer((request, response) => {
	seen.push({ url: request.url, headers: request.headers });
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "300.00", granted_balance: "0.00", topped_up_balance: "300.00" }] }));
});
await new Promise((resolve) => moved.listen(0, "127.0.0.1", resolve));
const movedUrl = `http://127.0.0.1:${String(moved.address().port)}`;

// The host event bus is one shared listener table, so a listener registered by any
// composition sees an event emitted by any other.
const listeners = [];
const onHostEvent = (name, listener) => {
	const hook = { name, listener };
	listeners.push(hook);
	return () => {
		const index = listeners.indexOf(hook);
		if (index >= 0) listeners.splice(index, 1);
	};
};
const emitHostEvent = (name, ...args) => {
	for (const hook of [...listeners]) if (hook.name === name) hook.listener(...args);
};
// The plugin names the real platform endpoint and offers no way to point it
// elsewhere, so the check redirects that one origin to the local stand-in and
// passes every other address through untouched.
const upstream = "https://api.deepseek.com";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(
	typeof input === "string" && input.startsWith(upstream) ? platformUrl + input.slice(upstream.length) : input,
	init
);

let route;
/** Verdict Connection would return for the next request, or undefined to admit it. */
let rejection;
const webCtx = {
	webServer: {
		register(spec) {
			route = spec;
			return () => {};
		}
	},
	connection: {
		requestRejection() {
			return rejection;
		}
	},
	effect: (fn) => fn()
};

const contexts = {
	webServer: webCtx,
	credentials: {
		resolve: async (ref) => ref === "DEEPSEEK_API_KEY" ? { value: "api-key", source: "file" } : undefined
	},
	deepseekAccount: {
		resolveToken: async (url) => {
			assert.equal(url, "https://api.deepseek.com/");
			return "account-token";
		}
	}
};

/**
 * Build a composition whose optional services stand in for the LLM directory and
 * the settings service, which is how the endpoint resolution is exercised.
 * @param services - services this composition supplies in addition to the shared ones.
 */
function compositionContext(services = {}) {
	return {
		get: (name) => name === "webServer" || name === "connection" ? webCtx : services[name] ?? contexts[name],
		inject: (names, callback) => {
			if (names.includes("webServer") && names.includes("connection")) callback(webCtx);
		},
		on: onHostEvent,
		effect: (fn) => fn(),
		logger: { warn: () => {} }
	};
}

apply(compositionContext());

assert.equal(route.kind, "exact", "the route owns its path rather than sharing the /api prefix");
assert.equal(route.path, "/api/dsh-balance");

function request(body, headers = {}) {
	return {
		method: "POST",
		headers,
		async *[Symbol.asyncIterator]() {
			yield Buffer.from(JSON.stringify(body));
		}
	};
}

function response() {
	return {
		status: undefined,
		body: undefined,
		writeHead(status) {
			this.status = status;
		},
		end(payload) {
			this.body = JSON.parse(payload);
		}
	};
}

async function callOn(routeSpec, body, headers) {
	const res = response();
	await routeSpec.handler(request(body, headers), res);
	return res;
}

async function call(body, headers) {
	return callOn(route, body, headers);
}

const api = await call({ provider: "deepseek-official" });
assert.equal(api.status, 200);
assert.equal(api.body.kind, "ok");
assert.equal(api.body.source, "DeepSeek API Key");
assert.equal(api.body.isAvailable, true);
assert.equal(api.body.wallets[0].balance, "223.06");
assert.equal(api.body.cached, false, "the first read of a credential is fresh");
assert.equal(seen.at(-1).url, "/user/balance", "the redirected read reaches the balance path intact");
assert.equal(seen.at(-1).headers.authorization, "Bearer api-key");

const account = await call({ provider: "deepseek-account" });
assert.equal(account.body.kind, "ok");
assert.equal(account.body.source, "DeepSeek Account");
assert.equal(account.body.wallets[0].balance, "0.54");
assert.equal(seen.at(-1).headers["x-dsh-auth-token"], "account-token");
assert.equal(seen.at(-1).headers.authorization, undefined);

const unsupported = await call({ provider: "openai" });
assert.equal(unsupported.body.kind, "unsupported");
assert.equal(unsupported.body.provider, "openai");

// Connection owns the Host/Origin fence and browser authentication; the route
// only forwards its verdict, so no caller needs a credential of its own.
rejection = 401;
const unauthenticated = await call({ provider: "deepseek-official" });
assert.equal(unauthenticated.status, 401);
assert.equal(unauthenticated.body.kind, "unauthorized");
rejection = 403;
const untrustedCaller = await call({ provider: "deepseek-official" });
assert.equal(untrustedCaller.status, 403);
assert.equal(untrustedCaller.body.kind, "forbidden");
rejection = undefined;

const wrongMethod = response();
await route.handler({ method: "GET", headers: {} }, wrongMethod);
assert.equal(wrongMethod.status, 405);
assert.equal(wrongMethod.body.kind, "method-not-allowed");

const badBody = await call("not an object");
assert.equal(badBody.status, 400);

// The same credential is read once per cache window, so two sessions that
// select the same provider do not each spend a platform query.
const platformCallsAfterFirstReads = seen.length;
const repeated = await call({ provider: "deepseek-official" });
assert.equal(repeated.body.kind, "ok");
assert.equal(repeated.body.cached, true, "a repeated read of the same credential is served from the cache");
assert.equal(repeated.body.wallets[0].balance, "223.06");
assert.equal(seen.length, platformCallsAfterFirstReads, "the cached answer costs no further platform request");

// A forced read refreshes the entry, and its own result restarts the window.
const forced = await call({ provider: "deepseek-official", force: true });
assert.equal(forced.body.cached, false, "a forced read bypasses the cache");
assert.equal(seen.length, platformCallsAfterFirstReads + 1, "a forced read does reach the platform");

// A read that races the forced update is served from the entry it just wrote.
const afterForce = await call({ provider: "deepseek-official" });
assert.equal(afterForce.body.cached, true, "a forced read restarts the window for the same credential");

// Another credential is a different entry, not a hit on this one.
const accountAgain = await call({ provider: "deepseek-account" });
assert.equal(accountAgain.body.cached, true, "each credential is cached on its own");

// Every answer carries how long its entry stays usable, which is what the page
// schedules its next automatic read from.
assert.equal(typeof forced.body.expiresInMs, "number", "an answer carries the remaining lifetime of its entry");
assert.ok(forced.body.expiresInMs > 290000 && forced.body.expiresInMs <= 300000, "a forced answer reports almost the whole window");
assert.ok(afterForce.body.expiresInMs > 0 && afterForce.body.expiresInMs <= 300000, "a cached answer reports the remainder of its window");

// Requests that arrive together for one credential share a single platform call:
// several pages whose entry expires at the same moment cost one query, not one each.
const raced = [];
apply(compositionContext(), { cacheTtlMs: 0 });
raced.push(route);
const callsBeforeRace = seen.length;
const raceResponses = [response(), response(), response()];
await Promise.all(raceResponses.map((res) => raced[0].handler(request({ provider: "deepseek-official" }), res)));
assert.equal(seen.length, callsBeforeRace + 1, "three simultaneous reads of one credential cost one platform request");
for (const res of raceResponses) {
	assert.equal(res.body.kind, "ok");
	assert.equal(res.body.cached, false, "every waiter receives the shared platform answer");
	assert.equal(res.body.wallets[0].balance, "223.06");
	// A window below the floor is served as the floor, because the page schedules
	// whatever it is told and would otherwise re-ask at network speed.
	assert.ok(res.body.expiresInMs > 900 && res.body.expiresInMs <= 1000, "a zero-length window is raised to the one-second floor");
}

// A second composition without the credentials service resolves the same route
// to a missing-credential answer instead of attempting a request.
const withoutCredentials = [];
apply({
	get: (name) => name === "webServer" || name === "connection" ? webCtx : undefined,
	inject: (names, callback) => {
		if (names.includes("webServer") && names.includes("connection")) callback(webCtx);
	},
	on: onHostEvent,
	effect: (fn) => fn(),
	logger: { warn: () => {} }
});
withoutCredentials.push(route);
const missing = response();
await withoutCredentials[0].handler(request({ provider: "deepseek-official" }), missing);
assert.equal(missing.body.kind, "missing-credential");
assert.equal(missing.body.source, "DeepSeek API Key");

// A configured endpoint is followed instead of a constant carried here, and only
// its origin is used: the balance route sits at the platform root. The launch
// environment names a different endpoint, so configuration winning over it is part
// of the assertion.
const configurable = [
	{ provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [] },
	{ provider: "deepseek-account", settingsNs: "llm-deepseek-account", settingsPath: [] }
];
const authorized = [];
let endpoint = `${platformUrl}/anthropic`;
let describeCalls = 0;
const configured = [];
apply(compositionContext({
	llm: { listConfigurableProviders: () => configurable },
	settings: {
		describe: () => {
			describeCalls += 1;
			return [
				{ ns: "llm-deepseek", value: { baseURL: endpoint } },
				{ ns: "llm-deepseek-account", value: { baseURL: endpoint } }
			];
		}
	},
	launchEnvironment: { get: (name) => name === "DEEPSEEK_BASE_URL" ? { value: "http://127.0.0.1:9/ignored" } : undefined },
	deepseekAccount: { resolveToken: async (url) => { authorized.push(url); return "account-token"; } }
}));
configured.push(route);
const configuredRead = await callOn(configured[0], { provider: "deepseek-official" });
assert.equal(configuredRead.body.kind, "ok", "a configured endpoint is read");
assert.equal(configuredRead.body.wallets[0].balance, "223.06");
assert.equal(seen.at(-1).url, "/user/balance", "only the origin of the configured endpoint is used");
assert.equal(describeCalls, 1, "the first read of a provider resolves its endpoint");

// The endpoint is cached, so a later read of the same provider pays nothing for it.
const repeatedRead = await callOn(configured[0], { provider: "deepseek-official", force: true });
assert.equal(repeatedRead.body.kind, "ok");
assert.equal(describeCalls, 1, "a later read of the same provider reuses the cached endpoint");

// Each provider owns its origin, and the account token is granted for it.
const configuredAccount = await callOn(configured[0], { provider: "deepseek-account" });
assert.equal(configuredAccount.body.kind, "ok");
assert.equal(authorized.at(-1), `${platformUrl}/`, "the account token is granted for the origin the read reaches");
assert.equal(describeCalls, 2, "a second provider resolves its own endpoint");

// A configuration change drops the cache, and the read follows what it now names.
endpoint = `${movedUrl}/anthropic`;
emitHostEvent("settings/document-updated", "llm-deepseek", 1);
const movedRead = await callOn(configured[0], { provider: "deepseek-official", force: true });
assert.equal(movedRead.body.kind, "ok", "the read follows the endpoint the configuration now names");
assert.equal(movedRead.body.wallets[0].balance, "300.00");
assert.equal(describeCalls, 3, "a configuration change drops the cached endpoint");

// With no configuration at all, the launch environment supplies the endpoint.
const environmentEndpoint = `${platformUrl}/anthropic`;
const fromEnvironment = [];
apply(compositionContext({
	launchEnvironment: { get: (name) => name === "DEEPSEEK_BASE_URL" ? { value: environmentEndpoint } : undefined }
}));
fromEnvironment.push(route);
const environmentRead = await callOn(fromEnvironment[0], { provider: "deepseek-official" });
assert.equal(environmentRead.body.kind, "ok", "the launch environment supplies the endpoint when no configuration does");
assert.equal(environmentRead.body.wallets[0].balance, "223.06");
assert.equal(seen.at(-1).url, "/user/balance", "the environment endpoint is reduced to its origin");

await new Promise((resolve) => platform.close(resolve));
await new Promise((resolve) => moved.close(resolve));
console.log("balance host contract checks passed");
