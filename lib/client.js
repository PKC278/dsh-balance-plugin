/* eslint-disable */
/**
* Client half of the DeepSeek balance card.
 *
* The card occupies the composer dock below the input box, in the same muted
 * strip as the session statistics. It resolves the model selection of the
 * current session, requests that provider's balance through the plugin's own
 * host route, and renders nothing while the selected provider is not a DeepSeek
* route, so the card never appears for other vendors' models.
 *
 * Requests are triggered on four occasions, and the page's only cache decision is
 * whether a request may reuse the host's entry. A click on the card and the end
 * of an agent turn — the moment the session's running flag falls, which is when
 * that turn's spending has settled — force a platform read, because both follow
 * spending the cached amount cannot know about. The first display of a session
 * and every later expiry ask plainly, letting the host answer from an entry
 * another page has just paid for. When that next automatic request happens comes
 * from the remaining lifetime the host reports with each answer, so the cadence
 * follows the host's cache instead of a second constant here.
 *
 * Every string this module renders comes from its own locale dictionary, which
 * the slot declares as its namespace so the framework seats the translator and
* re-renders the card when the interface language changes.
 */
window.__ModuleLoader__.load({
	// Must stay identical to the package name: the loader resolves the client half
	// by the entry's package name.
	id: "@pkc278/dsh-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		//#region Package-local styles
		/**
		* Fallback window, used only when a host answer carries no usable lifetime; the
		* host reports the real one with every answer.
		*/
		const DEFAULT_CACHE_TTL_MS = 300000;
		/** Delay before retrying after a failed read, so a transient outage recovers on its own. */
		const RETRY_INTERVAL_MS = 15000;
		/** Click cooldown; the spinning marker already rules out most double clicks. */
		const MIN_CLICK_INTERVAL_MS = 1000;
		/** How long the refresh marker stays up at minimum, so an instant answer is still visible. */
		const FEEDBACK_FLOOR_MS = 300;
		/** Provider routes whose balances the host route can report. */
		const DEEPSEEK_PROVIDERS = ["deepseek-official", "deepseek-account"];
		/**
		* Host route the card posts to. A fixed path on the page's own origin, so the
		* card needs nothing injected at page load: Connection authenticates the
		* request with the session cookie the page already holds.
		*/
		const ENDPOINT = "/api/dsh-balance";
		/**
		* Locale namespace this plugin owns. The slot registration names it, which is
		* what makes the framework hand the card a translator bound to this dictionary
		* instead of leaving the copy in one language.
		*/
		const LOCALE_NS = "@pkc278/dsh-balance";
		/**
		* Card copy for the two interface locales DSH ships. The label keeps a trailing
		* space: the card's flex `gap` separates the elements, so the space is what
		* holds the amount off the word rather than letting the two run together.
		*/
		const MESSAGES = {
			zh: {
				label: "余额 ",
				refreshing: "正在刷新余额",
				refresh: "点击刷新余额",
				source: "余额来源：{source}，点击刷新"
			},
			en: {
				label: "Balance ",
				refreshing: "Refreshing balance",
				refresh: "Click to refresh the balance",
				source: "Balance from {source}, click to refresh"
			}
		};
		/**
		* Last successfully requested wallets per provider, for this page's lifetime.
		* Switching conversations mounts a fresh card, and painting the remembered
		* amount keeps that transition from showing a placeholder.
		*/
		const lastWallets = new Map();

		const css = [
			// `gap` matches the statistics pills beside the card.
			".dsh_balance_dock{box-sizing:border-box;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow:hidden;padding:1px 8px;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px));font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dsh_balance_label,.dsh_balance_value{color:inherit}",
			// The dimmed failure dash is mixed from the card's own colour instead of using
			// the theme's `label-dimmed`: that token is nearly the page background on
			// white, so the dash either vanished or, after antialiasing, read as ordinary
			// grey. A mix keeps the step down visible in both themes.
			".dsh_balance_dock[data-state=error] .dsh_balance_value{color:color-mix(in srgb, currentColor 55%, transparent)}",
			// While a request is pending, the value slot holds the ring instead of a
			// dash, so an unfinished request never resembles a failed one.
			".dsh_balance_dock[data-state=loading] .dsh_balance_value{display:none}",
			".dsh_balance_loading{flex:none;display:block;width:13px;height:13px;color:var(--dsw-alias-label-tertiary)}",
			// The card doubles as the refresh control: pointer affordance only, no chrome of its own.
			"button.dsh_balance_dock{corner-shape:round;background:0 0;border:0;border-radius:999px;cursor:pointer;text-align:inherit}",
			"button.dsh_balance_dock:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			"button.dsh_balance_dock:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
			// In-flight marker: the ring spins until the request settles, so a click always shows a result.
			"@keyframes dsh-balance-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
			"svg.dsh_balance_icon{flex:none;width:14px;height:14px;display:block;color:inherit}",
			"svg.dsh_balance_spinner{flex:none;width:13px;height:13px;display:block;animation:dsh-balance-spin .7s linear infinite}",
			// The card keeps the flex default while anything registered after it is pushed to
			// `order: 1`, so a later dock entry cannot displace it. The context meter is a
			// sibling of the slot outlet rather than of the card, so it is not selected here
			// and already renders last.
			".dsh_balance_dock~*,.dsh_balance_dock~:has(*){order:1}"
		].join("");
		const CSS_TAG = "@pkc278/dsh-balance/BalanceDock.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@pkc278/dsh-balance";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region Balance requests
		/** Currency symbol of one wallet. */
		function symbolOf(currency) {
			return currency === "USD" ? "$" : "\u00a5";
		}

		/** Fixed two-decimal rendering; the platform reports exact decimal strings. */
		function formatAmount(amount) {
			const value = Number(amount);
			if (!Number.isFinite(value)) return null;
			return value.toFixed(2);
		}

		/** Whether one provider route is a DeepSeek route this card may query. */
		function isDeepSeekProvider(provider) {
			return typeof provider === "string" && DEEPSEEK_PROVIDERS.includes(provider);
		}

		/** The provider/model pair the composer currently shows for one session. */
		function currentSelection(snapshot) {
			if (snapshot === null || snapshot === undefined) return undefined;
			const current = snapshot.current;
			if (current === null || current === undefined || typeof current.provider !== "string") return undefined;
			return { provider: current.provider, model: typeof current.model === "string" ? current.model : "" };
		}

		/**
		* Talk to the plugin's host route.
		*
		* The host owns the cache, so a request only states whether it may reuse an
		* entry; the answer carries how long that entry stays usable, which is what
		* the next automatic read is scheduled from.
		* @param body - request payload, always carrying the provider route.
		* @returns the host answer, or a local failure description.
		*/
		async function sendRequest(body) {
			try {
				const response = await fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				if (!response.ok) return { kind: "unavailable" };
				return await response.json();
			} catch (error) {
				return { kind: error !== null && error !== undefined && error.name === "AbortError" ? "aborted" : "unavailable" };
			}
		}

		/**
		* Request one provider's balance.
		* @param provider - selected LLM provider route.
		* @param force - require a platform read instead of letting the host answer from
		* its cache; only a click and the end of a turn ask for that.
		* @returns the host answer, or a local failure description.
		*/
		async function requestBalance(provider, force) {
			return sendRequest({ provider, force });
		}

		/**
		* Delay until an answer's entry expires, from the lifetime the host reported
		* with it. The host floors the cache window, so the page schedules the number
		* as it stands and only a missing or unusable value falls back to the default.
		* Scheduling from the entry's own expiry keeps the cadence right after a
		* cacheTtlMs override, and reusing a partly spent entry no longer postpones
		* the next read by a whole window.
		* @param answer - a successful host answer.
		* @returns milliseconds to wait before the next automatic read.
		*/
		function waitForExpiry(answer) {
			return Number.isFinite(answer.expiresInMs) ? answer.expiresInMs : DEFAULT_CACHE_TTL_MS;
		}

		/**
		* Ring used for both unfinished states: the loading placeholder in the value
		* slot, and the in-flight marker after a click. A stroked arc renders as a
		* ring at any size, unlike a bordered box.
		* @param props - className selecting the size and placement.
		*/
		function BalanceRing(props) {
			return react.createElement(
				"svg",
				{
					className: props.className,
					viewBox: "0 0 16 16",
					fill: "none",
					width: 13,
					height: 13,
					style: { flex: "none", display: "block" },
					"aria-hidden": "true"
				},
				react.createElement("circle", { cx: 8, cy: 8, r: 6, stroke: "currentColor", strokeOpacity: 0.25 }),
				react.createElement("path", { d: "M8 2a6 6 0 0 1 6 6", stroke: "currentColor", strokeLinecap: "round" })
			);
		}

		/**
		* Credit-card glyph at the head of the balance card, the Lucide credit-card
		* outline. It is stroked with `currentColor`, so it follows the card's tertiary
		* text colour in either theme.
		*/
		function BalanceIcon() {
			return react.createElement(
				"svg",
				{
					xmlns: "http://www.w3.org/2000/svg",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					className: "dsh_balance_icon",
					width: 14,
					height: 14,
					style: { flex: "none", display: "block" },
					"aria-hidden": "true"
				},
				react.createElement("rect", { width: 20, height: 14, x: 2, y: 5, rx: 2 }),
				react.createElement("line", { x1: 2, x2: 22, y1: 10, y2: 10 }),
				react.createElement("path", { d: "M6 14h2" })
			);
		}

		/**
		* Watch one session's running flag and report each turn-end edge, which is
		* when that turn's spending has settled.
		* @param snapshots - the session list snapshot source.
		* @param sessionId - session whose turns are observed.
		* @param onTurnEnd - called once per true-to-false transition.
		* @returns disposer of the subscription.
		*/
		function observeTurnEnd(snapshots, sessionId, onTurnEnd) {
			let wasRunning = false;
			const read = () => {
				const snapshot = snapshots.getSnapshot();
				const row = snapshot === null || snapshot === undefined || snapshot.byId === undefined ? undefined : snapshot.byId[sessionId];
				const running = row === undefined ? false : row.running === true;
				if (wasRunning && !running) onTurnEnd();
				wasRunning = running;
			};
			read();
			return snapshots.subscribe(read);
		}
		//#endregion

		//#region Balance card
		/**
		* Ambient balance card for the composer dock. It renders nothing while the
		* selected provider is not a DeepSeek route, so a non-DeepSeek model leaves
		* the dock exactly as DSH ships it.
		*/
		function BalanceDock(props) {
			const selection = props.selection;
			const t = props.t;
			const provider = selection === undefined ? undefined : selection.provider;
			const [state, setState] = react.useState({ status: "loading" });
			// A new card for the same provider starts from the amount last requested on
			// this page, so switching conversations cannot show a placeholder. The flag
			// keeps a later state write from replacing it with an empty one.
			const rememberedRef = react.useRef(false);
			if (rememberedRef.current === false) {
				const remembered = isDeepSeekProvider(provider) ? lastWallets.get(provider) : undefined;
				if (remembered !== undefined) {
					state.status = "ok";
					state.wallets = remembered;
					state.isAvailable = true;
					rememberedRef.current = true;
				}
			}
			const [refreshing, setRefreshing] = react.useState(false);
			const [refreshToken, setRefreshToken] = react.useState(0);
			/**
			* Read once and report how long the answer stays usable. A failed read keeps the
			* previous amount on screen and asks for the shorter retry cadence.
			* @param force - whether the host must bypass its cache.
			* @returns milliseconds until the next automatic read, or undefined to stop.
			*/
			const load = react.useCallback(async (force) => {
				if (!isDeepSeekProvider(provider)) return undefined;
				const result = await requestBalance(provider, force);
				if (result !== null && result !== undefined && result.kind === "ok") {
					const wallets = Array.isArray(result.wallets) ? result.wallets : [];
					if (result.isAvailable === true && wallets.length > 0) lastWallets.set(provider, wallets);
					setState({ status: "ok", wallets, source: result.source, isAvailable: result.isAvailable === true });
					return waitForExpiry(result);
				}
				setState((previous) => ({ status: "error", wallets: previous.wallets, source: previous.source, isAvailable: previous.isAvailable }));
				// A credential the host cannot resolve is not made to appear by asking
				// again, so only a failed read earns the shorter cadence.
				return result !== null && result !== undefined && result.kind === "missing-credential" ? DEFAULT_CACHE_TTL_MS : RETRY_INTERVAL_MS;
			}, [provider]);

			// Reading through a ref keeps the cycle identity clean: it must restart on a
			// real trigger (a click or a finished turn) and on nothing else, so a
			// re-render can never silently start a second read.
			const loadRef = react.useRef(null);
			loadRef.current = load;

			/**
			* Click refresh, rate limited so a double click cannot queue a request. The
			* click restarts the cycle like every other trigger, and marks the read as
			* forced so the host bypasses its cache and the marker shows.
			*/
			const lastClick = react.useRef(0);
			const manualRef = react.useRef(false);
			const onClick = react.useCallback(() => {
				const now = Date.now();
				if (now - lastClick.current < MIN_CLICK_INTERVAL_MS) return;
				lastClick.current = now;
				manualRef.current = true;
				setRefreshToken((value) => value + 1);
			}, []);

			/**
			* The end of a turn is the moment that turn's spending has settled, so it asks
			* for a forced read; a turn boundary is not a cache expiry.
			*/
			const turnEndRef = react.useRef(undefined);
			turnEndRef.current = props.observeTurnEnd;
			react.useEffect(() => {
				const subscribe = turnEndRef.current;
				if (subscribe === undefined) return undefined;
				return subscribe(() => {
					manualRef.current = true;
					setRefreshToken((value) => value + 1);
				});
			}, []);

			// The automatic path covers the first display and every expiry that follows
			// it. A plain read lets the host answer from an entry another page has just
			// paid for, so an expiry is never paid for twice.
			react.useEffect(() => {
				if (!isDeepSeekProvider(provider)) {
					setState({ status: "hidden" });
					return undefined;
				}
				// The trigger kind is fixed when the cycle starts; consulting it again after
				// an await could pick up a later render and silence a wanted read.
				const force = manualRef.current === true;
				manualRef.current = false;
				let stopped = false;
				let timer;
				const cycle = async (wanted) => {
					if (wanted) setRefreshing(true);
					const startedAt = Date.now();
					let wait = DEFAULT_CACHE_TTL_MS;
					try {
						const next = await loadRef.current(wanted);
						if (next !== undefined) wait = next;
					} finally {
						if (wanted) {
							// Never leave the marker spinning: an instant answer still shows it for a moment.
							const remaining = FEEDBACK_FLOOR_MS - (Date.now() - startedAt);
							if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
							setRefreshing(false);
						}
					}
					if (stopped) return;
					timer = setTimeout(() => void cycle(false), wait);
				};
				void cycle(force);
				return () => {
					stopped = true;
					if (timer !== undefined) clearTimeout(timer);
				};
			}, [refreshToken, provider]);

			// A route this card does not serve renders nothing at all, including on the
			// first paint before any effect could have marked it hidden.
			if (!isDeepSeekProvider(provider) || state.status === "hidden") return null;
			const wallet = state.wallets === undefined ? undefined : state.wallets[0];
			const amount = state.status === "ok" && state.isAvailable && wallet !== undefined ? formatAmount(wallet.balance) : null;
			const valueText = amount === null ? "--" : `${symbolOf(wallet.currency)}${amount}`;
			// The placeholder ring stands in for the amount; the click marker sits after it.
			const loading = amount === null && state.status === "loading";
			const showRightRing = refreshing === true;
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dsh_balance_dock",
					"data-state": amount !== null ? "ok" : state.status === "loading" ? "loading" : "error",
					"data-refreshing": refreshing ? "true" : undefined,
					"aria-busy": refreshing ? "true" : undefined,
					style: refreshing ? { cursor: "progress" } : undefined,
					title: refreshing ? t("refreshing") : state.source === undefined ? t("refresh") : t("source", { source: state.source }),
					onClick
				},
				react.createElement(BalanceIcon, null),
				react.createElement("span", { className: "dsh_balance_label" }, t("label")),
				loading ? react.createElement(BalanceRing, { className: "dsh_balance_loading" }) : null,
				react.createElement("span", { className: "dsh_balance_value" }, valueText),
				showRightRing ? react.createElement(BalanceRing, { className: "dsh_balance_spinner" }) : null
			);
		}
		//#endregion

		//#region Plugin
		/** Seed words and app entries this bundle requires. */
		const inject = ["slots", "locale", "modelDirectories", "sessions"];

		/**
		* Publish the card's dictionary, then register the balance card into the
		* composer dock.
		* @param ctx - Client plugin context.
		*/
		function apply(ctx) {
			const models = ctx.modelDirectories;
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(() => ctx.locale.register(LOCALE_NS, MESSAGES), "dsh-balance: card copy");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "balance",
				order: 10,
				locale: LOCALE_NS,
				// Read at render time, so the label follows a language switch.
				label: () => t("label"),
				inject: (sessionId) => {
					let directory;
					try {
						directory = models.directoryFor(sessionId);
						directory.load();
					} catch (_unavailableSession) {
						directory = undefined;
					}
					const store = directory === undefined ? undefined : directory.store;
					const sessions = ctx.get("sessions");
					const snapshots = sessions === undefined || sessions === null ? undefined : sessions.list;
					return {
						readSelection: () => currentSelection(store === undefined ? undefined : store.getSnapshot()),
						subscribeSelection: (listener) => store === undefined ? () => {} : store.subscribe(listener),
						observeTurnEnd: (onTurnEnd) => snapshots === undefined ? () => {} : observeTurnEnd(snapshots, sessionId, onTurnEnd)
					};
				}
			}, BalanceCardEntry));
		}

		/**
		* Bridge between the session and the card. The model selection is resolved on
		* every render, and two signals force a request: the directory publishing a
		* new selection, and the session's running flag falling at the end of a turn.
		*/
		function BalanceCardEntry(props) {
			const [, bump] = react.useState(0);
			react.useEffect(() => {
				if (props.subscribeSelection === undefined) return undefined;
				return props.subscribeSelection(() => bump((value) => value + 1));
			}, [props.subscribeSelection]);

			const selection = props.readSelection === undefined ? undefined : props.readSelection();
			return BalanceDock({ selection, t: props.t, observeTurnEnd: props.observeTurnEnd });
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Exposed for the offline contract check; not part of the plugin surface. */
		exports.__internals = { formatAmount, symbolOf, isDeepSeekProvider, currentSelection, observeTurnEnd, waitForExpiry, BalanceIcon, BalanceRing, lastWallets, LOCALE_NS, MESSAGES };
		return module.exports;
	}
});
