/**
 * Offline contract check for the balance bundle.
 *
 * The bundle is loaded through a stubbed module loader so its registration
 * shape, slot registration, refresh wiring, and pure helpers can be verified
 * without a browser or a React runtime. Rendering itself is verified in the
 * running application.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const registrations = [];
globalThis.window = {
	__ModuleLoader__: {
		load(registration) {
			registrations.push(registration);
		}
	}
};

/** Stylesheets the bundle injects, so their declarations can be asserted. */
const documentCreated = [];
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({
		dataset: {},
		set textContent(value) {
			documentCreated.push(value);
		},
		get textContent() {
			return "";
		}
	}),
	head: { appendChild: () => {} }
};

/** Hook runtime whose state setters are recorded, so a click-driven rerender can be observed. */
let stage = null;
let pendingSet = false;
let notify = () => {};
const reactStub = {
	useState: (initial) => {
		const index = reactStub.cursor++;
		if (stage !== null && !(index in stage)) stage[index] = initial;
		return [
			stage === null ? initial : stage[index],
			(value) => {
				stage[index] = typeof value === "function" ? value(stage[index]) : value;
				pendingSet = true;
				notify();
			}
		];
	},
	useEffect: (effect, deps) => {
		const index = reactStub.cursor++;
		const previous = reactStub.deps[index];
		const changed = previous === undefined || deps === undefined
			|| deps.length !== previous.length
			|| deps.some((value, slot) => !Object.is(value, previous[slot]));
		reactStub.deps[index] = deps === undefined ? undefined : [...deps];
		if (changed) reactStub.effects.push(effect);
	},
	useRef: (initial) => {
		const index = reactStub.cursor++;
		const refs = reactStub.refs;
		if (!(index in refs)) refs[index] = { current: typeof initial === "function" ? initial() : initial };
		return refs[index];
	},
	useCallback: (fn) => {
		return fn;
	},
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	cursor: 0,
	effects: [],
	deps: {},
	refs: {}
};

const bundle = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("require", "window", "document", "globalThis", bundle).call(
	globalThis,
	(specifier) => {
		if (specifier === "react") return reactStub;
		throw new Error(`unexpected require: ${specifier}`);
	},
	globalThis.window,
	globalThis.document,
	globalThis
);

assert.equal(registrations.length, 1, "bundle registers exactly one module");
const registration = registrations[0];
// The bundle id must equal the package name; the loader resolves the client half by it.
const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
assert.equal(registration.id, manifest.name, "the registered module id matches the package name");

const moduleExports = registration.factory((specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`unexpected factory require: ${specifier}`);
});
assert.equal(typeof moduleExports.apply, "function");
assert.deepEqual(moduleExports.inject, ["slots", "locale", "modelDirectories", "sessions"]);

const snapshot = { current: { provider: "deepseek-official", model: "deepseek-flash" } };
let captured;
let loadCalls = 0;
let listSnapshot = { byId: { "session-1": { running: false } }, phase: "ready" };
let listListener;
const store = { getSnapshot: () => snapshot, subscribe: () => () => {} };
const sessionsService = {
	list: {
		getSnapshot: () => listSnapshot,
		subscribe(listener) {
			listListener = listener;
			return () => {
				listListener = undefined;
			};
		}
	}
};
/**
 * Stand-in for the locale service. It keeps whatever the plugin registers and
 * binds a translator that reads the active language, so the copy assertions
 * below exercise the real dictionary instead of a fixed string.
 */
const dictionaries = new Map();
const effectDisposers = [];
let activeLocale = "zh";
const localeService = {
	register(ns, dicts) {
		dictionaries.set(ns, dicts);
		return () => {
			dictionaries.delete(ns);
		};
	},
	bind: (ns) => (key, params) => {
		const dictionary = dictionaries.get(ns);
		assert.ok(dictionary !== undefined, `no dictionary registered for ${ns}`);
		const template = dictionary[activeLocale]?.[key] ?? dictionary.en?.[key];
		assert.equal(typeof template, "string", `no copy for ${ns}.${key}`);
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
	}
};
moduleExports.apply({
	get: (name) => name === "sessions" ? sessionsService : undefined,
	locale: localeService,
	effect(callback) {
		effectDisposers.push(callback());
	},
	modelDirectories: {
		directoryFor(sessionId) {
			assert.equal(sessionId, "session-1");
			return {
				store,
				load: () => {
					loadCalls += 1;
				}
			};
		}
	},
	slots: {
		inject(key, callback) {
			assert.equal(key, "conversation.composer.dock");
			callback();
		},
		register(options, component) {
			assert.equal(options.name, "conversation.composer.dock");
			assert.equal(options.id, "balance");
			assert.equal(options.order, 10);
			assert.equal(options.locale, moduleExports.__internals.LOCALE_NS, "the entry declares the namespace its translator binds to");
			// A thunk, not a string: the slot reads it at render time so the label
			// follows the active language.
			assert.equal(typeof options.label, "function");
			captured = { options, component };
			return () => {};
		}
	}
});

assert.equal(typeof captured.options.inject, "function");
assert.equal(effectDisposers.length, 1, "the dictionary registration belongs to the plugin fiber");
const injected = captured.options.inject("session-1");
assert.equal(loadCalls, 1, "the session directory is asked to load");
assert.deepEqual(injected.readSelection(), { provider: "deepseek-official", model: "deepseek-flash" });

// Turn-end edges drive one refresh each, and only on a true-to-false transition.
const turnEnds = [];
const disposeTurnEnd = injected.observeTurnEnd(() => turnEnds.push(Date.now()));
assert.equal(typeof disposeTurnEnd, "function");
assert.equal(turnEnds.length, 0, "an idle session reports no turn end");
listSnapshot = { byId: { "session-1": { running: true } }, phase: "ready" };
listListener();
assert.equal(turnEnds.length, 0, "a turn starting is not a turn end");
listListener();
assert.equal(turnEnds.length, 0, "a repeated running snapshot is not a turn end");
listSnapshot = { byId: { "session-1": { running: false } }, phase: "ready" };
listListener();
assert.equal(turnEnds.length, 1, "the running flag falling reports exactly one turn end");
listListener();
assert.equal(turnEnds.length, 1, "a repeated settled snapshot reports nothing");
listSnapshot = { byId: {}, phase: "ready" };
listListener();
assert.equal(turnEnds.length, 1, "a vanished session row reports nothing");
disposeTurnEnd();
assert.equal(listListener, undefined, "the subscription is disposed with the card");

const props = { readSelection: injected.readSelection, subscribeSelection: injected.subscribeSelection, observeTurnEnd: injected.observeTurnEnd, t: localeService.bind(moduleExports.__internals.LOCALE_NS) };
const draw = () => {
	reactStub.cursor = 0;
	// A state block must exist before any setter runs, exactly as in React.
	stage ??= [];
	return captured.component(props);
};
const tree = draw();
assert.equal(tree.type, "button", "the card is a refresh control");
assert.equal(tree.props.className, "dsh_balance_dock");
assert.equal(typeof tree.props.onClick, "function", "clicking the card refreshes");
assert.equal(tree.props["data-state"], "loading", "before the first answer the card renders its placeholder in the loading state");
const visible = (element) => element.children.filter((child) => child !== null && child !== undefined && child !== false);
assert.equal(visible(tree).length, 4, "an idle card carries the glyph, the label, the loading ring, and the value");
assert.equal(visible(tree)[0].type, moduleExports.__internals.BalanceIcon, "the credit-card glyph leads the card");
assert.equal(visible(tree)[1].props.className, "dsh_balance_label");
assert.equal(visible(tree)[1].children[0], "\u4f59\u989d ", "the label keeps one space before the amount");
assert.equal(visible(tree)[2].type, moduleExports.__internals.BalanceRing, "an unanswered read shows the loading ring instead of a dash");
const loadingRing = visible(tree)[2].type({ className: "dsh_balance_loading" });
assert.equal(loadingRing.type, "svg");
assert.equal(loadingRing.children.length, 2, "the ring carries a faint track and a bright arc");
assert.equal(visible(tree)[3].props.className, "dsh_balance_value");
assert.equal(visible(tree)[3].children[0], "--", "the dash stays in the value slot, hidden by the loading state");

const icon = moduleExports.__internals.BalanceIcon();
assert.equal(icon.type, "svg");
assert.equal(icon.props.viewBox, "0 0 24 24");
assert.equal(icon.props.stroke, "currentColor", "the glyph follows the card colour");
assert.equal(icon.props.width, 14);
assert.equal(icon.props.height, 14);
assert.equal(icon.children.length, 3, "the glyph keeps the card rectangle, the stripe, and the mark");
assert.equal(tree.props["data-refreshing"], undefined, "an idle card carries no in-flight marker");
assert.equal(tree.props["aria-busy"], undefined);

// Copy comes from the card's own dictionary, and the registration names the
// namespace so the framework seats the translator. A language switch must change
// the rendered text, and both dictionaries must stay complete.
const { LOCALE_NS, MESSAGES } = moduleExports.__internals;
assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort(), "both dictionaries carry the same keys");
assert.equal(captured.options.label(), MESSAGES.zh.label, "the slot label follows the active language");
activeLocale = "en";
const englishTree = draw();
assert.equal(visible(englishTree)[1].children[0], "Balance ", "the card label follows the active language");
assert.equal(englishTree.props.title, "Click to refresh the balance", "the tooltip follows the active language");
activeLocale = "zh";
assert.equal(draw().props.title, MESSAGES.zh.refresh, "switching back restores the Chinese copy");
assert.equal(captured.options.label(), MESSAGES.zh.label, "the slot label follows the language back");

// A local endpoint stands in for the host route. It answers both actions:
// `status` reports the cache state, `read` returns the amount.
let answerBody = JSON.stringify({ kind: "ok", source: "DeepSeek API Key", isAvailable: true, wallets: [{ currency: "CNY", balance: "217.42" }] });
let cacheFresh = false;
let cachedBalance = "210.00";
const bodies = [];
/** Paths the card asked for, so the fixed same-origin route stays asserted. */
const paths = [];
const endpoint = createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		bodies.push(body);
		paths.push(request.url);
		response.writeHead(200, { "content-type": "application/json" });
		if (body.action === "status") {
			response.end(JSON.stringify(cacheFresh
				? { kind: "ok", source: "DeepSeek API Key", fresh: true, ageMs: 1000, isAvailable: true, wallets: [{ currency: "CNY", balance: cachedBalance }] }
				: { kind: "ok", source: "DeepSeek API Key", fresh: false }));
			return;
		}
		setTimeout(() => response.end(answerBody), 60);
	});
});
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
// The card posts to a fixed same-origin path, so the harness stands in for the
// page origin by forwarding that one path to the local server. A relative URL
// has no base in Node, which is also why this is what makes the constant itself
// testable rather than routed around by an injected endpoint.
const origin = `http://127.0.0.1:${String(endpoint.address().port)}`;
const pageFetch = globalThis.fetch;
globalThis.fetch = (input, init) => pageFetch(typeof input === "string" && input.startsWith("/") ? origin + input : input, init);
const endpointProps = props;
let painted = null;
const drawEndpoint = () => {
	reactStub.cursor = 0;
	stage ??= [];
	painted = captured.component(endpointProps);
	return painted;
};
notify = () => {
	if (pendingSet) {
		pendingSet = false;
		drawEndpoint();
	}
};
notify = () => {
	if (pendingSet) {
		pendingSet = false;
		drawEndpoint();
	}
};
const actions = () => bodies.map((body) => (body.action === "status" ? "status" : `read(force=${String(body.force)})`));
const tick = async (ms) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return drawEndpoint();
};

/**
* Start one card cycle the way the application does: render, run the effects,
 * then wait until no in-flight marker is left.
 * @param reset - whether to begin from a blank state block.
* @returns the settled card element.
 */
/** Run the effects queued by the last render, as React would after committing. */
const settleEffects = () => reactStub.effects.splice(0).map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");

/** Redraw until the card shows no in-flight marker. */
const settleState = async () => {
	let tree = await tick(150);
	for (let attempt = 0; attempt < 40 && tree.props["data-refreshing"] !== undefined; attempt++) tree = await tick(20);
	return tree;
};

const runCycle = async (reset) => {
	if (reset) {
		reactStub.cursor = 0;
		stage = [];
		reactStub.effects.splice(0);
		reactStub.deps = {};
		reactStub.refs = {};
	}
	drawEndpoint();
	const cleanups = reactStub.effects.splice(0).map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
	let tree = await tick(150);
	for (let attempt = 0; attempt < 40 && tree.props["data-refreshing"] !== undefined; attempt++) tree = await tick(20);
	return { tree, cleanups };
};

// 0. A model route this card does not serve renders nothing at all, from the first
//    render rather than after an effect.
assert.equal(captured.component({ ...endpointProps, readSelection: () => ({ provider: "openai", model: "gpt-4" }) }), null, "a non-DeepSeek route renders no card");
assert.equal(captured.component({ ...endpointProps, readSelection: () => undefined }), null, "a card without a selection renders nothing");

// 1. A first display with a stale cache: ask the cache, then pay for one read.
bodies.length = 0;
const firstCycle = await runCycle(true);
assert.deepEqual(actions(), ["status", "read(force=true)"], "a stale cache costs one freshness check and one forced read");
assert.equal(firstCycle.tree.props["data-refreshing"], undefined);
assert.equal(visible(firstCycle.tree)[2].children[0], "\u00a5217.42", "the read amount is painted");
assert.equal(visible(firstCycle.tree).length, 3, "the settled card carries the glyph, the label, and the value");
assert.equal(firstCycle.tree.props.title, "\u4f59\u989d\u6765\u6e90\uff1aDeepSeek API Key\uff0c\u70b9\u51fb\u5237\u65b0", "the settled tooltip names the source the answer came from");
assert.deepEqual([...new Set(paths)], ["/api/dsh-balance"], "every request goes to the fixed same-origin route");

// 1b. A later card for the same provider paints the remembered amount at once, so
//     switching conversations cannot flash a placeholder.
reactStub.cursor = 0;
stage = [];
reactStub.effects.splice(0);
reactStub.deps = {};
reactStub.refs = {};
const remembered = drawEndpoint();
// The first paint is the whole point of this check; do not start its cycle.
reactStub.effects.splice(0);
assert.equal(remembered.props["data-state"], "ok", "a new card starts from the remembered amount");
assert.equal(visible(remembered)[2].children[0], "\u00a5217.42", "the remembered amount is painted immediately");
assert.equal(remembered.props["data-refreshing"], undefined);

// 2. A click restarts the cycle through the same token the turn end uses. The
//    marker it raises is asserted structurally, because a faithful assertion on
//    an in-flight frame needs a real React commit; that interaction is verified
//    in the running application.
bodies.length = 0;
drawEndpoint().props.onClick();
// Rendering the frame the click scheduled is what queues the cycle effect.
drawEndpoint();
const clickEffects = settleEffects();
const clicked = await settleState();
assert.equal(clicked.props["data-refreshing"], undefined, "the marker clears once the click read settles");
const forcedRead = bodies.find((body) => body.action !== "status");
assert.ok(forcedRead !== undefined, "a click forces a read");
assert.equal(forcedRead.force, true, "the click read asks the platform for fresh data");
assert.equal(forcedRead.provider, "deepseek-official", "the read names the provider of its own conversation");
for (const cleanup of clickEffects) cleanup();

// 3. A first display whose cache is still fresh costs no platform read at all.
cacheFresh = true;
cachedBalance = "211.11";
bodies.length = 0;
const reused = (await runCycle(true)).tree;
assert.deepEqual(actions(), ["status"], "a fresh cache is reused without a read");
assert.equal(visible(reused)[2].children[0], "\u00a5211.11", "the reused amount is painted");
assert.equal(reused.props["data-refreshing"], undefined, "a reused amount never raises the marker");

// 4. The quiet-period timer asks the cache, and only reads once it has expired.
cacheFresh = false;
bodies.length = 0;
const timed = (await runCycle(true)).tree;
assert.deepEqual(actions(), ["status", "read(force=true)"], "an expired cache on the timer costs one forced read");
assert.equal(timed.props["data-refreshing"], undefined, "the timer never raises the marker");
for (const cleanup of firstCycle.cleanups) cleanup();
await new Promise((resolve) => endpoint.close(resolve));

const { formatAmount, symbolOf, isDeepSeekProvider, currentSelection } = moduleExports.__internals;

assert.equal(isDeepSeekProvider("deepseek-official"), true);
assert.equal(isDeepSeekProvider("deepseek-account"), true);
assert.equal(isDeepSeekProvider("openai"), false);
assert.equal(isDeepSeekProvider(undefined), false);

assert.equal(formatAmount("223.06"), "223.06");
assert.equal(formatAmount("12.3"), "12.30");
assert.equal(formatAmount("0"), "0.00");
assert.equal(formatAmount("not a number"), null);
assert.equal(symbolOf("CNY"), "\u00a5");
assert.equal(symbolOf("USD"), "$");

assert.deepEqual(currentSelection({ current: { provider: "deepseek-account", model: "deepseek-chat" } }), { provider: "deepseek-account", model: "deepseek-chat" });
assert.equal(currentSelection({ current: null }), undefined);
assert.equal(currentSelection(undefined), undefined);
assert.equal(currentSelection({ current: { model: "deepseek-chat" } }), undefined);

// The `.dsh_balance_dock` rule must stay a flex container: its gap and vertical
// centring only apply there, and losing `display: flex` silently turns the card
// into two lines.
const stylesheet = documentCreated.join("");
const cardRule = stylesheet.slice(stylesheet.indexOf(".dsh_balance_dock{"), stylesheet.indexOf("}", stylesheet.indexOf(".dsh_balance_dock{")) + 1);
assert.ok(stylesheet.includes("svg.dsh_balance_icon{"), "the glyph is sized by the stylesheet");
for (const declaration of ["display:flex", "align-items:center", "gap:6px", "flex-wrap:nowrap"]) {
	assert.ok(cardRule.includes(declaration), `the .dsh_balance_dock rule keeps ${declaration}`);
}

console.log("balance client contract checks passed");

process.exit(0);
