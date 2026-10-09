/**
 * Offline contract check for the host half.
 *
 * A throwaway HTTP server stands in for the DeepSeek platform, so the whole
 * privileged path is exercised: provider gating, credential resolution, the
 * balance request, and the response shaping the row consumes.
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
const baseUrl = `http://127.0.0.1:${String(platform.address().port)}`;

let route;
let injected;
const webCtx = {
	webServer: {
		register(spec) {
			route = spec;
			return () => {};
		}
	},
	effect: (fn) => fn(),
	on: (name, listener) => {
		assert.equal(name, "webserver/index-inject");
		const table = [];
		listener(table);
		injected = table[0];
	},
	off: () => {}
};

const contexts = {
	webServer: webCtx,
	credentials: {
		resolve: async (ref) => ref === "DEEPSEEK_API_KEY" ? { value: "api-key", source: "file" } : undefined
	},
	deepseekAccount: {
		resolveToken: async (url) => {
			assert.equal(url, `${baseUrl}/`);
			return "account-token";
		}
	}
};

apply({
	get: (name) => contexts[name],
	inject: (names, callback) => {
		if (names.includes("webServer")) callback(webCtx);
	},
	logger: { warn: () => {} }
}, { baseUrl });

assert.equal(route.path, "/api/dsh-balance");
assert.equal(injected.name, "__DSH_BALANCE__");
assert.equal(injected.value.endpoint, "/api/dsh-balance");
assert.equal(typeof injected.value.token, "string");
const token = injected.value.token;

function request(body, headers = {}) {
	return {
		method: "POST",
		headers: { "x-dsh-balance-token": token, ...headers },
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

async function call(body, headers) {
	const res = response();
	await route.handler(request(body, headers), res);
	return res;
}

const api = await call({ provider: "deepseek-official" });
assert.equal(api.status, 200);
assert.equal(api.body.kind, "ok");
assert.equal(api.body.source, "DeepSeek API Key");
assert.equal(api.body.isAvailable, true);
assert.equal(api.body.wallets[0].balance, "223.06");
assert.equal(api.body.cached, false, "the first read of a credential is fresh");
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

const forbidden = await call({ provider: "deepseek-official" }, { "x-dsh-balance-token": "wrong" });
assert.equal(forbidden.status, 403);
assert.equal(forbidden.body.kind, "forbidden");

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

// The status answer hands back whatever the entry holds, in the read shape.
const status = await call({ provider: "deepseek-official", action: "status" });
assert.equal(status.body.fresh, true, "the entry is fresh right after a read");
assert.equal(typeof status.body.ageMs, "number");
assert.equal(status.body.wallets[0].balance, forced.body.wallets[0].balance, "the status answer carries the cached payload");
assert.equal(seen.length, platformCallsAfterFirstReads + 1, "a status query never reaches the platform");

// A second composition without the credentials service
// A second composition without the credentials service resolves the same route
// to a missing-credential answer instead of attempting a request.
const withoutCredentials = [];
apply({
	get: (name) => name === "webServer" ? webCtx : undefined,
	inject: (names, callback) => {
		if (names.includes("webServer")) callback(webCtx);
	},
	logger: { warn: () => {} }
}, { baseUrl });
withoutCredentials.push(route);
assert.notEqual(injected.value.token, token, "each composition mints its own access token");
const missing = response();
await withoutCredentials[0].handler(request({ provider: "deepseek-official" }, { "x-dsh-balance-token": injected.value.token }), missing);
assert.equal(missing.body.kind, "missing-credential");
assert.equal(missing.body.source, "DeepSeek API Key");

await new Promise((resolve) => platform.close(resolve));
console.log("balance host contract checks passed");
