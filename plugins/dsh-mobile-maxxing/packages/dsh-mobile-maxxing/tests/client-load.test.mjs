/**
 * Browser-half smoke test: does the module body and its `apply` run at all?
 *
 * The client bundle is loaded verbatim, so a reference to something that no
 * longer exists is not a syntax error — it throws the first time that line
 * runs, which is usually during boot. Bulk edits here twice left such a
 * reference behind while every other test stayed green, and only a real
 * browser noticed. This runs the module against a stub environment so a
 * ReferenceError fails the suite instead.
 *
 * The stub is a recursive Proxy: any property read answers "something", and
 * any call answers another stub. That is enough for the layout code's many
 * incidental DOM reads, while a genuinely undeclared identifier still raises
 * ReferenceError because that is a scope lookup, not a property read.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** A value that answers every operation without doing anything. */
function stub(depth = 0) {
	const value = function stubbed() {
		return depth > 4 ? undefined : stub(depth + 1);
	};
	return new Proxy(value, {
		get(target, key) {
			if (key === Symbol.toPrimitive) return () => 0;
			if (key === Symbol.iterator) return function* empty() {};
			if (key === "then") return undefined;
			if (key === "toString" || key === "valueOf") return () => "";
			if (depth > 4) return undefined;
			return stub(depth + 1);
		},
		apply() {
			return depth > 4 ? undefined : stub(depth + 1);
		},
		construct() {
			return depth > 4 ? undefined : stub(depth + 1);
		},
		set() {
			return true;
		},
		has() {
			return true;
		},
	});
}

/** A DOM element stand-in: every method answers, attributes start empty. */
function element() {
	const store = new Map();
	return new Proxy({
		baseURI: "http://localhost/",
		attributes: [],
		children: [],
		childNodes: [],
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		dataset: {},
		style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
		querySelector: () => null,
		querySelectorAll: () => [],
		closest: () => null,
		contains: () => false,
		append() {},
		appendChild() {},
		remove() {},
		removeChild() {},
		insertBefore() {},
		addEventListener() {},
		removeEventListener() {},
		setAttribute(name, value) { store.set(name, String(value)); },
		getAttribute: (name) => (store.has(name) ? store.get(name) : null),
		hasAttribute: (name) => store.has(name),
		removeAttribute(name) { store.delete(name); },
		toggleAttribute(name, force) { if (force === true) store.set(name, ""); else store.delete(name); },
		getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		focus() {},
		blur() {},
		click() {},
		matches: () => false,
		get innerHTML() { return ""; },
		set innerHTML(_value) {},
		textContent: "",
	}, {
		get(target, key) {
			if (key in target) return target[key];
			return stub();
		},
		set(target, key, value) {
			target[key] = value;
			return true;
		},
	});
}

/**
 * A tiny element tree for the folder-menu test. The generic stub above answers
 * every call but keeps no children, so a claim needs a node that can really
 * append a host, report children and answer the few selectors the claim uses.
 */
function treeElement(tagName = "div") {
	const attributes = new Map();
	const node = {
		tagName: tagName.toUpperCase(),
		className: "",
		classList: [],
		textContent: "",
		parentElement: null,
		childNodes: [],
		style: { setProperty() {}, removeProperty() {} },
		connected: true,
		get id() {
			return attributes.get("id") ?? "";
		},
		set id(value) {
			attributes.set("id", String(value));
		},
		get children() {
			return this.childNodes.filter((child) => child.tagName !== undefined);
		},
		get isConnected() {
			return this.connected;
		},
		setAttribute(name, value) {
			attributes.set(name, String(value));
			if (name === "class") this.classList = String(value).split(/\s+/).filter(Boolean);
		},
		getAttribute(name) {
			return attributes.has(name) ? attributes.get(name) : null;
		},
		hasAttribute(name) {
			return attributes.has(name);
		},
		removeAttribute(name) {
			attributes.delete(name);
		},
		append(...children) {
			for (const child of children) {
				if (child.parentElement !== null) child.remove();
				child.parentElement = this;
				this.childNodes.push(child);
			}
		},
		remove() {
			const siblings = this.parentElement?.childNodes;
			if (siblings !== undefined) {
				const at = siblings.indexOf(this);
				if (at >= 0) siblings.splice(at, 1);
			}
			this.parentElement = null;
			this.connected = false;
		},
		querySelector(selector) {
			return firstMatch(this, selector);
		},
		querySelectorAll(selector) {
			return allMatches(this, selector);
		},
		closest(selector) {
			let current = this;
			while (current !== null) {
				if (matchesTreeSelector(current, selector)) return current;
				current = current.parentElement;
			}
			return null;
		},
		getBoundingClientRect() {
			return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
		},
		focus() {},
		blur() {},
		addEventListener() {},
		removeEventListener() {},
	};
	return node;
}

function matchesTreeSelector(node, selector) {
	if (node.tagName === undefined) return false;
	const match = selector.match(/^([A-Za-z]*)(?:\[([\w-]+)(?:([\^$*]?=)"([^"]*)")?\])?$/);
	if (match === null) return selector === node.tagName.toLowerCase();
	const [, tag, name, operator, value] = match;
	if (tag !== "" && node.tagName !== tag.toUpperCase()) return false;
	if (name === undefined) return true;
	if (operator === undefined) return node.hasAttribute(name);
	const actual = node.getAttribute(name);
	if (operator === "^=") return actual !== null && actual.startsWith(value);
	if (operator === "$=") return actual !== null && actual.endsWith(value);
	if (operator === "*=") return actual !== null && actual.includes(value);
	return actual === value;
}

function allMatches(root, selector) {
	const found = [];
	const visit = (node) => {
		for (const child of node.children) {
			if (matchesTreeSelector(child, selector)) found.push(child);
			visit(child);
		}
	};
	visit(root);
	return found;
}

function firstMatch(root, selector) {
	return allMatches(root, selector)[0] ?? null;
}

/**
 * A localStorage that remembers, for tests that boot with a saved choice.
 *
 * The plain stub answers every call, which is enough for code that only checks
 * for a missing key but cannot express "this browser opted in".
 */
function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			map.set(key, String(value));
		},
		removeItem: (key) => {
			map.delete(key);
		},
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
	};
}

/**
 * Evaluate the bundle in a stub browser and run the plugin's `apply`.
 *
 * `mode` is the canonical host bootstrap value (`"mobile"` or `"desktop"`);
 * `narrow` answers only the window-width media query. They are deliberately
 * independent: pass `mode` explicitly when a test is about the device contract.
 * `standalone` answers the display-mode query, `storage` supplies remembered
 * localStorage entries, `configureDocument` lets a test wire up the few DOM
 * nodes it cares about, and `schedule` replaces setTimeout. `requireImpl`
 * replaces the module table the bundle loads (the default answers every name
 * with a stub), `services` supplies named client services through `ctx.get`,
 * `globals` seeds the sandbox with the flags a test seam reads before load,
 * and `log` replaces the sandbox console.
 */
function bootClient({
	mode = null,
	narrow = false,
	injectMode = true,
	standalone = false,
	storage = null,
	configureDocument = () => {},
	schedule = () => 0,
	frame = () => 0,
	frames = null,
	failFirstSlot = false,
	windowAdd = null,
	windowRemove = null,
	lang = undefined,
	copy = null,
	config = null,
	fetchImpl = null,
	navigator = null,
	notification = null,
	computedStyle = () => stub(),
	theme = null,
	locale = null,
	requireImpl = null,
	services = {},
	globals = null,
	slotsEntries = null,
	log = console,
} = {}) {
	let definition;
	const disposers = [];
	const sandbox = {
		// index.js injects the probe table into the page; the stub needs the same
		// vocabulary or the bilingual upstream-label matching falls back to
		// English and the Chinese cases never match.
		__RDSH_PWA_PROBES__: PROBES,
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				},
			},
		},
		document: (() => {
			const doc = element();
			doc.baseURI = "http://localhost/";
			doc.visibilityState = "visible";
			doc.activeElement = null;
			doc.head = element();
			doc.body = element();
			doc.documentElement = element();
			doc.createElement = () => element();
			doc.styleSheets = [];
			configureDocument(doc);
			return doc;
		})(),
		navigator: navigator ?? stub(),
		location: stub(),
		localStorage: storage === null ? stub() : memoryStorage(storage),
		sessionStorage: stub(),
		matchMedia: (query) => ({
			matches: Boolean(
				(narrow && query.includes("max-width: 767px"))
				|| (standalone && query.includes("display-mode:")),
			),
			addEventListener() {},
			removeEventListener() {},
		}),
		addEventListener: windowAdd ?? (() => {}),
		removeEventListener: windowRemove ?? (() => {}),
		setTimeout: schedule,
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: frames !== null ? (callback) => { frames.push(callback); return 0; } : frame,
		cancelAnimationFrame() {},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		getComputedStyle: computedStyle,
		console: log,
		// Real globals the layout code legitimately uses.
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		fetch: fetchImpl ?? (() => Promise.resolve(stub())),
		// DOM classes: `instanceof` needs a callable right-hand side.
		Element: class Element {},
		HTMLElement: class HTMLElement {},
		Node: class Node {},
		Event: class Event {},
		CustomEvent: class CustomEvent {},
		PointerEvent: class PointerEvent {},
		KeyboardEvent: class KeyboardEvent {},
		TouchEvent: class TouchEvent {},
		Touch: class Touch {},
		MessageChannel: class MessageChannel {},
		// `Notification` has to be replaceable for the push tests: the browser
		// half reads `permission` to decide whether it may re-register (#98).
		Notification: notification ?? stub(),
		AudioContext: class AudioContext {},
		screen: stub(),
		innerWidth: narrow ? 390 : 1024,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
		queueMicrotask,
		globalThis: undefined,
	};
	sandbox.globalThis = sandbox;
	sandbox.window.document = sandbox.document;
	sandbox.window.matchMedia = sandbox.matchMedia;
	sandbox.window.setTimeout = sandbox.setTimeout;
	sandbox.window.clearTimeout = sandbox.clearTimeout;
	sandbox.window.setInterval = sandbox.setInterval;
	sandbox.window.clearInterval = sandbox.clearInterval;
	sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
	sandbox.window.addEventListener = sandbox.addEventListener;
	sandbox.window.removeEventListener = sandbox.removeEventListener;
	sandbox.window.location = sandbox.location;
	sandbox.window.navigator = sandbox.navigator;
	sandbox.window.localStorage = sandbox.localStorage;
	sandbox.window.screen = sandbox.screen;
	sandbox.window.performance = sandbox.performance;
	sandbox.window.innerWidth = narrow ? 390 : 1024;
	sandbox.window.innerHeight = 844;
	if (lang !== undefined) sandbox.__RDSH_PWA_LANG__ = lang;
	if (copy !== null) sandbox.__RDSH_PWA_COPY__ = copy;
	if (config !== null) sandbox.__RDSH_MOBILE_UX_CONFIG__ = config;
	// The canonical host bootstrap value. Null means "let the harness derive
	// the legacy default"; contract tests pass it explicitly. `injectMode:
	// false` models an old/absent bootstrap and must fail closed to desktop.
	if (injectMode) sandbox.__RDSH_DEVICE_MODE__ = mode ?? (narrow ? "mobile" : "desktop");
	if (globals !== null && typeof globals === "object") Object.assign(sandbox, globals);
	if (sandbox.history !== undefined) sandbox.window.history = sandbox.history;
	vm.createContext(sandbox);

	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "the module registered itself");

	const plugin = definition.factory(requireImpl ?? ((name) => stub()));
	assert.equal(typeof plugin.apply, "function", "the module returns a plugin");

	// `apply` is what boot() runs from. It touches a lot of DOM; the stub
	// absorbs that, and an undeclared identifier still throws.
	const eventHandlers = new Map();
	const emitted = [];
	const ctx = {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
			return typeof dispose === "function" ? dispose : () => {};
		},
		inject(deps, callback) {
			return callback(ctx);
		},
		slots: {
			inject(deps, callback) {
				if (typeof callback === "function") return callback();
				return undefined;
			},
			entries(name) {
				return typeof slotsEntries === "function" ? slotsEntries(name) : undefined;
			},
			register() {
				if (failFirstSlot) {
					failFirstSlot = false;
					throw new Error("first slot registration failed");
				}
				return () => {};
			},
		},
		get(name) {
			if (name === "theme") return theme ?? undefined;
			if (name === "locale") return locale ?? undefined;
			return services[name];
		},
		on(event, handler) {
			let list = eventHandlers.get(event);
			if (list === undefined) {
				list = new Set();
				eventHandlers.set(event, list);
			}
			list.add(handler);
			return () => list.delete(handler);
		},
		emit(event, payload) {
			emitted.push({ event, payload });
			for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(payload);
		},
		locale: locale ?? undefined,
	};
	plugin.apply(ctx);
	return {
		definition,
		plugin,
		sandbox,
		ctx,
		disposers,
		emitted,
		emit: (event, payload) => ctx.emit(event, payload),
		disposeAll() {
			const errors = [];
			for (const dispose of disposers.splice(0).reverse()) {
				try {
					dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			return errors;
		},
	};
}

test("the shipped plugin installs Back at boot and tears it down with the module", () => {
	const handlers = new Map();
	const entries = [{ upstream: "kept" }]; let index = 0, homes = 0;
	const history = {
		get state() { return entries[index]; },
		replaceState(value) { entries[index] = value; },
		pushState(value) { entries.splice(++index); entries[index] = value; },
	};
	const workspace = {
		selection: { getSnapshot: () => ({ sessionId: "existing-session" }) },
		async openWorkspace(id) { assert.equal(id, "existing-workspace"); homes++; },
		clearMain() { assert.fail("Back must preserve the selected Workspace"); },
	};
	const booted = bootClient({
		mode: "mobile", narrow: true, globals: { history },
		services: {
			uiWorkspace: workspace,
			workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: "existing-workspace", sessionIds: ["existing-session"] }] }) } },
			layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
		},
		navigator: { userAgent: "Android", userActivation: { hasBeenActive: true } },
		windowAdd: (type, handler) => handlers.set(type, handler),
		windowRemove: (type, handler) => { if (handlers.get(type) === handler) handlers.delete(type); },
	});
	assert.equal(entries.length, 2);
	assert.equal(typeof handlers.get("popstate"), "function");
	handlers.get("popstate")({ state: entries[--index] });
	assert.equal(homes, 1);
	assert.equal(history.state.upstream, "kept");
	booted.disposeAll();
	assert.equal(handlers.has("popstate"), false);
});

test("the browser module registers and boots without a ReferenceError", () => {
	let booted;
	assert.doesNotThrow(() => {
		booted = bootClient();
	}, "the module body must evaluate and apply must not throw a ReferenceError");
	assert.equal(booted.definition.id, "dsh-mobile-maxxing");
});

/**
 * Boot the client with an open drawer, tap a button carrying `label`, and say
 * whether the drawer's own collapse button was pressed once timers settled.
 */
function drawerClosedAfterTapping(label, { narrow = true, mode = "mobile" } = {}) {
	const timers = [];
	const clickHandlers = [];
	let collapsePresses = 0;
	const collapse = element();
	collapse.click = () => {
		collapsePresses += 1;
	};
	const drawerFrame = element();
	const root = element();
	root.firstElementChild = { firstElementChild: drawerFrame };

	bootClient({
		mode,
		narrow,
		schedule: (callback) => timers.push(callback),
		configureDocument(doc) {
			doc.getElementById = (id) => (id === "root" ? root : null);
			doc.querySelector = (selector) => (selector.includes("Collapse sidebar") ? collapse : null);
			doc.addEventListener = (type, handler) => {
				if (type === "click") clickHandlers.push(handler);
			};
		},
	});
	// Desktop builds no plugin at all, so it must not install the click listener.
	assert.equal(clickHandlers.length, mode === "mobile" ? 1 : 0, "the client listens for clicks exactly on mobile");
	if (clickHandlers.length === 0) return false;
	timers.length = 0;

	const button = element();
	button.setAttribute("aria-label", label);
	const target = { closest: (selector) => (selector === "button[aria-label]" ? button : null) };
	clickHandlers[0]({ target, preventDefault() {}, stopImmediatePropagation() {} });
	for (const callback of timers.splice(0)) callback();
	return collapsePresses === 1;
}

test("the session list keeps its scroll position across drawer changes", () => {
	const timers = [];
	const booted = bootClient({ mode: "mobile", narrow: true, schedule: (callback) => { timers.push(callback); return 0; } });
	const scroller = { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 };
	const sidebar = { querySelectorAll: () => [scroller] };
	booted.sandbox.document.querySelector = (selector) => selector === "[data-rdsh-sidebar]" ? sidebar : null;
	booted.sandbox.getComputedStyle = () => ({ overflowY: "auto" });
	const drawer = booted.sandbox.__RDSH_MOBILE_UX__.drawerScroll;
	drawer.remember();
	scroller.scrollTop = 0;
	drawer.restore();
	for (const callback of timers) callback();
	assert.equal(scroller.scrollTop, 500);
	scroller.scrollHeight = 700;
	scroller.scrollTop = 0;
	drawer.restore();
	for (const callback of timers) callback();
	assert.equal(scroller.scrollTop, 300, "the restored position is clamped to the shorter list");
	booted.disposeAll();
});

test("tapping a New session button on a phone closes the drawer", () => {
	assert.equal(drawerClosedAfterTapping("New session"), true, "sidebar button");
	assert.equal(drawerClosedAfterTapping("New session in my-repo"), true, "workspace button");
	assert.equal(drawerClosedAfterTapping("新建会话"), true, "zh sidebar button");
	assert.equal(drawerClosedAfterTapping("在“my-repo”中新建会话"), true, "zh workspace button");
	// Reviewed ja labels: the stock sidebar action and a workspace's "+".
	assert.equal(drawerClosedAfterTapping("新しいセッションを作成"), true, "ja sidebar button");
	assert.equal(drawerClosedAfterTapping("my-repo で新しいセッション"), true, "ja workspace button");
});

test("other buttons leave the drawer open, and so does a wide screen", () => {
	assert.equal(drawerClosedAfterTapping("Session actions"), false);
	assert.equal(drawerClosedAfterTapping("New session", { narrow: false, mode: "desktop" }), false);
});

/**
 * The device predicate is the #17 fix, so it is exposed on the diagnostics
 * object the boot already publishes (`globalThis.__RDSH_MOBILE_UX__`).
 */
function phoneOf(options = {}) {
	const { sandbox } = bootClient(options);
	const diagnostics = sandbox.__RDSH_MOBILE_UX__;
	const mode = options.mode ?? (options.narrow === true ? "mobile" : "desktop");
	if (mode !== "mobile") {
		// Desktop is a hard no-op: no plugin, so no diagnostics to ask.
		assert.equal(diagnostics, undefined, "a desktop boot published mobile diagnostics");
		return false;
	}
	assert.ok(diagnostics !== undefined, "the mobile half booted and published its diagnostics");
	assert.equal(typeof diagnostics.phone, "function", "phone() is observable");
	return diagnostics.phone();
}

test("phone() is the bootstrapped device mode, not the width or pointer", () => {
	// The host classifier fixes the mode before this bundle runs. A narrow
	// desktop stays desktop; a wide tablet stays mobile.
	assert.equal(phoneOf({ mode: "desktop", narrow: false }), false, "a desktop is not mobile");
	assert.equal(phoneOf({ mode: "desktop", narrow: true }), false, "a narrow desktop window is still PC");
	assert.equal(phoneOf({ mode: "mobile", narrow: true }), true, "a mobile phone is mobile");
	assert.equal(phoneOf({ mode: "mobile", narrow: false }), true, "a mobile tablet at 1024px is still mobile");
	assert.equal(phoneOf({ mode: "desktop", standalone: true, narrow: false }), false, "an installed desktop app is not mobile");
	assert.equal(phoneOf({ mode: "mobile", standalone: true, narrow: false }), true, "an installed tablet is mobile");
	assert.equal(phoneOf({ mode: "bogus", narrow: true }), false, "an invalid bootstrap fails closed to desktop");
});

test("a missing bootstrap fails closed to a desktop no-op without touching the page", () => {
	const { sandbox } = bootClient({ injectMode: false, narrow: true });
	assert.equal(sandbox.__RDSH_MOBILE_UX__, undefined, "an absent bootstrap booted the mobile half");
	assert.equal(sandbox.document.documentElement.getAttribute("data-rdsh-device-mode"), null, "the client wrote a marker it does not own");
});

test("a valid mode attribute is the fallback when the global is invalid", () => {
	const { sandbox, disposeAll } = bootClient({
		mode: "bogus",
		narrow: false,
		configureDocument(doc) {
			doc.documentElement.setAttribute("data-rdsh-device-mode", "mobile");
		},
	});
	assert.equal(sandbox.__RDSH_MOBILE_UX__.state.mode, "mobile", "the valid attribute fallback was ignored");
	assert.equal(sandbox.__RDSH_MOBILE_UX__.phone(), true, "the valid attribute fallback did not enable mobile");
	assert.equal(sandbox.document.documentElement.getAttribute("data-rdsh-device-mode"), "mobile", "the marker was not kept");
	assert.deepEqual(disposeAll(), []);
});

test("a valid desktop global wins over a mobile attribute and leaves the host marker alone", () => {
	const { sandbox, disposeAll } = bootClient({
		mode: "desktop",
		narrow: false,
		configureDocument(doc) {
			doc.documentElement.setAttribute("data-rdsh-device-mode", "mobile");
		},
	});
	assert.equal(sandbox.__RDSH_MOBILE_UX__, undefined, "the contradictory attribute booted the mobile half");
	assert.equal(sandbox.document.documentElement.getAttribute("data-rdsh-device-mode"), "mobile", "the client rewrote a marker it does not own");
	assert.deepEqual(disposeAll(), []);
});

test("PC 390px stays undecorated and a 1024px tablet stays mobile", () => {
	const pc = bootClient({ mode: "desktop", narrow: true });
	assert.equal(pc.sandbox.__RDSH_MOBILE_UX__, undefined, "a narrow PC booted the mobile half");
	assert.equal(pc.sandbox.document.documentElement.hasAttribute("data-rdsh-anim"), false, "a narrow PC got the mobile animation");
	assert.equal(pc.sandbox.document.documentElement.hasAttribute("data-rdsh-drawer"), false, "a narrow PC got the drawer state");

	const tablet = bootClient({ mode: "mobile", narrow: false });
	assert.equal(tablet.sandbox.__RDSH_MOBILE_UX__.phone(), true, "a 1024px tablet lost mobile mode");
	assert.equal(tablet.sandbox.document.documentElement.getAttribute("data-rdsh-anim"), "outline", "a tablet did not get the mobile surface");
	assert.equal(tablet.sandbox.__RDSH_MOBILE_UX__.state.narrow, false, "the tablet geometry readout is wrong");
});

test("the store reports the mode separately from the layout", () => {
	const mobileWide = bootClient({ mode: "mobile", narrow: false });
	const state = mobileWide.sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(state.mode, "mobile", "the bootstrapped mode is in the store");
	assert.equal(state.narrow, false, "the layout still measures width");
	assert.equal(state.phone, true, "a wide mobile device keeps the mobile UI");
	const desktopNarrow = bootClient({ mode: "desktop", narrow: true });
	assert.equal(desktopNarrow.sandbox.__RDSH_MOBILE_UX__, undefined, "a narrow desktop built a mobile store");
});

test("the saved Enter-sends choice is read when the page loads", () => {
	// The store is built while the module body runs, so a key constant declared
	// below it is still uninitialised then. The read is wrapped in try/catch,
	// which turned that into "off" on every reload without a visible error.
	const off = bootClient({ mode: "mobile" });
	assert.equal(off.sandbox.__RDSH_MOBILE_UX__.state.enterToSend, false, "Enter inserts a newline by default");
	const on = bootClient({ mode: "mobile", storage: { "rdsh-mobile-ux:enter-to-send": "1" } });
	assert.equal(on.sandbox.__RDSH_MOBILE_UX__.state.enterToSend, true, "the saved choice survives a reload");
});

test("an iPhone desktop-site UA still advertises the iOS install path", () => {
	// Safari has no beforeinstallprompt, so the welcome card is the only A2HS
	// guidance. A desktop-site iPhone keeps a Macintosh UA but reports
	// platform "iPhone"; isIos() and the card must still see it.
	const { sandbox, disposeAll } = bootClient({
		mode: "mobile",
		narrow: false,
		navigator: {
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
			platform: "iPhone",
			maxTouchPoints: 0,
			onLine: true,
			serviceWorker: stub(),
		},
		configureDocument(doc) {
			const header = element();
			header.className = "_headerBlank";
			doc.querySelector = (selector) => (selector === "header[data-window-drag]" ? header : null);
		},
	});
	const pwa = sandbox.__RDSH_PWA__;
	assert.equal(pwa.state.ios, true, "the desktop-site iPhone lost the iOS hint");
	assert.equal(pwa.state.mode, "mobile", "the device mode is wrong");
	assert.equal(pwa.showInstallPrompt(), true, "the welcome-screen A2HS card is not offered");
	assert.deepEqual(disposeAll(), []);
});

test("isIos trusts Apple platform strings but not Windows or Android", () => {
	const iosOf = (fields) => {
		const booted = bootClient({
			mode: "mobile",
			narrow: false,
			navigator: { onLine: true, serviceWorker: stub(), ...fields },
		});
		const value = booted.sandbox.__RDSH_PWA__.state.ios;
		booted.disposeAll();
		return value;
	};
	const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15";
	assert.equal(iosOf({ userAgent: mac, platform: "iPad", maxTouchPoints: 0 }), true, "a desktop-site iPad lost the iOS hint");
	assert.equal(iosOf({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36", platform: "Win32", maxTouchPoints: 10 }), false, "a Windows touch PC was treated as iOS");
	assert.equal(iosOf({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36", platform: "Linux armv8l", maxTouchPoints: 5 }), false, "an Android phone was treated as iOS");
});

/** Boot with a body that records what the client appends to it. */
function bootRecordingBody(options) {
	const appended = [];
	const booted = bootClient({
		...options,
		configureDocument(doc) {
			doc.body.appendChild = (node) => {
				appended.push(node);
				return node;
			};
		},
	});
	return { ...booted, appended };
}

test("a mobile boot mounts one empty top-edge box and its dispose removes it", () => {
	// iOS 27 standalone blurs the top edge unless a fixed box sits there; the
	// stylesheet turns this node into that box. It must stay empty: a text
	// node would give background-clip: text something to paint.
	const { appended, disposeAll } = bootRecordingBody({ mode: "mobile", narrow: true, standalone: true });
	const edges = appended.filter((node) => node.className === "dsh-mobile-maxxing-top-edge");
	assert.equal(edges.length, 1, "expected exactly one top-edge box");
	const [edge] = edges;
	assert.equal(edge.getAttribute("aria-hidden"), "true", "screen readers can reach the top-edge box");
	assert.equal(edge.textContent, "", "the top-edge box has text to paint");
	let removed = 0;
	edge.remove = () => {
		removed += 1;
	};
	assert.deepEqual(disposeAll(), []);
	assert.equal(removed, 1, "the top-edge box outlived the boot effect");
});

test("a desktop boot mounts no top-edge box", () => {
	const { appended } = bootRecordingBody({ mode: "desktop", narrow: false, standalone: true });
	assert.equal(appended.some((node) => node.className === "dsh-mobile-maxxing-top-edge"), false, "a desktop got the iOS top-edge box");
});

test("the device-turn opt-in is read on mobile and never boots a desktop", () => {
	const off = bootClient({ mode: "mobile" });
	assert.equal(off.sandbox.__RDSH_MOBILE_UX__.state.notifyDeviceTurns, false, "phone-only stays the default");
	const on = bootClient({ mode: "mobile", storage: { "rdsh-mobile-ux:notify-device-turns": "1" } });
	assert.equal(on.sandbox.__RDSH_MOBILE_UX__.state.notifyDeviceTurns, true, "the saved opt-in is read");
	// Saved opt-ins must not resurrect the plugin on a PC.
	const desktop = bootClient({
		mode: "desktop",
		storage: { "rdsh-mobile-ux:notify-device-turns": "1", "dsh-mobile-maxxing:device-theme": "dark" },
	});
	assert.equal(desktop.sandbox.__RDSH_MOBILE_UX__, undefined, "a desktop with saved opt-ins booted the mobile half");
});

test("the legacy hide list applies at phone width even with a fine pointer", () => {
	const frames = [];
	const button = element();
	button.setAttribute("aria-label", "More actions");
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		frames,
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === "button[aria-label], [role='menuitem']" ? [button] : []);
			doc.querySelector = () => null;
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(button.hasAttribute("data-rdsh-hidden"), true, "a mobile phone hides the stock control");
	booted.disposeAll();

	const wideButton = element();
	wideButton.setAttribute("aria-label", "More actions");
	const wide = bootClient({
		mode: "desktop",
		narrow: false,
		frames: [],
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === "button[aria-label], [role='menuitem']" ? [wideButton] : []);
			doc.querySelector = () => null;
		},
	});
	assert.equal(wideButton.hasAttribute("data-rdsh-hidden"), false, "a desktop hides nothing");
	wide.disposeAll();
});

/** One committed ja namespace, as the full translation ships it. */
function jaNamespace(name) {
	return JSON.parse(readFileSync(new URL(`../../dsh-locale-ja/locale/namespaces/ja/${name}.json`, import.meta.url), "utf8"));
}

test("#80 the default hide list matches the committed ja labels", () => {
	// The visible ja renderings of HIDE_DEFAULT, read from the reviewed
	// catalogue rather than written out here.
	const settings = jaNamespace("settings");
	const shortcuts = jaNamespace("shortcuts");
	const account = jaNamespace("settings.account");
	const plugins = jaNamespace("settings.plugins");
	const command = jaNamespace("command");
	const sessionLog = jaNamespace("session-log-download");
	const labels = [
		settings.openDocument,
		sessionLog["header.more"],
		command["label.feedback"],
		account.signIn,
		shortcuts.settings,
		settings["developerTools.title"],
		plugins.title,
	];
	const controls = labels.map((label) => {
		const button = element();
		button.setAttribute("aria-label", label);
		return button;
	});
	const frames = [];
	const config = {};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		lang: "ja",
		frames,
		config,
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === "button[aria-label], [role='menuitem']" ? controls : []);
			doc.querySelector = () => null;
		},
	});
	const flush = () => {
		for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	};
	flush();
	for (const [index, control] of controls.entries()) {
		assert.equal(control.hasAttribute("data-rdsh-hidden"), true, `${labels[index]} stayed visible on a phone`);
	}
	assert.equal(booted.sandbox.document.documentElement.hasAttribute("data-rdsh-hide-settings"), true);

	// The console switch turns hiding off, and the same pass cleans every hook.
	config.showHiddenControls = true;
	booted.sandbox.__RDSH_MOBILE_UX__.decorate();
	flush();
	for (const control of controls) assert.equal(control.hasAttribute("data-rdsh-hidden"), false, "turning hiding off left a tag behind");
	assert.equal(booted.sandbox.document.documentElement.hasAttribute("data-rdsh-hide-settings"), false);

	// ...and back on: the ja entries are still in the default list.
	config.showHiddenControls = false;
	booted.sandbox.__RDSH_MOBILE_UX__.decorate();
	flush();
	for (const control of controls) assert.equal(control.hasAttribute("data-rdsh-hidden"), true, "the ja entries left the default list");
	booted.disposeAll();

	// A profile's own custom entries keep their exact/prefix semantics along
	// with the localized defaults.
	const custom = element();
	custom.setAttribute("aria-label", "Custom control: keep out");
	const customFrames = [];
	const customBoot = bootClient({
		mode: "mobile",
		narrow: true,
		frames: customFrames,
		config: { hideLabels: ["Custom control"] },
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === "button[aria-label], [role='menuitem']" ? [custom] : []);
			doc.querySelector = () => null;
		},
	});
	for (let index = 0; index < 10 && customFrames.length > 0; index += 1) customFrames.shift()();
	assert.equal(custom.hasAttribute("data-rdsh-hidden"), true, "the profile hide entry stopped matching");
	customBoot.disposeAll();

	// A desktop with the same ja labels is a hard no-op.
	const desktopControls = labels.map((label) => {
		const button = element();
		button.setAttribute("aria-label", label);
		return button;
	});
	const desktop = bootClient({
		mode: "desktop",
		narrow: false,
		lang: "ja",
		frames: [],
		configureDocument(doc) {
			doc.querySelectorAll = () => desktopControls;
			doc.querySelector = () => null;
		},
	});
	for (const control of desktopControls) assert.equal(control.hasAttribute("data-rdsh-hidden"), false, "a desktop hid a ja control");
	desktop.disposeAll();
});

/* ------------------------------------------------------------------ */
/* #75: the Trajectory Conversation view stays reachable on a phone    */
/* ------------------------------------------------------------------ */

/** The shipped Conversation tab strip: a marker div with plain tab buttons. */
function conversationTabs(labels = ["Chat", "Trajectory", "Dashboard"], selected = "Chat") {
	const tabs = [];
	const strip = element();
	for (const label of labels) {
		const tab = element();
		tab.tagName = "BUTTON";
		tab.textContent = label;
		tab.querySelector = () => null;
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(label === selected));
		tab.clicks = 0;
		tab.focused = false;
		tab.click = () => {
			tab.clicks += 1;
			for (const other of tabs) other.setAttribute("aria-selected", String(other === tab));
		};
		tab.focus = () => {
			tab.focused = true;
		};
		tabs.push(tab);
	}
	strip.querySelectorAll = (selector) => (selector === '[role="tab"]' ? tabs : []);
	return { strip, tabs };
}

/** Boot client.js against one Conversation tab strip and run a decorate pass. */
function bootConversationTabs({ mode = "mobile", fixture = conversationTabs(), slotsEntries = null } = {}) {
	const frames = [];
	const booted = bootClient({
		mode,
		narrow: mode === "mobile",
		frames,
		slotsEntries,
		configureDocument(doc) {
			doc.querySelector = (selector) => (selector === "[data-conversation-tabs]" ? fixture.strip : null);
			doc.querySelectorAll = (selector) => {
				if (selector === "[data-conversation-tabs]") return [fixture.strip];
				const exactAttribute = /^\[([\w-]+)\]$/.exec(selector);
				return exactAttribute === null ? [] : fixture.tabs.filter((tab) => tab.hasAttribute(exactAttribute[1]));
			};
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	return { ...fixture, booted, frames };
}

// The phone used to hide the Trajectory tab by CSS, but upstream picks the
// header's "…" fold from its own View list: a tab hidden that way still counts
// as visible, so it never landed in the menu either and the View became
// unreachable (#75). Upstream already folds what does not fit by width, so the
// strip is left alone: the tab shows where the row has room and folds into "…"
// where it does not. These tests fail if a hide comes back.
test("#75 leaves every Conversation view tab on a phone", () => {
	const { tabs, booted } = bootConversationTabs({ fixture: conversationTabs(["Chat", "Trajectory", "Dashboard"], "Trajectory") });
	for (const tab of tabs) {
		const hooks = [...tab.attributes.keys()].filter((name) => name.startsWith("data-rdsh-"));
		assert.deepEqual(hooks, [], `the phone hooked the ${tab.textContent} tab`);
		assert.equal(tab.clicks, 0, "the phone changed the selection");
	}
	assert.equal(tabs[1].getAttribute("aria-selected"), "true", "the active Trajectory view was lost");
	booted.disposeAll();
});

test("#75 no stylesheet rule hides a Conversation view tab", () => {
	const sheets = [
		CLIENT.match(/const CSS_PHONE = `([\s\S]*?)`;/)[1],
		CLIENT.match(/const CSS_DEVICE = `([\s\S]*?)`;/)[1],
		CLIENT.match(/const CSS = `([\s\S]*?)`;/)[1],
	];
	for (const sheet of sheets) {
		assert.doesNotMatch(
			sheet,
			/\[data-conversation-tabs\][^{}]*\{[^}]*display:\s*none/,
			"a stylesheet hides a Conversation view tab",
		);
	}
	assert.doesNotMatch(CLIENT, /trajectory-tab-hidden/, "the hidden-tab hook came back");
});

test("the effect disposer tears down without a ReferenceError or a stale listener", () => {
	const adds = [];
	const removes = [];
	const booted = bootClient({
		mode: "mobile",
		configureDocument(doc) {
			const add = doc.addEventListener;
			const remove = doc.removeEventListener;
			doc.addEventListener = (type, handler, options) => {
				adds.push(handler);
				add.call(doc, type, handler, options);
			};
			doc.removeEventListener = (type, handler, options) => {
				removes.push(handler);
				remove.call(doc, type, handler, options);
			};
		},
	});
	assert.ok(booted.sandbox.__RDSH_MOBILE_UX__ !== undefined, "the mobile half booted");
	assert.ok(booted.disposers.length > 0, "the boot registered effects");
	const errors = booted.disposeAll();
	assert.deepEqual(errors.map((error) => String(error)), [], "teardown threw (displayMedia was the old ReferenceError)");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__, undefined, "the diagnostics object was not removed");
	const stale = adds.filter((handler) => !removes.includes(handler));
	assert.deepEqual(stale, [], "a document listener outlived its effect");
});

test("a height-only resize keeps an in-flight swipe; a width change drops it", () => {
	const windowHandlers = [];
	const documentHandlers = [];
	const open = element();
	let presses = 0;
	open.click = () => {
		presses += 1;
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		windowAdd: (type, handler) => windowHandlers.push([type, handler]),
		windowRemove() {},
		configureDocument(doc) {
			doc.addEventListener = (type, handler) => documentHandlers.push([type, handler]);
			doc.querySelector = (selector) => (selector.includes("Open sidebar") ? open : null);
		},
	});
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];
	const start = handler("touchstart", "onEdgeSwipeStart");
	const move = handler("touchmove", "onEdgeSwipeMove");
	const end = handler("touchend", "onEdgeSwipeEnd");
	assert.equal(typeof start, "function", "the edge swipe start is registered");
	assert.equal(typeof move, "function", "the edge swipe move is registered");
	assert.equal(typeof end, "function", "the edge swipe end is registered");
	const onResize = [...windowHandlers].filter(([type]) => type === "resize").at(-1)?.[1];
	assert.equal(typeof onResize, "function", "the boot resize handler is registered");

	const touch = (x) => ({ cancelable: true, preventDefault() {}, touches: [{ clientX: x, clientY: 200 }] });
	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(40));
	// A keyboard / URL-bar resize changes height only: the gesture must live.
	onResize();
	move(touch(90));
	assert.equal(presses, 1, "a height-only resize cancelled the swipe");

	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(40));
	// A real width change invalidates the stored start point.
	booted.sandbox.innerWidth = 320;
	booted.sandbox.window.innerWidth = 320;
	onResize();
	move(touch(90));
	assert.equal(presses, 1, "a width change did not reset the gesture");

	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(40));
	end();
	move(touch(90));
	assert.equal(presses, 1, "touchend did not clear the gesture");
	booted.disposeAll();
});

test("the injected language wins over the shell document language", () => {
	const shellLang = (value) => (doc) => {
		doc.documentElement.lang = value;
	};
	// The host default (ja) must restore the reference UI even when the shell
	// document stays lang="en"; an explicit en must equally win over a ja
	// shell. The document language is only the fallback.
	assert.equal(bootClient({ mode: "mobile", lang: "ja", configureDocument: shellLang("en") }).sandbox.__RDSH_MOBILE_UX__.lang, "ja");
	assert.equal(bootClient({ mode: "mobile", lang: "en", configureDocument: shellLang("ja") }).sandbox.__RDSH_MOBILE_UX__.lang, "en");
	assert.equal(bootClient({ mode: "mobile", lang: "ja-JP", configureDocument: shellLang("en") }).sandbox.__RDSH_MOBILE_UX__.lang, "ja");
	assert.equal(bootClient({ mode: "mobile", configureDocument: shellLang("ja") }).sandbox.__RDSH_MOBILE_UX__.lang, "ja");
	assert.equal(bootClient({ mode: "mobile", configureDocument: shellLang("en") }).sandbox.__RDSH_MOBILE_UX__.lang, "en");
	assert.equal(bootClient({ mode: "mobile" }).sandbox.__RDSH_MOBILE_UX__.lang, "en", "no signals falls back to English");
});

test("one failing part does not stop the other client halves", () => {
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args);
	try {
		const booted = bootClient({ mode: "mobile", failFirstSlot: true });
		assert.ok(booted.sandbox.__RDSH_MOBILE_UX__ !== undefined, "mobile UX died with the PWA part");
		assert.ok(
			errors.some(([message]) => String(message).includes("pwa client half failed to apply")),
			"the failure was not logged with the part name",
		);
		booted.disposeAll();
	} finally {
		console.error = original;
	}
});

test("the detail popover dismisses inside/outside/Escape and dispose leaves nothing", () => {
	const timers = [];
	const documentHandlers = [];
	const removedHandlers = [];
	const pop = element();
	const inside = { id: "inside" };
	const outside = { id: "outside" };
	let currentPop = null;
	let popConnected = false;
	pop.isConnected = false;
	pop.contains = (target) => target === inside || target === pop;
	pop.remove = () => {
		popConnected = false;
		pop.isConnected = false;
		currentPop = null;
	};
	const todo = element();
	todo.setAttribute("data-rdsh-todo-text", "A long todo item");
	todo.setAttribute("data-rdsh-todo-status", "in_progress");
	const booted = bootClient({
		narrow: true,
		schedule: (callback) => timers.push(callback),
		configureDocument(doc) {
			let armed = false;
			let created = 0;
			doc.createElement = () => {
				if (armed && created === 0) {
					created += 1;
					currentPop = pop;
					popConnected = true;
					pop.isConnected = true;
					return pop;
				}
				return element();
			};
			doc.querySelector = (selector) => (selector === ".rdsh-mux-detail" ? currentPop : null);
			doc.addEventListener = (type, handler) => {
				if (type === "click" && handler.name === "onClickCapture") armed = true;
				documentHandlers.push([type, handler]);
			};
			doc.removeEventListener = (type, handler) => removedHandlers.push([type, handler]);
			doc.__resetPopover = () => {
				created = 0;
			};
		},
	});
	timers.length = 0;
	const click = [...documentHandlers].find(([type, handler]) => type === "click" && handler.name === "onClickCapture")?.[1];
	assert.equal(typeof click, "function", "the click handler is registered");
	const target = {
		closest: (selector) => (selector === "[data-rdsh-todo-item]" ? todo : null),
	};
	const open = () => {
		booted.sandbox.document.__resetPopover();
		click({ target, preventDefault() {}, stopImmediatePropagation() {} });
		assert.equal(currentPop, pop, "the popover was not created");
		assert.equal(popConnected, true);
		for (const callback of timers.splice(0)) callback();
		const pointer = [...documentHandlers].filter(([type, handler]) => type === "pointerdown" && handler.name === "dismiss").at(-1)?.[1];
		const key = [...documentHandlers].filter(([type, handler]) => type === "keydown" && handler.name === "dismissKey").at(-1)?.[1];
		assert.equal(typeof pointer, "function", "the pointer dismiss listener was not attached");
		assert.equal(typeof key, "function", "the Escape listener was not attached");
		return { pointer, key };
	};

	let { pointer, key } = open();
	// A tap inside the popover must not retire the outside dismissal.
	pointer({ target: inside });
	assert.equal(popConnected, true, "an inside tap closed the popover");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), false, "the pointer listener was removed on an inside tap");
	pointer({ target: outside });
	assert.equal(popConnected, false, "an outside tap did not close the popover");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), true, "the outside dismissal leaked its listener");
	assert.equal(removedHandlers.some(([, handler]) => handler === key), true, "the Escape listener leaked after an outside tap");

	({ pointer, key } = open());
	key({ key: "Escape" });
	assert.equal(popConnected, false, "Escape did not close the popover");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), true, "Escape leaked the pointer listener");
	assert.equal(removedHandlers.some(([, handler]) => handler === key), true, "Escape leaked its own listener");

	({ pointer, key } = open());
	booted.disposeAll();
	assert.equal(popConnected, false, "dispose left the popover in the DOM");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), true, "dispose leaked the pointer listener");
	assert.equal(removedHandlers.some(([, handler]) => handler === key), true, "dispose leaked the Escape listener");
});

test("the session colour frame is a phone-only hook", () => {
	// #44: the frame is phone layout now. A wide window must leave the row
	// exactly as upstream rendered it; 390px paints the chosen colour.
	const frameRow = (narrow) => {
		const frames = [];
		const row = element();
		row.setAttribute("data-row-key", "session:s1");
		let frameColor = null;
		row.style = {
			setProperty(name, value) { if (name === "--rdsh-session-frame") frameColor = value; },
			removeProperty(name) { if (name === "--rdsh-session-frame") frameColor = null; },
		};
		const booted = bootClient({
			narrow,
			frames,
			storage: { "rdsh-mobile-ux:session-frames": JSON.stringify({ s1: "#ff6b6b" }) },
			configureDocument(doc) {
				doc.querySelectorAll = (selector) => (selector === '[data-row-key^="session:"]' ? [row] : []);
				doc.querySelector = () => null;
			},
		});
		for (let index = 0; index < 20 && frames.length > 0; index += 1) frames.shift()();
		return { row, frameColor, booted };
	};

	const wide = frameRow(false);
	assert.equal(wide.row.hasAttribute("data-rdsh-session"), false, "a desktop row was decorated");
	assert.equal(wide.row.hasAttribute("data-rdsh-session-frame"), false, "a desktop row got the phone frame hook");
	assert.equal(wide.frameColor, null, "a desktop row got the frame colour");
	wide.booted.disposeAll();

	const phone = frameRow(true);
	assert.equal(phone.row.hasAttribute("data-rdsh-session"), true, "the phone row was not decorated");
	assert.equal(phone.row.hasAttribute("data-rdsh-session-frame"), true, "the phone colour frame hook was not generated");
	assert.equal(phone.frameColor, "#ff6b6b", "the phone frame colour was not written");
	phone.booted.disposeAll();
});

test("folder colour frames are phone-only and never share a namespace with sessions", () => {
	// A folder header carries the same palette, but its storage and hook are
	// separate. The same id in both maps must stay two different colours.
	const paint = (row) => {
		let color = null;
		row.style = {
			setProperty(name, value) { if (name === "--rdsh-folder-frame") color = value; },
			removeProperty(name) { if (name === "--rdsh-folder-frame") color = null; },
		};
		return () => color;
	};
	const folderRow = (narrow, storage = {}) => {
		const row = element();
		row.setAttribute("data-row-key", "workspace:w1");
		const color = paint(row);
		const frames = [];
		const booted = bootClient({
			mode: narrow ? "mobile" : "desktop",
			narrow,
			frames,
			storage,
			configureDocument(doc) {
				doc.querySelectorAll = (selector) => (selector === '[data-row-key^="workspace:"]' ? [row] : []);
				doc.querySelector = () => null;
			},
		});
		for (let index = 0; index < 20 && frames.length > 0; index += 1) frames.shift()();
		return { row, color, booted };
	};

	const wide = folderRow(false, { "dsh-mobile-maxxing:folder-frames": JSON.stringify({ w1: "#5bd6a5" }) });
	assert.equal(wide.row.hasAttribute("data-rdsh-folder-frame"), false, "a desktop folder row got the phone frame hook");
	assert.equal(wide.color(), null, "a desktop folder row got the frame colour");
	wide.booted.disposeAll();

	const phone = folderRow(true, { "dsh-mobile-maxxing:folder-frames": JSON.stringify({ w1: "#5bd6a5" }) });
	assert.equal(phone.row.hasAttribute("data-rdsh-folder-frame"), true, "the phone folder frame hook was not generated");
	assert.equal(phone.color(), "#5bd6a5", "the phone folder frame colour was not written");
	const phoneApi = phone.booted.sandbox.__RDSH_MOBILE_UX__.folderFrames;
	phoneApi.save("w1", null);
	phone.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(phone.row.hasAttribute("data-rdsh-folder-frame"), false, "clearing a folder frame left the hook");
	assert.equal(phone.color(), null, "clearing a folder frame left the colour");
	assert.equal(phoneApi.read().w1, undefined, "clearing a folder frame left the stored map entry");
	phone.row.setAttribute("data-row-key", "workspace:");
	phone.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(phone.row.hasAttribute("data-rdsh-folder-frame"), false, "the Ungrouped bucket was treated as a folder");
	phone.booted.disposeAll();

	const collision = (() => {
		const sessionRow = element();
		sessionRow.setAttribute("data-row-key", "session:w1");
		let sessionColor = null;
		sessionRow.style = {
			setProperty(name, value) { if (name === "--rdsh-session-frame") sessionColor = value; },
			removeProperty(name) { if (name === "--rdsh-session-frame") sessionColor = null; },
		};
		const row = element();
		row.setAttribute("data-row-key", "workspace:w1");
		const color = paint(row);
		const frames = [];
		const booted = bootClient({
			mode: "mobile",
			narrow: true,
			frames,
			storage: {
				"rdsh-mobile-ux:session-frames": JSON.stringify({ w1: "#ff6b6b" }),
				"dsh-mobile-maxxing:folder-frames": JSON.stringify({ s1: "#5bd6a5", w1: "#7aaaff" }),
			},
			configureDocument(doc) {
				doc.querySelectorAll = (selector) => (
					selector === '[data-row-key^="session:"]' ? [sessionRow]
						: selector === '[data-row-key^="workspace:"]' ? [row]
							: []
				);
				doc.querySelector = () => null;
			},
		});
		for (let index = 0; index < 20 && frames.length > 0; index += 1) frames.shift()();
		return { sessionRow, sessionColor: () => sessionColor, row, color, booted };
	})();
	assert.equal(collision.sessionColor(), "#ff6b6b", "the session row read the folder map");
	assert.equal(collision.color(), "#7aaaff", "the folder row read the session map");
	assert.equal(collision.sessionRow.hasAttribute("data-rdsh-folder-frame"), false, "the session row got a folder hook");
	assert.equal(collision.row.hasAttribute("data-rdsh-session-frame"), false, "the folder row got a session hook");
	const api = collision.booted.sandbox.__RDSH_MOBILE_UX__.folderFrames;
	api.save("w2", "#5bd6a5");
	assert.equal(
		collision.booted.sandbox.localStorage.getItem("dsh-mobile-maxxing:folder-frames"),
		JSON.stringify({ s1: "#5bd6a5", w1: "#7aaaff", w2: "#5bd6a5" }),
		"the folder save did not land in the dsh-named folder key",
	);
	assert.equal(
		collision.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:session-frames"),
		JSON.stringify({ w1: "#ff6b6b" }),
		"the folder save rewrote the legacy session key",
	);
	collision.booted.disposeAll();
});

test("a folder menu is claimed by portal structure once and leaves other menus alone", () => {
	// The shell has no workspace-menu slot. A click on the folder's own "..."
	// arms one claim; the first menu portal that appears after that click is
	// the claimed one, marked aria-controls <-> id. No label is ever read.
	const menus = [];
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		configureDocument(doc) {
			doc.createElement = (tag) => treeElement(tag);
			doc.querySelectorAll = (selector) => (selector === '[role="menu"]' ? menus : []);
			doc.querySelector = () => null;
		},
		requireImpl(name) {
			if (name === "react") return { createElement: () => ({}) };
			if (name === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
			if (name === "@deepseek-ai/dsh-client-ui-primitives") return { MenuItemButton: function MenuItemButton() {} };
			return stub();
		},
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__?.folderFrames;
	assert.ok(api, "the mobile half did not publish the folder-frame diagnostics");

	const menuWithItem = () => {
		const viewport = treeElement("div");
		viewport.setAttribute("role", "presentation");
		const item = treeElement("button");
		item.setAttribute("role", "menuitem");
		viewport.append(item);
		const menu = treeElement("div");
		menu.setAttribute("role", "menu");
		menu.append(viewport);
		return { menu, viewport };
	};

	const other = menuWithItem();
	menus.push(other.menu);

	const row = treeElement("div");
	row.setAttribute("data-row-key", "workspace:w1");
	const actions = treeElement("span");
	actions.classList = ["YDXeBa_rowActions"];
	const trigger = treeElement("button");
	trigger.setAttribute("aria-label", "Workspace actions: repo");
	const plus = treeElement("button");
	actions.append(trigger, plus);
	row.append(actions);

	api.arm(trigger);
	assert.equal(api.pending()?.key, "w1", "the folder click did not arm a claim");
	const folder = menuWithItem();
	menus.push(folder.menu);
	api.decorate();

	assert.equal(folder.menu.getAttribute("data-rdsh-folder-menu"), "", "the folder portal was not claimed");
	assert.match(folder.menu.getAttribute("id") ?? "", /^rdsh-folder-menu-\d+$/, "the folder portal has no ownership id");
	assert.equal(trigger.getAttribute("aria-controls"), folder.menu.getAttribute("id"), "the anchor does not point at the claimed portal");
	assert.equal(trigger.getAttribute("aria-expanded"), "true", "the anchor does not report the claimed portal");
	assert.equal(other.menu.hasAttribute("data-rdsh-folder-menu"), false, "another menu was decorated");
	assert.equal(other.menu.getAttribute("id"), null, "another menu received the ownership id");
	const hostCount = () => folder.viewport.children.filter((child) => child.hasAttribute("data-rdsh-folder-frame-item")).length;
	assert.equal(hostCount(), 1, "the frame row host was not appended to the folder menu");
	assert.equal(
		folder.viewport.children.find((child) => child.hasAttribute("data-rdsh-folder-frame-item"))?.style.display,
		"contents",
		"the host adds a layout box around the native menu row",
	);
	api.decorate();
	api.decorate();
	assert.equal(hostCount(), 1, "a re-decorate appended a second frame row");

	// Switching folders: the old portal is gone but its replacement opened in
	// the same frame. The queued claim must survive the old portal's cleanup.
	folder.menu.remove();
	api.arm(trigger);
	const second = menuWithItem();
	menus.push(second.menu);
	api.decorate();
	assert.equal(folder.menu.hasAttribute("data-rdsh-folder-menu"), false, "the closed portal kept its marker");
	assert.equal(second.menu.getAttribute("data-rdsh-folder-menu"), "", "the replacement portal was not claimed");
	assert.equal(trigger.getAttribute("aria-controls"), second.menu.getAttribute("id"), "the anchor does not point at the replacement");

	api.clear();
	assert.equal(second.menu.hasAttribute("data-rdsh-folder-menu"), false, "clear left the ownership marker");
	assert.equal(second.menu.getAttribute("id"), null, "clear left the ownership id");
	assert.equal(trigger.hasAttribute("aria-controls"), false, "clear left aria-controls on the anchor");
	assert.equal(trigger.hasAttribute("aria-expanded"), false, "clear left aria-expanded on the anchor");
	assert.equal(second.viewport.children.filter((child) => child.hasAttribute("data-rdsh-folder-frame-item")).length, 0, "clear left the frame row host");

	// A click that opens no portal consumes the claim: a menu opened later is
	// another menu and must not inherit the folder row.
	api.arm(trigger);
	api.decorate();
	assert.equal(api.pending(), null, "the claim survived a pass that saw no new portal");

	// A Session row's "..." is not a Workspace menu: it neither arms nor claims.
	const sessionRow = treeElement("div");
	sessionRow.setAttribute("data-row-key", "session:s1");
	const sessionActions = treeElement("span");
	sessionActions.classList = ["YDXeBa_rowActions"];
	const sessionTrigger = treeElement("button");
	sessionActions.append(sessionTrigger);
	sessionRow.append(sessionActions);
	const stray = menuWithItem();
	// The folder claim is still live when the Session trigger is clicked; that
	// click must retire it instead of decorating the Session menu.
	api.arm(trigger);
	api.arm(sessionTrigger);
	assert.equal(api.pending(), null, "a later click did not retire the folder claim");
	menus.push(stray.menu);
	api.decorate();
	assert.equal(stray.menu.hasAttribute("data-rdsh-folder-menu"), false, "a session menu was claimed as a folder menu");
	assert.equal(stray.menu.getAttribute("id"), null, "a session menu received the folder ownership id");

	// The Ungrouped bucket has no Workspace id, so it cannot arm either.
	const ungrouped = treeElement("div");
	ungrouped.setAttribute("data-row-key", "workspace:");
	const ungroupedActions = treeElement("span");
	ungroupedActions.classList = ["YDXeBa_rowActions"];
	const ungroupedTrigger = treeElement("button");
	ungroupedActions.append(ungroupedTrigger);
	ungrouped.append(ungroupedActions);
	const strayUngrouped = menuWithItem();
	api.arm(ungroupedTrigger);
	menus.push(strayUngrouped.menu);
	api.decorate();
	assert.equal(strayUngrouped.menu.hasAttribute("data-rdsh-folder-menu"), false, "the Ungrouped bucket was claimed as a folder");
	booted.disposeAll();
});

test("a rightward swipe closes an open right panel; the left edge opens the drawer instead", () => {
	const documentHandlers = [];
	const collapse = element();
	const panel = element();
	panel.setAttribute("data-sidebar-right-open", "");
	let closes = 0;
	collapse.getBoundingClientRect = () => ({ width: 24, height: 24, top: 0, left: 0, right: 24, bottom: 24 });
	collapse.closest = (selector) => (selector === "[data-sidebar-right-panel]" ? panel : null);
	collapse.click = () => {
		closes += 1;
	};
	const booted = bootClient({
		narrow: true,
		configureDocument(doc) {
			doc.documentElement.setAttribute("data-rdsh-rightpanel-open", "");
			doc.addEventListener = (type, handler) => documentHandlers.push([type, handler]);
			doc.querySelector = () => null;
			// #97: upstream marks the panel toggle with a stable data attribute.
			collapse.setAttribute("data-sidebar-right-toggle", "");
			doc.querySelectorAll = (selector) => (selector.includes("data-sidebar-right-toggle") ? [collapse] : []);
		},
	});
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];
	const start = handler("touchstart", "onEdgeSwipeStart");
	const move = handler("touchmove", "onEdgeSwipeMove");
	const touch = (x) => ({ cancelable: true, preventDefault() {}, touches: [{ clientX: x, clientY: 200 }] });
	// Away from the left edge, a rightward swipe closes the open panel.
	start({ touches: [{ clientX: 200, clientY: 200 }], target: {} });
	move(touch(290));
	assert.equal(closes, 1, "the panel did not close from a non-edge start");

	// #113: a fullscreen panel (no docked split) owns the left edge too; a
	// rightward swipe from there closes the panel, not the drawer.
	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(100));
	assert.equal(closes, 2, "the left-edge swipe did not close the fullscreen panel");
	booted.disposeAll();
});

test("the four-row drawer survives decoration when the upstream nav exists", () => {
	// The reference drawer's four rows are New Session (stock), Plugins and
	// Automation tasks (stock `sidebar.panellist` rows), and the Settings row
	// this plugin injects into that nav. If upstream renders no nav at all
	// (panels list empty), there is nowhere to inject. This pins the part this
	// package owns: decoration keeps the three stock rows visible and adds the
	// fourth after Automation tasks, even when no account menu is signed in.
	const frames = [];
	const nav = element();
	const newSession = element();
	const plugins = element();
	const auto = element();
	newSession.setAttribute("aria-label", "New Session");
	plugins.setAttribute("aria-label", "Plugins");
	auto.setAttribute("aria-label", "Automation tasks");
	let afterNode = null;
	auto.after = (node) => {
		afterNode = node;
		node.parentElement = nav;
		auto.nextElementSibling = node;
		nav.lastElementChild = node;
	};
	nav.contains = (node) => node.parentElement === nav;
	nav.querySelector = (selector) => {
		if (selector.includes('aria-label="Automation tasks"')) return auto;
		if (selector.includes('aria-label="Plugins"')) return plugins;
		if (selector === "[data-rdsh-settings-row]") return null;
		return null;
	};
	const created = [];
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			const create = doc.createElement;
			doc.createElement = (tag) => {
				const node = create(tag);
				created.push(node);
				return node;
			};
			doc.querySelector = (selector) => (selector === "nav.hHd-Xa_panelList" ? nav : null);
			doc.querySelectorAll = (selector) => {
				if (selector === "[data-rdsh-settings-row], .rdsh-mux-settings-row") {
					return afterNode === null ? [] : [afterNode];
				}
				if (selector === "button[aria-label], [role='menuitem']") {
					return [newSession, plugins, auto, ...(afterNode === null ? [] : [afterNode])];
				}
				if (selector === "button") return [newSession, plugins, auto];
				return [];
			};
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	const row = afterNode ?? created.find((node) => node.hasAttribute?.("data-rdsh-settings-row"));
	assert.ok(row, "the Settings row was not inserted");
	for (const control of [newSession, plugins, auto]) {
		assert.equal(control.hasAttribute("data-rdsh-hidden"), false, "a stock drawer row was hidden");
	}
	assert.equal(row.hasAttribute("data-rdsh-settings-row"), true);
	assert.equal(afterNode, row, "the row was appended instead of following Automation tasks");
	assert.equal(auto.nextElementSibling, row, "the Settings row is not the fourth visible row");
	assert.match(row.getAttribute("aria-label"), /^(?:Settings|mux\.settingsRow)$/);
	assert.deepEqual(
		[newSession, plugins, auto, row].map((control) => control.hasAttribute("data-rdsh-hidden")),
		[false, false, false, false],
		"one of the four drawer rows is hidden",
	);
	booted.disposeAll();
});

test("a localized Settings row is never mistaken for the account menu", () => {
	// Regression: COPY.ja used to render the injected row with aria-label
	// "設定", which is also one of PROBES.accountMenu. On the second decorate
	// pass `querySelector` returned that row, its parent nav was tagged with
	// `data-rdsh-more-row`, and the stylesheet hid the whole panel list (the
	// three rows collapsed to 0x0, as the QA screenshots show). The account
	// lookup must exclude the row this function just created, and must clear a
	// stale nav tag from an earlier pass.
	const frames = [];
	const nav = element();
	const footer = element();
	footer.className = "yHnPSG_anchor";
	const account = element();
	const newSession = element();
	const plugins = element();
	const auto = element();
	const createdButtons = [];
	newSession.setAttribute("aria-label", "New Session");
	plugins.setAttribute("aria-label", "Plugins");
	auto.setAttribute("aria-label", "Automation tasks");
	account.setAttribute("aria-label", "Account menu");
	account.closest = (selector) => (selector.includes("yHnPSG_anchor") ? footer : null);
	const settingsRow = () => createdButtons.find((button) => button.hasAttribute("data-rdsh-settings-row")) ?? null;
	const allButtons = () => [newSession, plugins, auto, ...(settingsRow() === null ? [] : [settingsRow()]), account];
	auto.after = (node) => {
		node.parentElement = nav;
		auto.nextElementSibling = node;
		nav.lastElementChild = node;
	};
	nav.contains = (node) => node.parentElement === nav;
	nav.querySelector = (selector) => {
		if (selector.includes('aria-label="Automation tasks"')) return auto;
		if (selector.includes('aria-label="Plugins"')) return plugins;
		if (selector === "[data-rdsh-settings-row]") return settingsRow();
		return null;
	};
	const booted = bootClient({
		narrow: true,
		frames,
		lang: "ja",
		copy: { ...COPY, ja: { ...COPY.ja, "mux.settingsRow": "設定" } },
		configureDocument(doc) {
			const create = doc.createElement;
			doc.createElement = (tag) => {
				const node = create(tag);
				if (tag === "button") createdButtons.push(node);
				return node;
			};
			doc.querySelector = (selector) => {
				if (selector === "nav.hHd-Xa_panelList") return nav;
				if (selector.includes('aria-label="Account menu"')) return settingsRow() ?? account;
				return null;
			};
			doc.querySelectorAll = (selector) => {
				if (selector === "[data-rdsh-settings-row], .rdsh-mux-settings-row") {
					return settingsRow() === null ? [] : [settingsRow()];
				}
				if (selector.includes('aria-label="Account menu"')) {
					return settingsRow() === null ? [account] : [settingsRow(), account];
				}
				if (selector === "button") return allButtons();
				if (selector === "button[aria-label], [role='menuitem']") return allButtons();
				if (selector === "[data-rdsh-more-row]") {
					return [nav, footer, ...(settingsRow() === null ? [] : [settingsRow()])]
						.filter((element) => element.hasAttribute("data-rdsh-more-row"));
				}
				return [];
			};
		},
	});
	for (let pass = 0; pass < 3; pass += 1) {
		for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
		booted.sandbox.__RDSH_MOBILE_UX__.decorate();
	}
	const row = settingsRow();
	assert.ok(row, "the Settings row was not created");
	assert.equal(row.getAttribute("aria-label"), "設定");
	assert.equal(nav.hasAttribute("data-rdsh-more-row"), false, "the nav was tagged as the account row and hidden");
	assert.equal(footer.hasAttribute("data-rdsh-more-row"), true, "the real account footer lost its hidden-row tag");
	assert.equal(auto.nextElementSibling, row, "the Settings row did not stay after Automation tasks");
	for (const control of [newSession, plugins, auto, row]) {
		assert.equal(control.hasAttribute("data-rdsh-hidden"), false, "one of the four rows is hidden");
	}
	booted.disposeAll();
});

test("re-applying the Settings row decoration never duplicates the row (#87)", () => {
	// The legacy teardown removed only `data-rdsh-settings-row` from the
	// button. The <button> stayed in the nav, the next pass found no tagged
	// row and appended another one, so every plugin re-apply (one per iOS
	// page restore) left one more Settings row.
	const nav = element();
	const newSession = element();
	const plugins = element();
	const auto = element();
	newSession.setAttribute("aria-label", "New Session");
	plugins.setAttribute("aria-label", "Plugins");
	auto.setAttribute("aria-label", "Automation tasks");
	const children = [newSession, plugins, auto];
	const frames = [];
	nav.lastElementChild = auto;
	nav.contains = (node) => children.includes(node);
	nav.append = (node) => {
		if (!children.includes(node)) children.push(node);
		node.parentElement = nav;
		nav.lastElementChild = node;
	};
	nav.querySelector = (selector) => {
		if (selector.includes('aria-label="Automation tasks"')) return auto;
		if (selector.includes('aria-label="Plugins"')) return plugins;
		return null;
	};
	auto.after = (node) => {
		if (!children.includes(node)) {
			const at = children.indexOf(auto);
			children.splice(at < 0 ? children.length : at + 1, 0, node);
		}
		node.parentElement = nav;
		auto.nextElementSibling = node;
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		frames,
		configureDocument(doc) {
			const create = doc.createElement;
			doc.createElement = (tag) => {
				const node = create(tag);
				if (tag === "button") {
					node.remove = () => {
						const at = children.indexOf(node);
						if (at >= 0) children.splice(at, 1);
						node.parentElement = null;
					};
				}
				return node;
			};
			doc.querySelector = (selector) => (selector === "nav.hHd-Xa_panelList" ? nav : null);
			doc.querySelectorAll = (selector) => {
				if (selector === "[data-rdsh-settings-row], .rdsh-mux-settings-row") {
					return children.filter((node) => node.hasAttribute("data-rdsh-settings-row")
						|| String(node.className).includes("rdsh-mux-settings-row"));
				}
				if (selector === "[data-rdsh-more-row]") return children.filter((node) => node.hasAttribute("data-rdsh-more-row"));
				if (selector === "button") return children;
				if (selector === "button[aria-label], [role='menuitem']") return children;
				return [];
			};
		},
	});
	// Three stock rows are in the nav; everything else appended to it is an
	// injected Settings row, tagged or not.
	const rowCount = () => children.length - 3;
	const settle = () => {
		for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	};
	settle();
	assert.equal(rowCount(), 1, "the first apply did not inject exactly one row");

	// A legacy teardown: clearOwnedAttribute was applied to the row attribute.
	// The node itself survived, so the next pass must adopt it, not duplicate.
	for (const node of children) node.removeAttribute("data-rdsh-settings-row");
	booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(rowCount(), 1, "an attribute-only teardown left a duplicate row");

	// A full dispose + apply cycle, twice.
	for (let cycle = 0; cycle < 2; cycle += 1) {
		booted.disposeAll();
		assert.equal(rowCount(), 0, `dispose ${cycle + 1} left the injected row behind`);
		booted.plugin.apply(booted.ctx);
		settle();
		assert.equal(rowCount(), 1, `re-apply ${cycle + 1} duplicated the Settings row`);
	}

	// Guard: the row is a node, not an attribute cleanup hook.
	const hooks = CLIENT.match(/const PHONE_HOOKS = \[([\s\S]*?)\n    \];/);
	assert.ok(hooks, "PHONE_HOOKS exists");
	assert.doesNotMatch(hooks[1], /"data-rdsh-settings-row"/, "the Settings row tag is back in the attribute cleanup list");
});

test("tapping Plugins or Automation tasks closes the phone drawer, never a desktop sidebar", () => {
	// Both rows open a full-screen route. On a phone the drawer must leave the
	// screen; on a desktop-width window the stock sidebar is not ours to close.
	assert.equal(drawerClosedAfterTapping("Plugins"), true, "Plugins left the drawer open");
	assert.equal(drawerClosedAfterTapping("Automation tasks"), true, "Automation tasks left the drawer open");
	assert.equal(drawerClosedAfterTapping("Plugins", { narrow: false, mode: "desktop" }), false, "a desktop sidebar was closed");
	assert.equal(drawerClosedAfterTapping("Automation tasks", { narrow: false, mode: "desktop" }), false, "a desktop sidebar was closed");
	// Reviewed ja labels for the same two folded rows.
	assert.equal(drawerClosedAfterTapping("プラグイン"), true, "ja Plugins left the drawer open");
	assert.equal(drawerClosedAfterTapping("自動化タスク"), true, "ja Automation tasks left the drawer open");
	assert.equal(drawerClosedAfterTapping("プラグイン", { narrow: false, mode: "desktop" }), false, "a desktop ja sidebar was closed");
	assert.equal(drawerClosedAfterTapping("自動化タスク", { narrow: false, mode: "desktop" }), false, "a desktop ja sidebar was closed");
	// Existing rows keep their behaviour.
	assert.equal(drawerClosedAfterTapping("New session"), true);
	assert.equal(drawerClosedAfterTapping("Settings"), false);
});

test("a left-edge swipe opens the drawer even when it starts on a route row", () => {
	const windowHandlers = [];
	const documentHandlers = [];
	const open = element();
	let presses = 0;
	open.click = () => {
		presses += 1;
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		windowAdd: (type, handler) => windowHandlers.push([type, handler]),
		windowRemove() {},
		configureDocument(doc) {
			doc.addEventListener = (type, handler) => documentHandlers.push([type, handler]);
			doc.querySelector = (selector) => (selector.includes("Open sidebar") ? open : null);
		},
	});
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];
	const start = handler("touchstart", "onEdgeSwipeStart");
	const move = handler("touchmove", "onEdgeSwipeMove");
	assert.equal(typeof start, "function");
	assert.equal(typeof move, "function");
	const touch = (x) => ({ cancelable: true, preventDefault() {}, touches: [{ clientX: x, clientY: 420 }] });
	const RouteRow = booted.sandbox.Element;
	const row = new RouteRow();
	row.closest = (selector) => (selector.includes("button") ? {} : null);

	// x=8 is inside the route's full-width row. A rightward drag must still
	// become the drawer gesture rather than being rejected by the button guard.
	start({ touches: [{ clientX: 8, clientY: 420 }], target: row });
	move(touch(120));
	assert.equal(presses, 1, "the route row swallowed the left-edge swipe");

	// A non-edge start over the same row keeps the old button rule.
	start({ touches: [{ clientX: 200, clientY: 420 }], target: row });
	move(touch(320));
	assert.equal(presses, 1, "a non-edge button swipe opened the drawer");
	booted.disposeAll();
});

test("closeDrawer clears a stale open attribute when the route has no frame", () => {
	const booted = bootClient({
		narrow: true,
		configureDocument(doc) {
			doc.getElementById = () => null;
			doc.querySelector = () => null;
		},
	});
	booted.sandbox.document.documentElement.setAttribute("data-rdsh-drawer", "open");
	booted.sandbox.__RDSH_MOBILE_UX__.closeDrawer();
	assert.equal(booted.sandbox.document.documentElement.getAttribute("data-rdsh-drawer"), "closed");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__.state.drawerOpen, false);
	booted.disposeAll();
});

test("a route heading is tagged for the FAB inset only on a phone route", () => {
	const frames = [];
	const center = element();
	const wrapper = element();
	const heading = element();
	heading.parentElement = wrapper;
	heading.closest = () => null;
	heading.getBoundingClientRect = () => ({ x: 24, y: 30, top: 30, left: 24, width: 153, height: 28, right: 177, bottom: 58 });
	center.querySelectorAll = (selector) => (selector === "h1" ? [heading] : []);
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			doc.querySelector = (selector) => {
				if (selector === "[data-rdsh-center-col]") return center;
				if (selector === "[data-rdsh-conversation]") return null;
				return null;
			};
			doc.querySelectorAll = () => [];
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(wrapper.hasAttribute("data-rdsh-route-heading"), true, "the route heading was not tagged");
	booted.disposeAll();

	// The chat surface owns its own H1 (welcome card); it must not be treated
	// as a full-screen route heading.
	const chatFrames = [];
	const chatConversation = element();
	chatConversation.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 390, height: 844, right: 390, bottom: 844 });
	const chatHeading = element();
	const chatWrapper = element();
	chatHeading.parentElement = chatWrapper;
	chatHeading.closest = () => null;
	chatHeading.getBoundingClientRect = () => ({ x: 24, y: 300, top: 300, left: 24, width: 200, height: 28, right: 224, bottom: 328 });
	center.querySelectorAll = (selector) => (selector === "h1" ? [chatHeading] : []);
	const chat = bootClient({
		narrow: true,
		frames: chatFrames,
		configureDocument(doc) {
			doc.querySelector = (selector) => {
				if (selector === "[data-rdsh-center-col]") return center;
				if (selector === "[data-rdsh-conversation]") return chatConversation;
				return null;
			};
			doc.querySelectorAll = () => [];
		},
	});
	for (let index = 0; index < 10 && chatFrames.length > 0; index += 1) chatFrames.shift()();
	assert.equal(chatWrapper.hasAttribute("data-rdsh-route-heading"), false, "a chat H1 was tagged as a route heading");
	chat.disposeAll();

	// Desktop is untouched: it builds nothing, so a marker left by the earlier
	// boot in this process has to be cleared by the test, not by the plugin.
	wrapper.removeAttribute("data-rdsh-route-heading");
	const wideFrames = [];
	const wide = bootClient({
		narrow: false,
		frames: wideFrames,
		configureDocument(doc) {
			doc.querySelector = (selector) => {
				if (selector === "[data-rdsh-center-col]") return center;
				if (selector === "[data-rdsh-conversation]") return null;
				return null;
			};
			doc.querySelectorAll = (selector) => (selector === "[data-rdsh-route-heading]" ? [wrapper] : []);
		},
	});
	for (let index = 0; index < 10 && wideFrames.length > 0; index += 1) wideFrames.shift()();
	assert.equal(wrapper.hasAttribute("data-rdsh-route-heading"), false, "a desktop route heading was tagged");
	wide.disposeAll();
});

/**
 * Boot a phone or a desktop against a full-screen route's detail.
 *
 * The stub records the nodes the client creates, so the back button is the
 * element whose class is `rdsh-mux-route-back` and its click runs the handler
 * the plugin registered (the plain stub swallows listeners). `crumb` is the
 * upstream plugin breadcrumb, found in the detail the same way the client does.
 */
function detailBoot({ mode = "mobile", narrow = true, container = null, page = null, crumb = null } = {}) {
	const frames = [];
	const created = [];
	const booted = bootClient({
		mode,
		narrow,
		frames,
		configureDocument(doc) {
			doc.createElement = () => {
				const node = element();
				const listeners = new Map();
				node.addEventListener = (type, handler) => listeners.set(type, handler);
				node.click = () => listeners.get("click")?.();
				created.push(node);
				return node;
			};
			doc.querySelector = (selector) => (selector === '[data-testid="task-manager-page"]' ? page : null);
			if (container !== null) {
				container.querySelectorAll = (selector) => (selector === 'button[class*="_crumb"]' && crumb !== null ? [crumb] : []);
			}
			doc.querySelectorAll = (selector) => {
				if (selector === "[data-plugin-detail], [data-plugin-item-detail], [data-plugin-row-detail]") return container === null ? [] : [container];
				if (selector === "[data-rdsh-route-detail]") {
					const marked = [container, page].filter((node) => node !== null && node.hasAttribute("data-rdsh-route-detail"));
					return marked;
				}
				return [];
			};
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	const back = created.find((node) => node.className === "rdsh-mux-route-back") ?? null;
	return { booted, back };
}

/** A laid-out box, so the route predicates see the node as on screen. */
const laidOutRect = (x, y, width, height) => () => ({ x, y, top: y, left: x, width, height, right: x + width, bottom: y + height });

test("a plugin detail retires the drawer button and leaves its breadcrumb free", () => {
	const container = element();
	container.getBoundingClientRect = laidOutRect(24, 0, 342, 667);
	const crumb = element();
	crumb.setAttribute("class", "X_2TxG_crumb");
	crumb.setAttribute("aria-label", "Back to plugins");
	crumb.getBoundingClientRect = laidOutRect(24, 28, 82, 20);
	const { booted, back } = detailBoot({ container, crumb });
	assert.equal(container.getAttribute("data-rdsh-route-detail"), "detail", "the plugin detail was not marked");
	assert.equal(back?.hasAttribute("data-visible"), false, "a plugin detail got the task detail's back button");
	booted.disposeAll();
});

test("a task detail whose list is gone gets a back button that closes it", () => {
	const page = element();
	page.getBoundingClientRect = laidOutRect(0, 0, 390, 844);
	const listPane = element();
	// Upstream hides the list below 760px: a 0x0 box is the signal.
	listPane.getBoundingClientRect = laidOutRect(0, 0, 0, 0);
	const detailPane = element();
	detailPane.getBoundingClientRect = laidOutRect(0, 0, 390, 844);
	detailPane.parentElement = page;
	const close = element();
	close.setAttribute("aria-label", "Close details");
	close.getBoundingClientRect = laidOutRect(354, 8, 28, 28);
	close.parentElement = detailPane;
	let closes = 0;
	close.click = () => {
		closes += 1;
	};
	page.children = [listPane, detailPane];
	page.querySelectorAll = (selector) => (selector === "button[aria-label]" ? [close] : []);

	const { booted, back } = detailBoot({ page });
	assert.equal(page.getAttribute("data-rdsh-route-detail"), "back", "the task detail was not marked for the back button");
	assert.equal(back?.hasAttribute("data-visible"), true, "the task detail got no back button");
	back.click();
	assert.equal(closes, 1, "the back button did not press the detail's own close control");

	// The detail closes: the marker and the button go with it.
	page.querySelectorAll = () => [];
	booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(page.hasAttribute("data-rdsh-route-detail"), false, "the marker outlived the detail");
	assert.equal(back.hasAttribute("data-visible"), false, "the back button outlived the detail");
	booted.disposeAll();
});

test("a task detail with the list still beside it keeps the stock layout", () => {
	const page = element();
	page.getBoundingClientRect = laidOutRect(0, 0, 1024, 844);
	const listPane = element();
	listPane.getBoundingClientRect = laidOutRect(0, 0, 542, 844);
	const detailPane = element();
	detailPane.getBoundingClientRect = laidOutRect(542, 0, 482, 844);
	detailPane.parentElement = page;
	const close = element();
	close.setAttribute("aria-label", "Close details");
	close.getBoundingClientRect = laidOutRect(988, 8, 28, 28);
	close.parentElement = detailPane;
	page.children = [listPane, detailPane];
	page.querySelectorAll = (selector) => (selector === "button[aria-label]" ? [close] : []);

	const { booted, back } = detailBoot({ page, narrow: false });
	assert.equal(page.hasAttribute("data-rdsh-route-detail"), false, "a two-pane task page was treated as a detail-only screen");
	assert.equal(back?.hasAttribute("data-visible"), false, "a two-pane task page got a back button");
	booted.disposeAll();
});

test("a desktop boot builds no route back control", () => {
	const container = element();
	container.getBoundingClientRect = laidOutRect(24, 0, 342, 667);
	const { booted, back } = detailBoot({ mode: "desktop", narrow: false, container });
	assert.equal(back, null, "a desktop boot created the route back button");
	assert.equal(container.hasAttribute("data-rdsh-route-detail"), false, "a desktop boot wrote the route detail marker");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__, undefined, "a desktop boot built the mobile half");
});

test("boot records this page's push origin so a restart cannot double-fan-out", () => {
	const urls = [];
	const booted = bootClient({
		mode: "mobile",
		fetchImpl: (url) => {
			urls.push(String(url));
			return Promise.resolve(stub());
		},
	});
	assert.ok(
		urls.some((url) => url.endsWith("api/dsh-mobile-maxxing/push/config")),
		`boot did not call the push config route: ${JSON.stringify(urls)} ${JSON.stringify(booted.sandbox.__RDSH_MOBILE_UX__?.state?.bootError)}`,
	);
	booted.disposeAll();
});

test("mobile-send carries the page origin so the host can route the turn back", () => {
	const calls = [];
	const booted = bootClient({
		narrow: true,
		fetchImpl: (url, options) => {
			calls.push({ url: String(url), body: options?.body });
			return Promise.resolve(stub());
		},
	});
	booted.sandbox.location = { origin: "https://app.example:8446", href: "https://app.example:8446/" };
	booted.sandbox.window.location = booted.sandbox.location;
	booted.sandbox.__RDSH_MOBILE_UX__.markMobileSession("session-1", "request-1");
	const call = calls.find((entry) => entry.url.endsWith("api/dsh-mobile-maxxing/push/mobile-send"));
	assert.ok(call, "mobile-send was not called");
	assert.deepEqual(JSON.parse(call.body), { sessionId: "session-1", requestId: "request-1", origin: "https://app.example:8446" });
	booted.disposeAll();
});

test("conversation submits only after the matching notification marker resolves", async () => {
	const calls = [];
	let finishMark;
	const booted = bootClient({ mode: "mobile", narrow: true, fetchImpl(url, options) {
		if (!String(url).endsWith("/push/mobile-send")) return Promise.resolve(stub());
		calls.push(JSON.parse(options.body));
		return new Promise((resolve) => { finishMark = resolve; });
	} });
	booted.sandbox.location = { origin: "https://app.example", href: "https://app.example/" };
	let promptCalls = 0;
	class Session {
		#value = 42;
		get sessionId() { return "s1"; }
		beginSubmission() { assert.equal(this.#value, 42); return { requestId: "rpc-1" }; }
		prompt(_content, _mode, _signal, id) { assert.equal(this.#value, 42); promptCalls++; return Promise.resolve(id); }
	}
	const conversation = { async sendSession(session) { const submission = session.beginSubmission(); return session.prompt([], "queue", undefined, submission.requestId); } };
	const original = conversation.sendSession;
	const dispose = booted.sandbox.__RDSH_MOBILE_UX__.installConversationMarking(conversation);
	const submitted = conversation.sendSession(new Session());
	assert.equal(promptCalls, 0);
	assert.deepEqual(calls, [{ sessionId: "s1", requestId: "rpc-1", origin: "https://app.example" }]);
	finishMark({ ok: true });
	assert.equal(await submitted, "rpc-1");
	assert.equal(promptCalls, 1);
	dispose();
	assert.equal(conversation.sendSession, original);
	booted.disposeAll();
});

test("a failed marker never blocks the user's prompt", async () => {
	const booted = bootClient({ mode: "mobile", narrow: true, fetchImpl(url) {
		return String(url).endsWith("/push/mobile-send") ? Promise.reject(new Error("offline")) : Promise.resolve(stub());
	} });
	const conversation = { sendSession: (session) => session.prompt([], "queue", undefined, "rpc-2") };
	const dispose = booted.sandbox.__RDSH_MOBILE_UX__.installConversationMarking(conversation);
	const result = await conversation.sendSession({ sessionId: "s1", prompt: () => Promise.resolve("sent") });
	assert.equal(result, "sent");
	dispose(); booted.disposeAll();
});

test("a timed-out marker still allows prompt submission", async () => {
	const booted = bootClient({ mode: "mobile", narrow: true, schedule: (fn) => setTimeout(fn, 0), fetchImpl(url, options) {
		if (!String(url).endsWith("/push/mobile-send")) return Promise.resolve(stub());
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
	} });
	const conversation = { sendSession: (session) => session.prompt([], "queue", undefined, "rpc-timeout") };
	const dispose = booted.sandbox.__RDSH_MOBILE_UX__.installConversationMarking(conversation);
	assert.equal(await conversation.sendSession({ sessionId: "s1", prompt: () => Promise.resolve("sent") }), "sent");
	dispose(); booted.disposeAll();
});

/**
 * A module table for the notification path.
 *
 * `Toast` and `createRoot` record what the banner renders; `state.primitives`
 * can be switched to `"missing"` or `"no-toast"` after boot to model an older
 * shell without changing the module tables the rest of the bundle needs.
 */
function noticeRequire(state) {
	return (name) => {
		if (name === "react") {
			return {
				createElement: (type, props) => ({ type, props }),
				useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
				useEffect: () => {},
				useRef: () => ({ current: null }),
				useMemo: (factory) => factory(),
				useCallback: (factory) => factory,
				Fragment: "fragment",
			};
		}
		if (name === "@deepseek-ai/dsh-client-ui-primitives") {
			if (state.primitives === "missing") throw new Error("Cannot find module '@deepseek-ai/dsh-client-ui-primitives'");
			if (state.primitives === "no-toast") return {};
			return { Toast: function Toast() {} };
		}
		if (name === "react-dom/client") {
			return {
				createRoot: () => ({
					render: (node) => {
						state.renders.push(node);
						// React runs the banner's effect once it commits; the
						// hand-off answer and the host ACK both wait for that.
						node?.props?.onCommit?.();
					},
				}),
			};
		}
		return stub();
	};
}

/**
 * Boot the client with a captured service-worker listener and a banner module
 * table, then offer `send()` to deliver one message the way the worker does.
 */
function bootWorkerMessages({ visible = true, services = {} } = {}) {
	const state = { primitives: "ok", renders: [], acks: [], appended: [], warnings: [] };
	const messages = [];
	const navigator = {
		onLine: true,
		userAgent: "test",
		serviceWorker: {
			addEventListener(type, handler) {
				if (type === "message") messages.push(handler);
			},
			removeEventListener() {},
			getRegistration: async () => undefined,
			controller: null,
		},
	};
	const booted = bootClient({
		mode: "mobile",
		navigator,
		services,
		requireImpl: noticeRequire(state),
		log: { ...console, warn: (...args) => state.warnings.push(args) },
		configureDocument(doc) {
			doc.visibilityState = visible ? "visible" : "hidden";
			doc.body.append = (...nodes) => state.appended.push(...nodes);
		},
	});
	// No audio in the sandbox: soundContext() would otherwise build an instance
	// of the empty AudioContext stub and playNoticeSound would throw.
	booted.sandbox.AudioContext = undefined;
	const send = (data) => {
		const event = { data, ports: [{ postMessage: (message) => state.acks.push(message) }] };
		for (const handler of messages) handler(event);
	};
	return { ...booted, state, send };
}

test("a notification hand-off from the current or old worker name renders one banner and acks", () => {
	for (const type of ["dsh-mobile-maxxing:notify", "rdsh-pwa:notify"]) {
		const booted = bootWorkerMessages();
		booted.send({ type, title: "Session A", body: "Turn finished", sessionId: "s1", kind: "turn-end" });
		assert.deepEqual(booted.state.acks, ["shown"], type + " was not acknowledged exactly once");
		assert.equal(booted.state.renders.length, 1, type + " did not render exactly one banner");
		assert.equal(booted.state.renders[0].props.toastProps?.text, "Session A — Turn finished");
		const host = booted.state.appended.find((node) => node.getAttribute?.("data-rdsh-notice-host") === "");
		assert.ok(host, "the banner host was not attached to the body");
		assert.deepEqual(booted.state.warnings, [], "a shown banner warned");
		booted.disposeAll();
	}
});

test("a finished task plays the softer three-note completion sound", () => {
  const { booted, notice, markSend } = localNoticeHarness({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const frequencies = [];
  booted.sandbox.AudioContext = class {
    currentTime = 0;
    state = "running";
    destination = {};
    createOscillator() { return { type: "", frequency: { setValueAtTime(value) { frequencies.push(value); } }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
  markSend("s1");
  notice.emitLocalNotices(new Map([["s1", { running: true }]]), new Map([["s1", { running: false }]]), { "s1": { title: "Done" } });
  assert.deepEqual(frequencies, [659.25, 783.99, 987.77]);
  markSend("child");
  notice.emitLocalNotices(new Map([["child", { running: true }]]), new Map([["child", { running: false }]]), { child: { origin: "subagent", parentId: "s1" } });
  notice.emitLocalNotices(new Map([["unknown", { running: true }]]), new Map([["unknown", { running: false }]]), null);
  notice.onWorkerMessage({ data: { type: "dsh-mobile-maxxing:notify", sessionId: "child", kind: "turn-end", title: "Child" } });
  assert.deepEqual(frequencies, [659.25, 783.99, 987.77], "child and unverified completion must stay silent");
  booted.disposeAll();
});

test("a hidden page takes no hand-off and logs the skip once", () => {
	for (const type of ["dsh-mobile-maxxing:notify", "rdsh-pwa:notify"]) {
		const booted = bootWorkerMessages({ visible: false });
		const message = { type, title: "Session A", body: "", sessionId: "", kind: "notice" };
		booted.send(message);
		booted.send(message);
		assert.deepEqual(booted.state.acks, [], type + " was acknowledged while hidden");
		assert.equal(booted.state.renders.length, 0, type + " rendered a banner while hidden");
		assert.equal(booted.state.warnings.length, 1, type + " was skipped silently or logged repeatedly");
		assert.match(String(booted.state.warnings[0][0]), /page is not visible/);
		booted.disposeAll();
	}
});

test("a banner that cannot render says why once and does not ack", () => {
	for (const primitives of ["missing", "no-toast"]) {
		const booted = bootWorkerMessages();
		booted.state.primitives = primitives;
		const message = { type: "rdsh-pwa:notify", title: "Session A", body: "", sessionId: "", kind: "notice" };
		booted.send(message);
		booted.send(message);
		assert.deepEqual(booted.state.acks, [], primitives + " was acknowledged without a banner");
		assert.equal(booted.state.renders.length, 0, primitives + " rendered a banner");
		assert.equal(booted.state.warnings.length, 1, primitives + " was not explained exactly once");
		assert.match(
			String(booted.state.warnings[0][0]),
			primitives === "missing" ? /primitives are unavailable/ : /no Toast primitive/,
		);
		booted.disposeAll();
	}
});

test("the current and both previous open-session names still open the session", () => {
	const opened = [];
	const booted = bootWorkerMessages({ services: { uiWorkspace: { openSession: (id) => opened.push(id) } } });
	booted.send({ type: "dsh-notify-push:open-session", sessionId: "push" });
	booted.send({ type: "rdsh-pwa:open-session", sessionId: "old" });
	booted.send({ type: "dsh-mobile-maxxing:open-session", sessionId: "new" });
	assert.deepEqual(opened, ["push", "old", "new"], "a previous worker's tap was ignored");
	assert.deepEqual(booted.state.acks, [], "a tap was acknowledged as a notification");
	assert.equal(booted.state.renders.length, 0, "a tap rendered a banner");
	booted.disposeAll();
});

test("the queue dock gets stable hooks for the compact/attached row UI", () => {
	const frames = [];
	const dock = element();
	const panel = element();
	const row = element();
	const preview = element();
	preview.textContent = "  A fixed queued message  ";
	dock.querySelector = (selector) => (selector === '[class*="_panel"]' ? panel : null);
	dock.querySelectorAll = (selector) => (selector === "li" ? [row] : []);
	row.querySelector = (selector) => (selector === '[class*="_preview"]' ? preview : null);
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			doc.querySelector = (selector) => (selector === "[data-queue-dock]" ? dock : null);
			doc.querySelectorAll = () => [];
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(dock.hasAttribute("data-rdsh-queue-dock"), true);
	assert.equal(panel.hasAttribute("data-rdsh-queue-panel"), true);
	assert.equal(row.hasAttribute("data-rdsh-queue-row"), true);
	assert.equal(preview.hasAttribute("data-rdsh-queue-preview"), true);
	assert.equal(preview.getAttribute("data-rdsh-queue-text"), "A fixed queued message");
	assert.equal(preview.getAttribute("tabindex"), "0");
	booted.disposeAll();
});

test("the queue bridge paints the queue ::before colour and tears down", () => {
	const QUEUE = "rgba(67, 69, 74, 0.45)";
	const COMPOSER = "rgb(255, 255, 255)";
	const style = () => ({
		setProperty(name, value) { this[name] = value; },
		removeProperty(name) {
			delete this[name];
			delete this[String(name).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
		},
		getPropertyValue(name) { return this[name] ?? ""; },
	});
	const tracked = (tag) => {
		const node = element();
		node.tagName = tag.toUpperCase();
		node.children = [];
		node.append = (...items) => {
			for (const item of items) {
				item._parent = node;
				node.children.push(item);
			}
		};
		node.replaceChildren = (...items) => {
			node.children = [];
			node.append(...items);
		};
		node.remove = () => {
			if (node._parent === undefined) return;
			node._parent.children = node._parent.children.filter((child) => child !== node);
			node._parent = undefined;
		};
		return node;
	};
	const fixture = () => {
		const card = element();
		card.style = style();
		card.setAttribute("data-qa-composer", "keep");
		card.getBoundingClientRect = () => ({ x: 16, y: 700, top: 700, left: 16, right: 374, bottom: 796, width: 358, height: 96 });
		const editor = element();
		editor.closest = (selector) => (String(selector).includes("_card") ? card : null);
		const panel = tracked("div");
		panel.style = style();
		panel.getBoundingClientRect = () => ({ x: 16, y: 600, top: 600, left: 16, right: 374, bottom: 701, width: 358, height: 101 });
		const parent = element();
		parent.getBoundingClientRect = () => ({ x: 16, y: 500, top: 500, left: 16, right: 374, bottom: 600, width: 358, height: 100 });
		const dock = tracked("div");
		dock.style = style();
		dock.parentElement = parent;
		dock.getBoundingClientRect = () => ({ x: 16, y: 500, top: 500, left: 16, right: 374, bottom: 600, width: 358, height: 100 });
		dock.querySelector = (selector) => {
			const text = String(selector);
			if (text.includes("_panel")) return panel;
			if (text.includes("data-rdsh-queue-join")) return dock.children.find((child) => child.hasAttribute("data-rdsh-queue-join")) ?? null;
			return null;
		};
		dock.querySelectorAll = () => [];
		return { card, editor, panel, parent, dock };
	};
	const boot = (mode) => {
		const frames = [];
		const nodes = fixture();
		const booted = bootClient({
			mode,
			narrow: mode === "mobile",
			frames,
			computedStyle(node, pseudo) {
				if (node === nodes.panel && pseudo === "::before") return { backgroundColor: QUEUE };
				if (node === nodes.panel) return { backgroundColor: "rgba(0, 0, 0, 0)" };
				if (node === nodes.card) return { backgroundColor: COMPOSER, borderTopLeftRadius: "24px", borderTopRightRadius: "24px" };
				if (node === nodes.parent) return { rowGap: "6px" };
				return stub();
			},
			configureDocument(doc) {
				doc.querySelector = (selector) => {
					const text = String(selector);
					if (text.includes("data-composer-input")) return nodes.editor;
					if (text.includes("data-queue-dock")) return nodes.dock;
					return null;
				};
				doc.querySelectorAll = (selector) => {
					const text = String(selector);
					if (text === "[data-rdsh-queue-join]") return nodes.dock.children.filter((child) => child.hasAttribute("data-rdsh-queue-join"));
					if (text === "[data-rdsh-queue-dock]") return [nodes.dock];
					return [];
				};
				doc.createElementNS = (_namespace, tag) => tracked(tag);
			},
		});
		for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
		return { booted, nodes };
	};

	const mobile = boot("mobile");
	const bridge = mobile.nodes.dock.children.find((child) => child.hasAttribute("data-rdsh-queue-join"));
	assert.ok(bridge, "the mobile queue bridge was not created");
	assert.ok(bridge.children.length > 0, "the bridge has no corner paths");
	for (const path of bridge.children) assert.equal(path.getAttribute("fill"), QUEUE, "the bridge used the composer colour instead of the queue ::before colour");
	assert.equal(mobile.nodes.dock.style.marginBottom, "-7px", "the measured seam was not applied");
	assert.equal(mobile.nodes.card.getAttribute("data-qa-composer"), "keep", "the composer attribute changed");
	for (const property of ["background", "backgroundColor", "borderTopLeftRadius", "borderTopRightRadius", "clipPath"]) {
		assert.equal(mobile.nodes.card.style[property], undefined, `the bridge mutated the composer ${property}`);
	}

	mobile.booted.disposeAll();
	assert.equal(mobile.nodes.dock.children.includes(bridge), false, "dispose kept the bridge node");
	assert.equal(mobile.nodes.dock.style.marginBottom, undefined, "dispose kept the seam margin");

	const desktop = boot("desktop");
	assert.equal(desktop.nodes.dock.children.some((child) => child.hasAttribute("data-rdsh-queue-join")), false, "a desktop got the queue bridge");
	assert.equal(desktop.nodes.dock.style.marginBottom, undefined, "a desktop got the seam margin");
	desktop.booted.disposeAll();
});

test("device-local display projects font/locale and restores the Host snapshots", async () => {
	const writes = [];
	const hostTheme = {
		preference: "system",
		revision: 4,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
		setFontSize(role, px) { writes.push(["font", role, px]); },
	};
	const listeners = new Set();
	const hostLocale = {
		active: "zh",
		revision: 2,
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
		],
	};
	const locale = {
		snapshot: hostLocale,
		listeners,
		getSnapshot() { return this.snapshot; },
		getLocale() { return this.snapshot; },
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		setLocale(id) { writes.push(["locale", id]); },
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		locale,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: {
			"rdsh-mobile-ux:local-display": JSON.stringify({
				fonts: { text: 18, code: 13, terminal: 15 },
				language: "en",
			}),
		},
	});
	const state = booted.sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(state.localDisplay.fonts.text, 18);
	assert.equal(state.localDisplay.language, "en");
	assert.equal(theme.snapshot.fontSizes.text, 18, "the local font size was not projected");
	assert.equal(theme.snapshot.fontSizes.code, 13);
	assert.equal(theme.snapshot.fontSizes.terminal, 15);
	// The sidebar terminal subscribes to theme/change and reads
	// theme.fontSizes.terminal (#66): the projected snapshot must reach it.
	const terminalEvent = booted.emitted.find((entry) => entry.event === "theme/change"
		&& entry.payload?.fontSizes?.terminal === 15);
	assert.ok(terminalEvent, "the terminal font size did not ride theme/change");
	assert.equal(locale.snapshot.active, "en", "the local locale was not projected");
	assert.equal(booted.sandbox.document.documentElement.lang, "en");
	assert.deepEqual(writes, [], "a shared Host writer was called");

	// A Host sync must not win over the device-local projection.
	booted.emit("theme/change", {
		...hostTheme,
		revision: 8,
		fontSizes: { text: 20, code: 12, terminal: 14 },
	});
	booted.emit("locale/change", { ...hostLocale, active: "zh", revision: 6 });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(theme.snapshot.fontSizes.text, 18, "the Host theme overwrote the local size");
	assert.equal(locale.snapshot.active, "en", "the Host locale overwrote the local choice");
	assert.deepEqual(writes, [], "a Host sync caused a shared write");

	booted.disposeAll();
	assert.equal(theme.snapshot.fontSizes.text, 20, "the latest Host theme was not restored");
	assert.equal(locale.snapshot.active, "zh", "the Host locale was not restored");
	assert.equal(booted.sandbox.document.documentElement.lang, "zh-CN");
	assert.deepEqual(writes, [], "dispose wrote a shared setting");
});

test("device-local projections keep Host revisions so rows keep updating (#73/#64)", async () => {
	const writes = [];
	const hostTheme = {
		preference: "system",
		revision: 4,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
		setTheme(id) { writes.push(["theme", id]); },
		setFontSize(role, px) { writes.push(["font", role, px]); },
	};
	const listeners = new Set();
	const hostLocale = {
		active: "zh",
		revision: 2,
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
		],
	};
	const locale = {
		snapshot: hostLocale,
		listeners,
		getSnapshot() { return this.snapshot; },
		getLocale() { return this.snapshot; },
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		setLocale(id) { writes.push(["locale", id]); },
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		locale,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const state = api.state;
	// Upstream Appearance/font and Language row stores mirror the Host snapshot
	// and ignore a revision that is not newer than the one they stored.
	const rows = {
		themeRevision: hostTheme.revision,
		fontSizes: hostTheme.fontSizes,
		localeRevision: hostLocale.revision,
		active: hostLocale.active,
	};
	booted.ctx.on("theme/change", (snapshot) => {
		if (snapshot === null || snapshot === undefined || snapshot.revision <= rows.themeRevision) return;
		rows.themeRevision = snapshot.revision;
		rows.fontSizes = snapshot.fontSizes;
	});
	listeners.add(() => {
		const snapshot = locale.getSnapshot();
		if (snapshot === null || snapshot === undefined || snapshot.revision <= rows.localeRevision) return;
		rows.localeRevision = snapshot.revision;
		rows.active = snapshot.active;
	});
	// The mounted terminal reads theme.getTheme() through its snapshot
	// subscription; locale consumers read LocaleFace getSnapshot().
	const terminal = { rendered: theme.getTheme(), fonts: [] };
	booted.ctx.on("theme/change", () => {
		queueMicrotask(() => {
			const snapshot = theme.getTheme();
			if (snapshot === terminal.rendered) return;
			terminal.rendered = snapshot;
			terminal.fonts.push(snapshot.fontSizes.text);
		});
	});
	const localeReads = [];
	locale.subscribe(() => {
		localeReads.push(locale.getSnapshot());
	});

	// Drive the same applyTheme/applyLocale path the local controls use.
	state.localDisplay.fonts = { text: 19, code: 12, terminal: 16 };
	state.localDisplay.fontsLocal = true;
	booted.emit("theme/change", theme.getTheme());
	state.localDisplay.language = "en";
	booted.emit("locale/change", locale.getSnapshot());
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(theme.snapshot.fontSizes.text, 19, "the local font size was not projected");
	assert.equal(theme.snapshot.revision, hostTheme.revision, "the font projection inflated the Host revision");
	assert.notEqual(theme.snapshot, hostTheme, "the font projection reused the Host identity");
	assert.equal(locale.snapshot.active, "en", "the local language was not projected");
	// A projected locale view carries a boxed identity token whose numeric value
	// is still the Host revision; row stores compare the number, reader caches
	// compare the identity.
	assert.equal(Number(locale.snapshot.revision), hostLocale.revision, "the locale projection inflated the Host revision");
	assert.notEqual(locale.snapshot.revision, hostLocale.revision, "the locale projection kept the Host revision identity");
	assert.notEqual(locale.snapshot, hostLocale, "the locale projection reused the Host identity");
	assert.equal(booted.sandbox.document.documentElement.lang, "en");
	assert.deepEqual(terminal.fonts, [19], "the local font projection did not reach the mounted terminal");
	assert.equal(localeReads.at(-1)?.active, "en", "the local language did not reach locale readers");
	assert.equal(rows.themeRevision, hostTheme.revision, "the font projection was adopted by the row stores");
	assert.equal(rows.localeRevision, hostLocale.revision, "the locale projection was adopted by the row store");
	assert.equal(rows.fontSizes.text, 14, "the shared font row stopped showing the Host value");
	assert.equal(rows.active, "zh", "the shared language row stopped showing the Host value");

	// A later Host theme and locale snapshot with ordinary revisions must land,
	// while the device-local font and language survive.
	const nextTheme = { ...hostTheme, revision: 5, fontSizes: { text: 20, code: 12, terminal: 14 } };
	theme.snapshot = nextTheme;
	booted.emit("theme/change", nextTheme);
	const nextLocale = { ...hostLocale, revision: 3, active: "zh" };
	locale.snapshot = nextLocale;
	booted.emit("locale/change", nextLocale);
	for (const listener of [...listeners]) listener();
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(rows.themeRevision, 5, "the font rows froze after a device-local projection");
	assert.equal(rows.fontSizes.text, 20, "the font rows did not take the Host snapshot");
	assert.equal(theme.snapshot.fontSizes.text, 19, "the Host theme change reverted the device-local font");
	assert.equal(theme.snapshot.revision, 5, "the Host revision was left inflated");
	assert.equal(rows.localeRevision, 3, "the language row froze after a device-local projection");
	assert.equal(rows.active, "zh", "the language row did not take the Host snapshot");
	assert.equal(locale.snapshot.active, "en", "the Host locale change reverted the device-local language");
	assert.equal(Number(locale.snapshot.revision), 3, "the Host locale revision was left inflated");
	assert.equal(localeReads.at(-1)?.active, "en", "locale readers lost the local language after a Host change");

	// "System" restores the Host language.
	state.localDisplay.language = "";
	booted.emit("locale/change", nextLocale);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(locale.snapshot, nextLocale, "resetting the local language did not restore the Host snapshot");
	assert.equal(localeReads.at(-1)?.active, "zh", "locale readers kept the local language after reset");
	assert.equal(booted.sandbox.document.documentElement.lang, "zh-CN");
	assert.equal(rows.active, "zh");

	// #79's terminal repaint must keep the device-local fonts and revision.
	api.writeTerminalDark(true);
	assert.equal(theme.snapshot.fontSizes.text, 19, "terminal dark reverted the device-local font");
	assert.equal(theme.snapshot.revision, nextTheme.revision, "terminal dark inflated the Host revision");
	api.writeTerminalDark(false);
	assert.equal(theme.snapshot.fontSizes.text, 19, "terminal dark off reverted the device-local font");
	assert.equal(theme.snapshot.revision, nextTheme.revision, "terminal dark off inflated the Host revision");

	assert.deepEqual(writes, [], "a shared Host writer was called");
	booted.disposeAll();
	assert.equal(theme.snapshot, nextTheme, "dispose did not restore the latest Host theme");
	assert.equal(locale.snapshot, nextLocale, "dispose did not restore the latest Host locale");
	assert.deepEqual(writes, [], "dispose wrote a shared setting");
});

test("every accepted terminal size reaches theme/change (#66)", () => {
	for (const terminal of [10, 13, 20]) {
		const hostTheme = {
			preference: "system",
			revision: 3,
			fontSizes: { text: 14, code: 11, terminal: 13 },
			fontFamilies: { text: "", code: "", terminal: "" },
			active: { id: "light", colorScheme: "light", tokens: {} },
			themes: [],
		};
		const theme = {
			snapshot: hostTheme,
			getTheme() { return this.snapshot; },
			setFontSize() { throw new Error("the shared font writer was called"); },
		};
		const booted = bootClient({
			mode: "mobile",
			narrow: true,
			theme,
			storage: {
				"rdsh-mobile-ux:local-display": JSON.stringify({
					fonts: { text: 16, code: 12, terminal },
					language: "",
				}),
			},
		});
		assert.equal(booted.sandbox.__RDSH_MOBILE_UX__.state.localDisplay.fonts.terminal, terminal);
		assert.equal(theme.snapshot.fontSizes.terminal, terminal, `terminal ${terminal} was not projected`);
		const event = booted.emitted.find((entry) => entry.event === "theme/change"
			&& entry.payload?.fontSizes?.terminal === terminal);
		assert.ok(event, `terminal ${terminal} did not reach the terminal's theme subscription`);
		assert.equal(event.payload.fontSizes.text, 16);
		booted.disposeAll();
	}
});

test("terminal-only dark is off by default, device-local and asks for a terminal repaint (#79)", () => {
	const writes = [];
	const hostTheme = {
		preference: "system",
		revision: 4,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
		setTheme(id) { writes.push(["theme", id]); },
		setFontSize(role, px) { writes.push(["font", role, px]); },
	};
	const booted = bootClient({ mode: "mobile", narrow: true, theme, storage: {} });
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	const key = "rdsh-mobile-ux:terminal-dark";
	assert.equal(api.state.terminalDark, false, "the preference defaults to off");
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), false, "the scoped palette was painted by default");
	assert.equal(booted.sandbox.localStorage.getItem(key), null, "a default boot wrote storage");

	const observed = [];
	booted.ctx.on("theme/change", (snapshot) => observed.push(snapshot));
	api.writeTerminalDark(true);
	assert.equal(api.state.terminalDark, true);
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true, "the scoped palette was not painted");
	assert.equal(booted.sandbox.localStorage.getItem(key), "1", "the choice was not stored locally");
	assert.ok(observed.length > 0, "no theme/change was sent for the terminal to reread");
	const repaint = observed[observed.length - 1];
	assert.equal(repaint.active, hostTheme.active, "the repaint changed the shared tokens");
	assert.equal(repaint.preference, hostTheme.preference, "the repaint changed the shared preference");
	assert.deepEqual(repaint.fontSizes, hostTheme.fontSizes, "the repaint changed the shared fonts");
	assert.equal(repaint.revision, hostTheme.revision,
		"the repaint fabricated a revision the Appearance/font row stores would adopt");
	assert.deepEqual(writes, [], "a shared theme writer was called");

	api.writeTerminalDark(false);
	assert.equal(api.state.terminalDark, false);
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), false, "turning off left the scoped palette");
	assert.equal(booted.sandbox.localStorage.getItem(key), null, "turning off left the stored choice");
	assert.equal(observed.length, 2, "turning off did not ask the terminal to reread");
	assert.deepEqual(writes, [], "turning off called a shared theme writer");
	booted.disposeAll();
});

test("a terminal-dark repaint keeps the device-local font projection (#79)", () => {
	const hostTheme = {
		preference: "light",
		revision: 3,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
		setFontSize() { throw new Error("the shared font writer was called"); },
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		storage: {
			"rdsh-mobile-ux:local-display": JSON.stringify({
				fonts: { text: 17, code: 13, terminal: 16 },
				language: "",
			}),
		},
	});
	assert.equal(theme.snapshot.fontSizes.text, 17);
	assert.equal(theme.snapshot.fontSizes.code, 13);
	assert.equal(theme.snapshot.fontSizes.terminal, 16);
	booted.sandbox.__RDSH_MOBILE_UX__.writeTerminalDark(true);
	assert.equal(theme.snapshot.fontSizes.text, 17, "the terminal repaint dropped the device-local font sizes");
	assert.equal(theme.snapshot.fontSizes.code, 13, "the terminal repaint dropped the device-local font sizes");
	assert.equal(theme.snapshot.fontSizes.terminal, 16, "the terminal repaint dropped the device-local font sizes");
	booted.sandbox.__RDSH_MOBILE_UX__.writeTerminalDark(false);
	assert.equal(theme.snapshot.fontSizes.text, 17, "turning terminal dark off reverted the device-local font sizes");
	assert.equal(theme.snapshot.fontSizes.code, 13, "turning terminal dark off reverted the device-local font sizes");
	assert.equal(theme.snapshot.fontSizes.terminal, 16, "turning terminal dark off reverted the device-local font sizes");
	booted.disposeAll();
	assert.equal(theme.snapshot.fontSizes.text, 14, "dispose did not restore the Host font sizes");
	assert.equal(theme.snapshot.fontSizes.code, 11, "dispose did not restore the Host font sizes");
	assert.equal(theme.snapshot.fontSizes.terminal, 13, "dispose did not restore the Host font sizes");
});

test("terminal-dark repaints keep Host revisions so later rows still update (#79)", async () => {
	const hostTheme = {
		preference: "light",
		revision: 4,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
		setTheme(id) { throw new Error("the shared theme writer was called: " + id); },
		setFontSize(role, px) { throw new Error("the shared font writer was called: " + role + " " + px); },
	};
	let documentElement;
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		computedStyle: () => ({
			backgroundColor: documentElement.hasAttribute("data-rdsh-terminal-dark") ? "#151517" : "#f9fafb",
			color: documentElement.hasAttribute("data-rdsh-terminal-dark") ? "#f9fafb" : "#1b1b1c",
		}),
		configureDocument(doc) {
			documentElement = doc.documentElement;
		},
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	// Upstream Appearance/font row stores mirror the Host snapshot and ignore a
	// revision that is not newer than the one they stored.
	const rows = {
		revision: hostTheme.revision,
		preference: hostTheme.preference,
		fontSizes: hostTheme.fontSizes,
	};
	booted.ctx.on("theme/change", (snapshot) => {
		if (snapshot === null || snapshot === undefined || snapshot.revision <= rows.revision) return;
		rows.revision = snapshot.revision;
		rows.preference = snapshot.preference;
		rows.fontSizes = snapshot.fontSizes;
	});
	// A mounted terminal subscribes through the theme store's getSnapshot and
	// reruns getComputedStyle only when the rendered snapshot object changed.
	const terminal = { rendered: theme.getTheme(), repaints: 0, backgrounds: [] };
	booted.ctx.on("theme/change", () => {
		queueMicrotask(() => {
			const snapshot = theme.getTheme();
			if (snapshot === terminal.rendered) return;
			terminal.rendered = snapshot;
			terminal.repaints += 1;
			terminal.backgrounds.push(booted.sandbox.getComputedStyle(documentElement).backgroundColor);
		});
	});

	api.writeTerminalDark(true);
	await Promise.resolve();
	assert.equal(terminal.repaints, 1, "turning terminal dark on did not repaint the mounted terminal");
	assert.deepEqual(terminal.backgrounds, ["#151517"], "the terminal did not reread the dark surface");
	assert.equal(theme.snapshot.revision, hostTheme.revision, "the repaint inflated the Host revision");
	assert.equal(rows.revision, hostTheme.revision, "the repaint was adopted by the row stores");

	api.writeTerminalDark(false);
	await Promise.resolve();
	assert.equal(terminal.repaints, 2, "turning terminal dark off did not repaint the mounted terminal");
	assert.deepEqual(terminal.backgrounds, ["#151517", "#f9fafb"], "the terminal did not reread the light surface");
	assert.equal(theme.snapshot.revision, hostTheme.revision, "turning terminal dark off left an inflated revision");
	assert.equal(rows.revision, hostTheme.revision, "the repaint was adopted by the row stores");

	// A later Host theme change with an ordinary revision must still land.
	const nextTheme = {
		...hostTheme,
		revision: hostTheme.revision + 1,
		preference: "dark",
		active: { id: "dark", colorScheme: "dark", tokens: {} },
	};
	theme.snapshot = nextTheme;
	booted.emit("theme/change", nextTheme);
	await Promise.resolve();
	assert.equal(rows.revision, nextTheme.revision, "the Appearance row froze after a terminal-dark toggle");
	assert.equal(rows.preference, "dark", "the Appearance row kept the stale preference");

	// A later Host font snapshot must still reach the font row store.
	const fontTheme = {
		...nextTheme,
		revision: nextTheme.revision + 1,
		fontSizes: { text: 18, code: 12, terminal: 15 },
	};
	theme.snapshot = fontTheme;
	booted.emit("theme/change", fontTheme);
	await Promise.resolve();
	assert.equal(rows.revision, fontTheme.revision, "the font rows froze after a terminal-dark toggle");
	assert.deepEqual(rows.fontSizes, fontTheme.fontSizes, "the font rows kept the stale Host sizes");
	assert.equal(theme.snapshot.revision, fontTheme.revision, "the Host revision stayed inflated");
	assert.equal(theme.snapshot.fontSizes.text, 18, "the Host font snapshot did not land");
	booted.disposeAll();
});

test("a saved terminal-dark choice survives reload and a Host theme change (#79)", async () => {
	const hostTheme = {
		preference: "light",
		revision: 2,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
		setTheme(id) { throw new Error(`shared theme writer called: ${id}`); },
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		storage: { "rdsh-mobile-ux:terminal-dark": "1" },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(api.state.terminalDark, true, "the stored choice was not read");
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true, "the stored choice was not painted");
	assert.notEqual(theme.snapshot, hostTheme, "the stored choice sent no repaint at boot");
	assert.equal(theme.snapshot.active, hostTheme.active, "the boot repaint changed the shared tokens");
	assert.equal(theme.snapshot.revision, hostTheme.revision, "the boot repaint inflated the Host revision");

	const nextHost = {
		...hostTheme,
		revision: 20,
		fontSizes: { text: 16, code: 12, terminal: 14 },
		active: { id: "dark", colorScheme: "dark", tokens: {} },
	};
	booted.emit("theme/change", nextHost);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(api.state.terminalDark, true, "a Host theme change dropped the local choice");
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true, "a Host theme change removed the scoped palette");
	assert.equal(theme.snapshot, nextHost, "the Host snapshot was not adopted after a shared theme change");
	booted.disposeAll();
});

test("disposing terminal dark restores the Host snapshot and stops reapplying it (#79)", () => {
	const hostTheme = {
		preference: "light",
		revision: 1,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		storage: { "rdsh-mobile-ux:terminal-dark": "1" },
	});
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true);
	assert.notEqual(theme.snapshot, hostTheme, "the test did not start from a projected snapshot");
	booted.disposeAll();
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), false, "dispose left the scoped palette");
	assert.equal(theme.snapshot, hostTheme, "dispose did not restore the Host snapshot");
	booted.emit("theme/change", { ...hostTheme, revision: 99 });
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), false, "a later theme change repainted after dispose");
});

test("without a usable theme pathway the terminal is not half-painted (#79)", () => {
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		storage: { "rdsh-mobile-ux:terminal-dark": "1" },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(api.state.terminalDark, true, "the saved choice was not read");
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), false,
		"the scoped background was painted without the theme repaint path");
	api.writeTerminalDark(true);
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), false,
		"turning on painted a terminal that cannot reread its palette");
	booted.disposeAll();
});

test("a saved terminal-dark choice never wakes the desktop half (#79)", () => {
	const booted = bootClient({
		mode: "desktop",
		storage: { "rdsh-mobile-ux:terminal-dark": "1" },
	});
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__, undefined, "the desktop built the mobile half");
	assert.equal(booted.sandbox.document.documentElement.hasAttribute("data-rdsh-terminal-dark"), false,
		"the desktop painted the mobile terminal palette");
	assert.equal(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:terminal-dark"), "1",
		"the desktop rewrote the saved choice");
});

/**
 * A locale service with the public language-pack API and a recording catalog.
 *
 * `addLanguage` and its disposer mirror `LocaleRuntime.publishCatalog`:
 * they publish the *resolved* Host active (so a removed language falls back
 * before the mobile reads the snapshot) and notify the LocaleFace listeners.
 * The real runtime emits `locale/change` before those listeners for an
 * active switch (same frozen snapshot object); this fake only notifies the
 * listeners, and a test emits the event itself when the order matters.
 * `register` mirrors the runtime republishing `this.snapshot.active`, which
 * a device-local projection can have replaced.
 *
 * `hostSelect` is a Host switch that publishes (setLocale); `silentHostSelect`
 * is the durable preference change `LocaleRuntime.adopt` makes without a
 * publish when the resolved active already equals `snapshot.active` (the
 * device projection), so no locale/change is emitted at all. `resolveActive`
 * mirrors the runtime's pure durable-preference resolver; `withResolver:
 * false` models an older runtime that does not expose it, while the catalog
 * publish still uses the same internal resolution.
 */
function localeService({ locales = [
	{ id: "zh", label: "中文", fallback: "en" },
	{ id: "en", label: "English" },
], active = "zh", withResolver = true } = {}) {
	const registered = [];
	const removed = [];
	const listeners = new Set();
	let catalog = [...locales];
	/** The Host's own selection; catalog changes re-resolve to this value. */
	let hostActive = active;
	/** LocaleRuntime.resolveActive, also used by the catalog publish. */
	const resolveHostActive = () => {
		if (catalog.some((entry) => entry.id === hostActive)) return hostActive;
		return catalog.some((entry) => entry.id === "en") ? "en" : (catalog[0]?.id ?? "");
	};
	/** Every Host-originated snapshot, kept to prove none carries a local token. */
	const initial = Object.freeze({ active, revision: 2, locales: Object.freeze([...locales]) });
	const hostSnapshots = [initial];
	const publish = (localeActive) => {
		// LocaleRuntime.publish: this.snapshot.revision + 1. A projected boxed
		// token must coerce to the Host number and publish a primitive again.
		const revision = service.snapshot.revision + 1;
		const snapshot = Object.freeze({
			active: localeActive,
			revision,
			locales: Object.freeze([...catalog]),
		});
		hostSnapshots.push(snapshot);
		service.snapshot = snapshot;
		for (const listener of [...listeners]) listener();
	};
	const service = {
		snapshot: initial,
		listeners,
		getSnapshot() { return this.snapshot; },
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** LocaleRuntime.resolveActive: durable preference, else provisional. */
		resolveActive() {
			return resolveHostActive();
		},
		addLanguage(input) {
			registered.push({ kind: "language", input: { ...input } });
			catalog = [...catalog, input];
			publish(resolveHostActive());
			return () => {
				removed.push("language");
				catalog = catalog.filter((entry) => entry.id !== input.id);
				publish(resolveHostActive());
			};
		},
		/** Test-only Host selection that publishes: the caller emits locale/change. */
		hostSelect(id) {
			hostActive = id;
			publish(id);
		},
		/** Test-only silent durable Host switch (`adopt` early return, no event). */
		silentHostSelect(id) {
			hostActive = id;
		},
		register(namespace, lang, dictionary) {
			registered.push({ kind: "dictionary", namespace, lang, keys: Object.keys(dictionary).length });
			publish(service.snapshot.active);
			return () => {
				removed.push(`${namespace}:${lang}`);
				publish(service.snapshot.active);
			};
		},
		setLocale() { throw new Error("the shared locale writer was called"); },
	};
	if (!withResolver) delete service.resolveActive;
	return { service, registered, removed, hostSnapshots };
}

test("a phone lists only the shared catalog and never adds ja itself (#64/#80)", () => {
	const { service, registered, removed } = localeService();
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const state = booted.sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(state.localDisplay.available.language, true);
	assert.deepEqual(state.localDisplay.languages.map((entry) => entry.id), ["zh", "en"],
		"the picker invented a language the catalog does not have");
	assert.equal(state.localDisplay.language, "", "a stored ja was accepted without an owner");
	assert.deepEqual(registered, [], "the mobile package registered a locale definition");
	booted.disposeAll();
	assert.deepEqual(removed, [], "the mobile package removed a locale definition it never owned");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en"]);
});

test("a separately installed ja owner appears in the picker and survives mobile dispose (#80)", () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service, registered, removed } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
	});
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const state = booted.sandbox.__RDSH_MOBILE_UX__.state;
	assert.deepEqual(state.localDisplay.languages.map((entry) => entry.id), ["zh", "en", "ja"],
		"an owner-registered ja is missing from the picker");
	assert.equal(state.localDisplay.language, "ja", "the stored choice was not accepted from the catalog");
	assert.deepEqual(registered, [], "mobile must not duplicate the separate owner's registration");
	assert.equal(service.snapshot.active, "ja", "the device-local projection was not applied");
	const hostLocales = service.snapshot.locales;
	booted.disposeAll();
	assert.equal(service.snapshot.active, "zh", "dispose did not restore the Host language");
	assert.deepEqual(service.snapshot.locales, hostLocales, "mobile dispose removed the separate owner's ja");
	assert.deepEqual(removed, [], "mobile disposed a definition owned by the separate package");
});

/** Drain the projection microtasks the locale listeners queue. */
async function settleLocale() {
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

test("#80 mounted text and slot labels refresh on the device language without a revision bump", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
	});
	const hostRevision = Number(service.snapshot.revision);
	// Copy the upstream modules actually consult: the renderer's t seat is
	// keyed by the LocaleFace revision identity and outlets re-render through
	// useSyncExternalStore; the Settings/Plugins ledgers rebuild their slot
	// labels only when getSnapshot().revision changes. Both are mounted
	// before the device language is selected, as the conversation is.
	const copy = {
		"hero.headline": { en: "Into the Unknown", ja: "未知の世界へ" },
		"settings.general": { en: "General", ja: "一般" },
		"settings.models": { en: "Models", ja: "モデル" },
		"settings.agentPreset": { en: "Agent presets", ja: "エージェントプリセット" },
		"tab.mobile": { en: "Mobile", ja: "モバイル" },
	};
	const translate = (key) => copy[key][service.getSnapshot().active] ?? copy[key].en;
	const outlet = {
		revision: service.getSnapshot().revision,
		headline: translate("hero.headline"),
	};
	service.subscribe(() => {
		const revision = service.getSnapshot().revision;
		if (Object.is(revision, outlet.revision)) return;
		outlet.revision = revision;
		outlet.headline = translate("hero.headline");
	});
	let labels = ["Mobile", "General", "Models", "Agent presets"];
	let labelsRevision = service.getSnapshot().revision;
	let labelsSnapshot = labels;
	const readLabels = () => {
		const revision = service.getSnapshot().revision;
		if (revision !== labelsRevision) {
			labelsRevision = revision;
			labels = ["tab.mobile", "settings.general", "settings.models", "settings.agentPreset"].map(translate);
			labelsSnapshot = labels;
		}
		return labelsSnapshot;
	};
	const settings = { labels: labelsSnapshot };
	service.subscribe(() => {
		const next = readLabels();
		if (next !== settings.labels) settings.labels = next;
	});
	// The shared Language row store adopts only a numerically newer revision;
	// the #73/#64 high-water guard must not see the device projection.
	const rows = { revision: hostRevision, active: service.getSnapshot().active };
	service.subscribe(() => {
		const snapshot = service.getSnapshot();
		if (snapshot.revision <= rows.revision) return;
		rows.revision = Number(snapshot.revision);
		rows.active = snapshot.active;
	});

	assert.equal(outlet.headline, "Into the Unknown", "the test did not start mounted in English");
	assert.deepEqual(settings.labels, ["Mobile", "General", "Models", "Agent presets"]);

	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	api.setLanguage("ja");
	await settleLocale();

	assert.equal(service.snapshot.active, "ja", "the device language was not projected");
	assert.equal(outlet.headline, "未知の世界へ", "an already-mounted text outlet kept the English copy");
	assert.deepEqual(settings.labels, ["モバイル", "一般", "モデル", "エージェントプリセット"],
		"the settings slot labels were not re-resolved after the locale changed");
	assert.equal(rows.active, "zh", "the device projection was adopted by the shared language row");
	assert.equal(rows.revision, hostRevision, "the device projection moved the shared row high-water mark");
	assert.equal(Number(service.snapshot.revision), hostRevision,
		"the projection changed the Host numeric revision");
	assert.notEqual(service.snapshot.revision, hostRevision,
		"the projection reused the Host revision identity the reader caches key on");
	assert.equal(service.snapshot.revision + 1, hostRevision + 1,
		"the revision token broke numeric revision arithmetic");
	assert.equal(JSON.stringify(service.snapshot.revision), String(hostRevision),
		"the revision token changed the serialized Host revision");
	assert.equal(booted.sandbox.document.documentElement.lang, "ja");
	assert.equal(booted.emitted.some((entry) => entry.event === "locale/change"), false,
		"a fake locale/change was emitted to local or native listeners");

	// A real Host publish with an ordinary revision must still land: the token
	// must not freeze the shared row store the way the +1000 synthetic bump did.
	service.hostSelect("en");
	const hostSwitch = service.snapshot;
	booted.emit("locale/change", hostSwitch);
	await settleLocale();
	assert.equal(rows.revision, hostRevision + 1, "the row store froze after the device projection");
	assert.equal(rows.active, "en", "the row store did not take the Host switch");
	assert.equal(service.snapshot.active, "ja", "the Host switch dropped the device projection");
	assert.equal(outlet.headline, "未知の世界へ", "the device text fell back to the Host language");

	// System unprojects to the newest Host view and refreshes the same mounted
	// consumers back, without restoring through a cached English seat.
	api.setLanguage("");
	await settleLocale();
	assert.equal(service.snapshot, hostSwitch, "System did not restore the Host snapshot");
	assert.equal(outlet.headline, "Into the Unknown", "System left the mounted text in the device language");
	assert.deepEqual(settings.labels, ["Mobile", "General", "Models", "Agent presets"],
		"System left the settings labels in the device language");
	// The Host switched to en, so SEA-880's restoredDocumentLang() is en, not
	// the attach-time zh-CN.
	assert.equal(booted.sandbox.document.documentElement.lang, "en");

	// Re-select, then dispose: the same mounted consumers must follow the
	// restored Host baseline, and no shared writer may run.
	api.setLanguage("ja");
	await settleLocale();
	assert.equal(outlet.headline, "未知の世界へ");
	booted.disposeAll();
	assert.equal(service.snapshot, hostSwitch, "dispose did not restore the latest Host locale");
	assert.equal(outlet.headline, "Into the Unknown", "dispose left the mounted text in the device language");
	assert.deepEqual(settings.labels, ["Mobile", "General", "Models", "Agent presets"],
		"dispose left the settings labels in the device language");
	assert.equal(rows.active, "en", "dispose wrote the device language into the shared row");
});

/**
 * Boot under "System" with a device language list (#103).
 *
 * The locale catalog is the pack list a real install publishes; `packs`
 * lets a test model a device language no pack covers. The navigator carries
 * the fields boot() reads (service worker, UA, platform, touch count) so the
 * only variable between cases is `languages`.
 */
function bootSystemLanguage({ languages, host = "en", stored = null, docLang = "en", packs = ["en", "ja"] } = {}) {
	const labels = { en: "English", ja: "日本語" };
	const { service } = localeService({
		locales: packs.map((id) => ({ id, label: labels[id] ?? id })),
		active: host,
	});
	const serviceWorkerPrototype = {
		register: () => Promise.resolve(undefined),
		getRegistration: async () => undefined,
	};
	const serviceWorker = Object.assign(Object.create(serviceWorkerPrototype), {
		controller: null,
		addEventListener() {},
		removeEventListener() {},
	});
	const navigator = {
		languages: [...languages],
		language: languages[0],
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		platform: "iPhone",
		maxTouchPoints: 5,
		standalone: false,
		onLine: true,
		serviceWorker,
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		navigator,
		storage: stored === null ? {} : { "rdsh-mobile-ux:local-display": JSON.stringify(stored) },
		configureDocument(doc) { doc.documentElement.lang = docLang; },
	});
	return { booted, service };
}

test("a ja device under System follows the device language, not the Host en (#103)", () => {
	const { booted, service } = bootSystemLanguage({ languages: ["ja-JP", "en-US"], host: "en" });
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	assert.equal(api.state.localDisplay.language, "", "System was stored as a concrete language");
	assert.equal(api.state.localDisplay.languages.map((entry) => entry.id).join(","), "en,ja",
		"the picker lost a language pack");
	assert.equal(service.snapshot.active, "ja", "the device language was not projected");
	assert.equal(booted.sandbox.document.documentElement.lang, "ja",
		"the document language does not match the projected language");
	assert.equal(api.lang, "ja", "the mobile copy stayed on the Host language");
	assert.equal(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:local-display"), null,
		"System wrote a device language to storage");
	booted.disposeAll();
	assert.equal(service.snapshot.active, "en", "dispose did not restore the Host language");
	assert.equal(booted.sandbox.document.documentElement.lang, "en",
		"dispose left the document language projected");
});

test("an en device keeps en even when the shared Host preference is ja (#103)", () => {
	const { booted, service } = bootSystemLanguage({ languages: ["en-US"], host: "ja", docLang: "ja" });
	assert.equal(service.snapshot.active, "en", "the device en lost to the Host ja");
	assert.equal(booted.sandbox.document.documentElement.lang, "en");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__.lang, "en");
	booted.disposeAll();
	assert.equal(service.snapshot.active, "ja", "dispose did not restore the Host ja");
	assert.equal(booted.sandbox.document.documentElement.lang, "ja");
});

test("an unsupported device language falls back to the Host language (#103)", () => {
	const unsupported = bootSystemLanguage({ languages: ["fr-FR", "fr"], host: "en" });
	const hostSnapshot = unsupported.service.snapshot;
	assert.equal(hostSnapshot.active, "en", "the Host baseline changed");
	assert.equal(unsupported.booted.sandbox.document.documentElement.lang, "en",
		"an unsupported device language reached the document");
	assert.equal(unsupported.booted.sandbox.__RDSH_MOBILE_UX__.lang, "en");
	assert.equal(unsupported.service.snapshot, hostSnapshot,
		"an unsupported device language installed a projection");
	unsupported.booted.disposeAll();

	// ja is a device language with no pack in this catalog: same fallback.
	const noPack = bootSystemLanguage({ languages: ["ja-JP"], host: "en", packs: ["en"] });
	assert.equal(noPack.service.snapshot.active, "en", "a device language without a pack was projected");
	assert.equal(noPack.booted.sandbox.document.documentElement.lang, "en");
	noPack.booted.disposeAll();
});

test("an explicit language choice always beats the device language (#103)", () => {
	const jaDevice = bootSystemLanguage({
		languages: ["ja-JP", "en-US"],
		host: "en",
		stored: { language: "en" },
	});
	assert.equal(jaDevice.booted.sandbox.__RDSH_MOBILE_UX__.state.localDisplay.language, "en");
	assert.equal(jaDevice.service.snapshot.active, "en", "the stored en lost to the device ja");
	assert.equal(jaDevice.booted.sandbox.document.documentElement.lang, "en");
	assert.equal(jaDevice.booted.sandbox.__RDSH_MOBILE_UX__.lang, "en");
	jaDevice.booted.disposeAll();

	const enDevice = bootSystemLanguage({
		languages: ["en-US"],
		host: "en",
		stored: { language: "ja" },
	});
	assert.equal(enDevice.booted.sandbox.__RDSH_MOBILE_UX__.state.localDisplay.language, "ja");
	assert.equal(enDevice.service.snapshot.active, "ja", "the stored ja lost to the device en");
	assert.equal(enDevice.booted.sandbox.document.documentElement.lang, "ja");
	enDevice.booted.disposeAll();
});

test("returning to System re-applies the device language (#103)", async () => {
	const { booted, service } = bootSystemLanguage({ languages: ["ja-JP", "en-US"], host: "en" });
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	assert.equal(service.snapshot.active, "ja", "the device language was not projected at boot");

	api.setLanguage("en");
	await settleLocale();
	assert.equal(service.snapshot.active, "en", "an explicit en was not projected");
	assert.equal(booted.sandbox.document.documentElement.lang, "en");

	api.setLanguage("");
	await settleLocale();
	assert.equal(service.snapshot.active, "ja", "System did not return to the device language");
	assert.equal(booted.sandbox.document.documentElement.lang, "ja");
	assert.equal(api.state.localDisplay.language, "", "System kept the explicit language in the picker");
	assert.equal(JSON.parse(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:local-display")).language, "",
		"resetting to System wrote a concrete language");
	booted.disposeAll();
	assert.equal(service.snapshot.active, "en", "dispose did not restore the Host language");
});

test("#80 the local revision token stays inside the rc.2 LocaleFace compatibility boundary", async () => {
	const MARKER = Symbol.for("rdsh-mobile-ux:local-display-revision");
	const PROJECTION = Symbol.for("rdsh-mobile-ux:local-display-projection");
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service, hostSnapshots } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
	});
	const originalHost = service.snapshot;
	const hostRevision = originalHost.revision;
	assert.equal(typeof hostRevision, "number", "the Host baseline did not start primitive");
	assert.equal(hostRevision, 2);

	// The actual rc.2 consumers only compare by identity, order by number, or
	// do arithmetic. None performs a typeof/Number.isInteger type gate:
	// - renderer localeSeat()/slots locale cache: cached.revision === revision
	// - ui-settings-general/plugins ledgers: revision !== storedRevision
	// - locale Language row store: revision <= d.revision (high-water guard)
	// - LocaleRuntime.publish: revision + 1
	let seatRevision = hostRevision;
	let labelRevision = hostRevision;
	let slotRevision = hostRevision;
	const rows = { revision: hostRevision, active: originalHost.active };
	service.subscribe(() => {
		const snapshot = service.snapshot;
		if (snapshot.revision !== seatRevision) seatRevision = snapshot.revision;
		if (snapshot.revision !== labelRevision) labelRevision = snapshot.revision;
		if (snapshot.revision !== slotRevision) slotRevision = snapshot.revision;
		if (snapshot.revision <= rows.revision) return;
		rows.revision = snapshot.revision;
		rows.active = snapshot.active;
	});

	const booted = bootClient({ mode: "mobile", narrow: true, locale: service });
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	api.setLanguage("ja");
	await settleLocale();

	const projected = service.snapshot;
	assert.equal(projected.active, "ja");
	assert.equal(projected[PROJECTION], true, "the projection identity marker is missing");
	assert.equal(typeof projected.revision, "object", "the projection did not mint an identity token");
	assert.equal(projected.revision[MARKER], true, "the local revision token is not marked");
	assert.equal(Number(projected.revision), hostRevision, "the token changed the Host numeric revision");
	// Known limit: typeof number / Number.isInteger consumers would reject the
	// token. rc.2 has none; the four operations above accepted it.
	assert.equal(Number.isInteger(projected.revision), false);
	assert.equal(projected.revision !== hostRevision, true, "the token did not change the reader identity");
	assert.equal(seatRevision, projected.revision, "the renderer t-seat cache ignored the token");
	assert.equal(labelRevision, projected.revision, "the settings label ledger ignored the token");
	assert.equal(slotRevision, projected.revision, "the slots locale cache ignored the token");
	assert.equal(rows.revision, hostRevision, "the language row adopted the projection");
	assert.equal(rows.active, originalHost.active);

	assert.equal(projected.revision + 1, hostRevision + 1, "publish arithmetic did not see the Host number");
	assert.equal(typeof (projected.revision + 1), "number", "publish arithmetic stayed boxed");
	assert.equal(JSON.stringify(projected.revision), String(hostRevision), "the serialized revision changed");

	// LocaleRuntime.publish uses this.snapshot.revision + 1 and must mint a
	// primitive Host snapshot again; the shared row then takes the new number.
	service.hostSelect("en");
	const nextHost = hostSnapshots.at(-1);
	assert.equal(service.snapshot, nextHost, "the runtime did not replace the snapshot on publish");
	assert.equal(nextHost.revision, hostRevision + 1);
	assert.equal(typeof nextHost.revision, "number", "publish did not mint a primitive revision");
	assert.equal(Number.isInteger(nextHost.revision), true);
	assert.equal(nextHost[PROJECTION], undefined);
	assert.equal(nextHost.revision[MARKER], undefined);
	assert.equal(rows.revision, nextHost.revision, "the language row ignored the next Host revision");
	assert.equal(rows.active, "en");
	await settleLocale();
	assert.equal(service.snapshot.active, "ja", "the Host switch dropped the device projection");
	assert.equal(Number(service.snapshot.revision), hostRevision + 1);
	assert.equal(typeof service.snapshot.revision, "object");

	// Every Host-originated snapshot, including the original baseline, stays
	// primitive and marker-free: no token ever enters a Host baseline.
	for (const snapshot of hostSnapshots) {
		assert.equal(typeof snapshot.revision, "number", "a Host snapshot held a local token");
		assert.equal(Number.isInteger(snapshot.revision), true);
		assert.equal(snapshot[PROJECTION], undefined, "a Host snapshot carried the projection marker");
		assert.equal(snapshot.revision[MARKER], undefined, "a Host revision carried the token marker");
	}
	assert.equal(originalHost.revision, hostRevision, "the original Host baseline was mutated");

	// System restores the exact Host object and its primitive revision.
	api.setLanguage("");
	await settleLocale();
	assert.equal(service.snapshot, nextHost, "System did not restore the Host snapshot");
	assert.equal(service.snapshot.revision, nextHost.revision);
	assert.equal(typeof service.snapshot.revision, "number");
	assert.equal(service.snapshot[PROJECTION], undefined);

	// Re-project then dispose: unprojection restores the same primitive view.
	api.setLanguage("ja");
	await settleLocale();
	assert.equal(typeof service.snapshot.revision, "object");
	booted.disposeAll();
	assert.equal(service.snapshot, nextHost, "dispose did not restore the Host snapshot");
	assert.equal(service.snapshot.revision, hostRevision + 1);
	assert.equal(typeof service.snapshot.revision, "number", "dispose left a token in the Host view");
});

test("#80 an owner that activates after the mobile attach reaches the picker and keeps the stored ja", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service, registered, removed } = localeService();
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	assert.deepEqual(api.state.localDisplay.languages.map((entry) => entry.id), ["zh", "en"]);
	assert.equal(api.state.localDisplay.language, "", "ja cannot be selected before its owner exists");

	// dsh-locale-ja activates late: addLanguage publishes the catalog through
	// the LocaleFace listeners only, because the active locale stays zh.
	const releaseJa = service.addLanguage(ja);
	await settleLocale();

	assert.deepEqual(api.state.localDisplay.languages.map((entry) => entry.id), ["zh", "en", "ja"],
		"a catalog-only publish never reached the picker");
	assert.equal(api.state.localDisplay.language, "ja",
		"the stored choice was not restored when its owner arrived");
	assert.equal(service.snapshot.active, "ja", "the late catalog was not projected");
	assert.equal(Number(service.snapshot.revision), 3, "the projection inflated the Host revision");
	assert.deepEqual(registered, [{ kind: "language", input: { ...ja } }],
		"the mobile package registered a language of its own");

	// The picker can move between the late language and System afterwards.
	api.setLanguage("");
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "", "System was not selectable after the late arrival");
	assert.equal(service.snapshot.active, "zh");
	api.setLanguage("ja");
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja", "the late language was not selectable");
	assert.equal(service.snapshot.active, "ja");

	booted.disposeAll();
	assert.equal(service.snapshot.active, "zh", "dispose did not restore the Host active locale");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja"],
		"dispose dropped the externally owned ja from the restored snapshot");
	assert.equal(service.snapshot.revision, 3, "dispose changed the Host revision");
	assert.deepEqual(removed, [], "the mobile package withdrew a definition it does not own");
});

test("#80 a late owner's withdraw and re-add refresh already-mounted consumers", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService();
	// The conversation is already mounted in the Host language when the owner
	// activates, the device language is selected, withdrawn, and re-added.
	const headline = () => (service.getSnapshot().active === "ja" ? "未知の世界へ" : "Into the Unknown");
	const outlet = { revision: service.getSnapshot().revision, text: headline() };
	service.subscribe(() => {
		const revision = service.getSnapshot().revision;
		if (Object.is(revision, outlet.revision)) return;
		outlet.revision = revision;
		outlet.text = headline();
	});
	let labelsRevision = service.getSnapshot().revision;
	let labels = ["Mobile"];
	service.subscribe(() => {
		const revision = service.getSnapshot().revision;
		if (revision === labelsRevision) return;
		labelsRevision = revision;
		labels = [service.getSnapshot().active === "ja" ? "モバイル" : "Mobile"];
	});

	const booted = bootClient({ mode: "mobile", narrow: true, locale: service });
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	assert.equal(api.state.localDisplay.language, "", "the test started with a selectable language");
	assert.equal(outlet.text, "Into the Unknown");

	const releaseJa = service.addLanguage(ja);
	await settleLocale();
	api.setLanguage("ja");
	await settleLocale();
	assert.equal(service.snapshot.active, "ja");
	assert.equal(outlet.text, "未知の世界へ", "the late owner's language never reached the mounted text");
	assert.deepEqual(labels, ["モバイル"], "the late owner's language never reached the slot labels");

	releaseJa();
	await settleLocale();
	assert.equal(service.snapshot.active, "zh", "the withdrawn language was not unprojected");
	assert.equal(outlet.text, "Into the Unknown", "the withdrawn language stayed on the mounted text");
	assert.deepEqual(labels, ["Mobile"], "the withdrawn language stayed on the slot labels");

	const releaseAgain = service.addLanguage(ja);
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja", "the stored choice did not return with the owner");
	assert.equal(outlet.text, "未知の世界へ", "the re-added language did not reach the mounted text");
	assert.deepEqual(labels, ["モバイル"]);

	booted.disposeAll();
	assert.equal(service.snapshot.active, "zh", "dispose kept the device language projected");
	assert.equal(outlet.text, "Into the Unknown", "dispose left the mounted text in the device language");
	assert.deepEqual(labels, ["Mobile"]);
	releaseAgain();
});

test("#80 a withdrawn ja is unprojected without forgetting the device choice, and re-adding restores it", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService();
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const releaseJa = service.addLanguage(ja);
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja");
	assert.equal(service.snapshot.active, "ja", "the test did not start from a projection");

	releaseJa();
	await settleLocale();
	assert.deepEqual(api.state.localDisplay.languages.map((entry) => entry.id), ["zh", "en"],
		"the picker kept a language the catalog withdrew");
	assert.equal(api.state.localDisplay.language, "", "a withdrawn language stayed selected");
	assert.equal(service.snapshot.active, "zh", "the withdrawn language was not unprojected");
	assert.equal(service.snapshot.locales.some((entry) => entry.id === "ja"), false);
	assert.equal(
		JSON.parse(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:local-display")).language,
		"ja",
		"the stored device choice was discarded with the definition",
	);

	const reAdd = service.addLanguage(ja);
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja", "the stored choice did not come back with the definition");
	assert.equal(service.snapshot.active, "ja");

	booted.disposeAll();
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja"],
		"dispose dropped the external definition");
	assert.equal(service.snapshot.active, "zh");
	reAdd();
});

test("#80 disposing after the external owner withdrew ja never resurrects it", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService();
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const releaseJa = service.addLanguage(ja);
	await settleLocale();
	assert.equal(service.snapshot.active, "ja");
	releaseJa();
	await settleLocale();
	assert.equal(service.snapshot.active, "zh");

	booted.disposeAll();
	assert.equal(service.snapshot.locales.some((entry) => entry.id === "ja"), false,
		"dispose wrote a withdrawn ja back into the Host snapshot");
	assert.equal(service.snapshot.active, "zh", "dispose restored a stale active locale");
	assert.equal(service.snapshot.revision, 4, "dispose changed the Host revision");
});

test("#80 a later Host locale change keeps the device language and disposes to the newest Host view", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
	});
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		storage: {
			"rdsh-mobile-ux:local-display": JSON.stringify({
				fonts: { text: 18, code: 13, terminal: 15 },
				language: "ja",
			}),
		},
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(service.snapshot.active, "ja");

	// The Host switches to en on its own: a normal locale/change with a newer
	// revision. The device keeps ja and its font projection.
	service.hostSelect("en");
	const next = service.snapshot;
	booted.emit("locale/change", next);
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja", "the Host change won over the device choice");
	assert.equal(service.snapshot.active, "ja", "the Host change dropped the device projection");
	assert.equal(Number(service.snapshot.revision), 3, "the projection did not keep the new Host revision");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja"]);
	assert.equal(docEl.lang, "ja", "the Host change dropped the device document language");

	// "System" restores the newest Host view and forgets the remembered choice.
	api.setLanguage("");
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "", "System did not clear the device choice");
	assert.equal(service.snapshot, next, "System did not restore the Host snapshot");
	assert.equal(docEl.lang, "en", "System restored the boot document language over the Host change");

	// A catalog publish after the explicit System choice must not bring ja back.
	service.addLanguage({ id: "ko", label: "한국어", fallback: "en" });
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "", "a catalog change revived a cleared choice");

	booted.disposeAll();
	assert.equal(service.snapshot.active, "en", "dispose restored an older Host active locale");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja", "ko"]);
	assert.equal(docEl.lang, "en", "dispose restored the boot document language over the Host change");
});

test("#80 a dictionary republish while a device language is projected is not a Host active change", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
	});
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(service.snapshot.active, "ja");

	// LocaleRuntime.register republishes this.snapshot.active, which is the
	// device projection here; adopting it as the Host active would both lose
	// the shared locale and restore the device choice on dispose.
	service.register("late", "ja", { hello: "こんにちは" });
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja", "the device choice was dropped");
	assert.equal(service.snapshot.active, "ja", "the projection was lost");
	assert.equal(docEl.lang, "ja", "the store republish disturbed the document language");

	booted.disposeAll();
	assert.equal(service.snapshot.active, "zh", "the device choice was restored as the Host active locale");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja"]);
	assert.equal(docEl.lang, "zh-CN",
		"a normalised store republish was treated as a Host language change");
});

test("#80 a silent Host switch to the projected language survives System and dispose", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
	});
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(service.snapshot.active, "ja", "the test did not start from a projection");
	assert.equal(docEl.lang, "ja", "the device projection did not set the document language");

	// LocaleRuntime.adopt returns early because the resolved Host active (ja)
	// already equals the projected snapshot.active: no publish, no revision
	// bump and no locale/change. Only the runtime's durable-preference
	// resolver can see this Host switch.
	service.silentHostSelect("ja");
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja");
	assert.equal(Number(service.snapshot.revision), 2, "a silent Host switch bumped the Host revision");

	// System restores the Host's ja, not the previous zh baseline.
	api.setLanguage("");
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "", "System did not clear the device choice");
	assert.equal(service.snapshot.active, "ja", "System restored a stale Host active locale");
	assert.equal(service.snapshot.revision, 2, "System changed the Host revision");
	assert.equal(docEl.lang, "ja", "System restored the boot document language over the Host switch");

	// Re-selecting ja and disposing keeps the silent Host switch as baseline.
	api.setLanguage("ja");
	await settleLocale();
	assert.equal(docEl.lang, "ja");
	booted.disposeAll();
	assert.equal(service.snapshot.active, "ja", "dispose reverted the silent Host switch");
	assert.equal(service.snapshot.revision, 2, "dispose changed the Host revision");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja"]);
	assert.equal(docEl.lang, "ja", "dispose restored the boot document language over the Host switch");
});

test("#80 an authoritative locale/change naming the projected language is not normalised", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	// No resolver: the store heuristic is the only source, so the event
	// boundary is what keeps this authoritative switch.
	const { service } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
		withResolver: false,
	});
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(service.snapshot.active, "ja");

	// The Host switches to ja: the store notification republishes the
	// projection's active, then publish(..., true) emits the authoritative
	// locale/change with the same active and catalog.
	service.hostSelect("ja");
	const next = service.snapshot;
	booted.emit("locale/change", next);
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "ja");
	assert.equal(service.snapshot.active, "ja");
	assert.equal(Number(service.snapshot.revision), 3, "the projection inflated the Host revision");

	api.setLanguage("");
	await settleLocale();
	assert.equal(service.snapshot.active, "ja", "System restored a stale Host active locale");
	assert.equal(service.snapshot.revision, 3);
	assert.equal(docEl.lang, "ja", "System restored the boot document language over the Host switch");

	booted.disposeAll();
	assert.equal(service.snapshot.active, "ja", "dispose reverted the authoritative Host switch");
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en", "ja"]);
	assert.equal(docEl.lang, "ja", "dispose restored the boot document language over the Host switch");
});

test("#80 without the Host-active resolver a silent switch falls back to the published baseline", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService({
		locales: [
			{ id: "zh", label: "中文", fallback: "en" },
			{ id: "en", label: "English" },
			ja,
		],
		withResolver: false,
	});
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(service.snapshot.active, "ja");

	// Documented limitation: without resolveActive the module cannot see a
	// durable preference change that emitted no locale/change, so it restores
	// the last published Host baseline (zh) rather than the silent ja. The
	// document language stays the boot one because the Host active it belongs
	// to did not observably change.
	service.silentHostSelect("ja");
	await settleLocale();
	api.setLanguage("");
	await settleLocale();
	assert.equal(service.snapshot.active, "zh", "the published-baseline fallback changed its contract");
	assert.equal(docEl.lang, "zh-CN");
	booted.disposeAll();
	assert.equal(service.snapshot.active, "zh");
	assert.equal(docEl.lang, "zh-CN");
});

test("#80 an externally removed language follows the Host fallback document language", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const { service } = localeService();
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		locale: service,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: { "rdsh-mobile-ux:local-display": JSON.stringify({ language: "ja" }) },
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	const releaseJa = service.addLanguage(ja);
	await settleLocale();
	assert.equal(service.snapshot.active, "ja");
	assert.equal(docEl.lang, "ja");

	// The Host preference had moved to ja; removing ja makes the runtime
	// resolve its provisional language (en here) and publish that fallback.
	service.silentHostSelect("ja");
	await settleLocale();
	releaseJa();
	await settleLocale();
	assert.equal(api.state.localDisplay.language, "");
	assert.equal(service.snapshot.active, "en", "the Host fallback was not restored");
	assert.equal(docEl.lang, "en", "the document language did not follow the Host fallback");

	booted.disposeAll();
	assert.equal(service.snapshot.active, "en");
	assert.equal(docEl.lang, "en");
});

test("#80 a catalog publish leaves the device font projection untouched", async () => {
	const ja = { id: "ja", label: "日本語", fallback: "en" };
	const hostTheme = {
		preference: "system",
		revision: 4,
		fontSizes: { text: 14, code: 11, terminal: 13 },
		fontFamilies: { text: "", code: "", terminal: "" },
		active: { id: "light", colorScheme: "light", tokens: {} },
		themes: [],
	};
	const theme = {
		snapshot: hostTheme,
		getTheme() { return this.snapshot; },
	};
	const { service } = localeService();
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		theme,
		locale: service,
		storage: {
			"rdsh-mobile-ux:local-display": JSON.stringify({
				fonts: { text: 18, code: 13, terminal: 15 },
				language: "",
			}),
		},
	});
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	const docEl = booted.sandbox.document.documentElement;
	assert.equal(theme.snapshot.fontSizes.text, 18);
	assert.equal(api.state.localDisplay.fontsLocal, true);
	api.writeTerminalDark(true);
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true);

	service.addLanguage(ja);
	await settleLocale();
	assert.equal(theme.snapshot.fontSizes.text, 18, "the catalog publish reverted the device font");
	assert.equal(theme.snapshot.revision, hostTheme.revision, "the catalog publish inflated the theme revision");
	assert.deepEqual(api.state.localDisplay.languages.map((entry) => entry.id), ["zh", "en", "ja"]);
	assert.equal(api.state.localDisplay.language, "", "an untouched device stayed on System");
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true,
		"the catalog publish dropped the terminal-only palette");

	// A font step while the language owner is inactive keeps the stored choice.
	api.setFont("text", 1);
	assert.equal(
		JSON.parse(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:local-display")).language,
		"",
		"a font step invented a language choice",
	);
	api.resetFonts();
	assert.equal(theme.snapshot.fontSizes.text, 14);
	assert.equal(theme.snapshot.fontSizes.code, 11);
	assert.equal(theme.snapshot.fontSizes.terminal, 13);
	const saved = JSON.parse(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:local-display"));
	assert.deepEqual(saved.fonts, { text: 14, code: 11, terminal: 13 });
	assert.equal(saved.language, "");
	assert.equal(docEl.hasAttribute("data-rdsh-terminal-dark"), true);
	api.writeTerminalDark(false);
	booted.disposeAll();
	assert.equal(theme.snapshot, hostTheme);
});

test("a desktop never touches the locale catalog (#44/#80)", () => {
	const { service, registered, removed } = localeService();
	const booted = bootClient({ mode: "desktop", locale: service });
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__, undefined, "the desktop built the mobile half");
	assert.deepEqual(registered, [], "a desktop changed its locale catalog");
	booted.disposeAll();
	assert.deepEqual(removed, []);
	assert.deepEqual(service.snapshot.locales.map((entry) => entry.id), ["zh", "en"]);
});

test("without a language-pack API the picker reads the catalog without inventing ja (#80)", () => {
	const listeners = new Set();
	const noApi = {
		snapshot: {
			active: "en",
			revision: 1,
			locales: [{ id: "en", label: "English" }, { id: "zh", label: "中文" }],
		},
		listeners,
		getSnapshot() { return this.snapshot; },
	};
	const booted = bootClient({ mode: "mobile", narrow: true, locale: noApi });
	assert.deepEqual(booted.sandbox.__RDSH_MOBILE_UX__.state.localDisplay.languages.map((entry) => entry.id), ["en", "zh"]);
	booted.disposeAll();
});

test("font and language availability are independent and fail soft", () => {
	const fontTheme = {
		snapshot: { preference: "system", revision: 1, fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: {}, active: {}, themes: [] },
		getTheme() { return this.snapshot; },
		setFontSize() { throw new Error("shared font writer was called"); },
	};
	const fontOnly = bootClient({
		mode: "mobile",
		narrow: true,
		theme: fontTheme,
		storage: {
			"rdsh-mobile-ux:local-display": JSON.stringify({ fonts: { text: 20, code: 12, terminal: 14 }, language: "en" }),
		},
	});
	const fontState = fontOnly.sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(fontState.localDisplay.available.fonts, true);
	assert.equal(fontState.localDisplay.available.language, false);
	assert.equal(fontState.localDisplay.reason.language, "locale-missing");
	assert.equal(fontTheme.snapshot.fontSizes.text, 20, "fonts were not projected with only the theme service");
	fontOnly.disposeAll();

	const listeners = new Set();
	const localeOnlyService = {
		snapshot: {
			active: "zh",
			revision: 1,
			locales: [{ id: "en", label: "English" }, { id: "zh", label: "中文" }],
		},
		listeners,
		getSnapshot() { return this.snapshot; },
		getLocale() { return this.snapshot; },
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		setLocale() { throw new Error("shared locale writer was called"); },
	};
	const localeOnly = bootClient({
		mode: "mobile",
		narrow: true,
		locale: localeOnlyService,
		configureDocument(doc) { doc.documentElement.lang = "zh-CN"; },
		storage: {
			"rdsh-mobile-ux:local-display": JSON.stringify({ fonts: { text: 20, code: 12, terminal: 14 }, language: "en" }),
		},
	});
	const localeState = localeOnly.sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(localeState.localDisplay.available.fonts, false);
	assert.equal(localeState.localDisplay.available.language, true);
	assert.equal(localeState.localDisplay.reason.fonts, "theme-missing");
	assert.equal(localeOnlyService.snapshot.active, "en", "the locale was not projected with only the locale service");
	assert.equal(localeOnly.sandbox.document.documentElement.lang, "en");
	localeOnly.disposeAll();
	assert.equal(localeOnlyService.snapshot.active, "zh");
	assert.equal(localeOnly.sandbox.document.documentElement.lang, "zh-CN");
});

/**
 * Push-independent local banners.
 *
 * `__RDSH_NOTICE_TEST__` exposes the same closures the overlay watcher runs:
 * the pure status diff, the thin emit that renders through `notifyUser`, and
 * the worker-message handler that must not stack a second banner. The require
 * table is a tiny React: `createElement` keeps the props so the fake root can
 * write the banner text into the real notice host. The shipping `Toast` portals
 * into `document.body` (`div[role="alert"]`), so the fake root stands in for
 * that portal and reads the text it was handed; the commit model below is what
 * these tests are actually about.
 */
function localNoticeHarness({
	endpoint = "",
	initialVisibility = "visible",
	subscriptionGate = null,
	commits = "auto",
	onlyMobileTurns = undefined,
	pushTest = "ok",
	notification = null,
	storage = null,
	recoverEndpoint = "",
	subscribeStatuses = [],
	subscribeGate = null,
} = {}) {
	const rendered = [];
	const roots = [];
	const ackPosts = [];
	const testPushes = [];
	const subscribePosts = [];
	const windowHandlers = new Map();
	let activeEndpoint = endpoint;
	let subscribeAttempts = 0;
	let latestBanner = null;
	let lastKey = null;
	let mountedOnce = false;
	// What React does after the render it was handed: run the effect. The
	// default fakes a real commit; "manual" keeps the banner uncommitted until
	// the test asks, which is the only way to assert that an ACK waits for it.
	const commitNode = (node) => {
		const onCommit = node?.props?.onCommit;
		if (typeof onCommit === "function") onCommit();
	};
	const registration = {
		update: async () => {},
		addEventListener() {},
		removeEventListener() {},
		pushManager: {
			getSubscription: async () => {
				if (subscriptionGate !== null) await subscriptionGate;
				// A real PushSubscription serializes itself for /subscribe.
				if (activeEndpoint === "") return null;
				const value = activeEndpoint;
				return { endpoint: value, toJSON: () => ({ endpoint: value }), unsubscribe: async () => { activeEndpoint = ""; return true; } };
			},
			subscribe: async () => {
				subscribeAttempts++;
				if (subscribeGate !== null) await subscribeGate;
				if (recoverEndpoint === "") throw new Error("no recovery endpoint");
				activeEndpoint = recoverEndpoint;
				return { endpoint: activeEndpoint, toJSON: () => ({ endpoint: activeEndpoint }), unsubscribe: async () => { activeEndpoint = ""; return true; } };
			},
		},
	};
	const react = {
		// React takes `key` out of the props and keeps it on the element.
		createElement: (type, props) => {
			const { key, ...rest } = props ?? {};
			return { type, props: rest, key };
		},
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useRef: (initial) => ({ current: initial }),
	};
	const booted = bootClient({
		mode: "mobile",
		narrow: true,
		lang: "en",
		copy: COPY,
		navigator: {
			onLine: true,
			serviceWorker: {
				ready: Promise.resolve(registration),
				getRegistration: async () => registration,
				register: async () => registration,
				addEventListener() {},
				removeEventListener() {},
			},
		},
		globals: {
			__RDSH_NOTICE_TEST__: {},
			atob: (value) => Buffer.from(value, "base64").toString("binary"),
			location: { origin: "https://app.example:8446", href: "https://app.example:8446/" },
		},
		notification,
		storage,
		windowAdd: (type, handler) => windowHandlers.set(type, handler),
		windowRemove: (type, handler) => { if (windowHandlers.get(type) === handler) windowHandlers.delete(type); },
		fetchImpl: async (url, options) => {
			const target = String(url);
			if (target.endsWith("/push/ack")) ackPosts.push({ url: target, options });
			if (target.endsWith("/push/subscribe")) {
				subscribePosts.push({ url: target, options });
				const status = subscribeStatuses.shift() ?? 200;
				return { status, ok: status >= 200 && status < 300, json: async () => ({ ok: status === 200, count: 1 }) };
			}
			if (target.endsWith("/push/vapid")) return { status: 200, ok: true, json: async () => ({ publicKey: "AQ" }) };
			if (target.endsWith("/push/config")) {
				// The real route answers with the host's copy, which carries
				// onlyMobileTurns. An absent key is the host default (true).
				return {
					status: 200,
					ok: true,
					json: async () => ({ ok: true, copy: onlyMobileTurns === undefined ? {} : { onlyMobileTurns } }),
				};
			}
			if (target.endsWith("/push/test")) {
				testPushes.push({ url: target, options });
				if (pushTest === "fail") {
					return { status: 200, ok: true, json: async () => ({ ok: false, results: [{ status: 410, error: "gone" }] }) };
				}
				return { status: 200, ok: true, json: async () => ({ ok: true }) };
			}
			return { status: 200, ok: true, json: async () => ({ ok: true }) };
		},
		configureDocument(doc) { doc.visibilityState = initialVisibility; },
		requireImpl(name) {
			if (name === "react") return react;
			if (name === "react-dom/client") {
				return {
					createRoot(container) {
						roots.push(container);
						return {
							render(node) {
								if (node === null || node === undefined) {
									latestBanner = null;
									container.textContent = "";
									return;
								}
								const props = node.props ?? {};
								const key = node.key ?? null;
								const mounted = !mountedOnce || key !== lastKey;
								mountedOnce = true;
								lastKey = key;
								latestBanner = node;
								rendered.push(props.toastProps?.text ?? props.text ?? "");
								container.textContent = rendered[rendered.length - 1];
								// Only a fresh mount runs the wrapper's effect again.
								if (commits === "auto" && mounted) commitNode(node);
							},
						};
					},
				};
			}
			if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Toast: function Toast() {} };
			return stub();
		},
	});
	const notice = booted.sandbox.__RDSH_NOTICE_TEST__?.notice;
	assert.ok(notice, "the local notice test seam was not installed");
	const api = booted.sandbox.__RDSH_MOBILE_UX__;
	return {
		booted,
		notice,
		rendered,
		roots,
		ackPosts,
		testPushes,
		subscribePosts,
		windowHandlers,
		get subscribeAttempts() { return subscribeAttempts; },
		get activeEndpoint() { return activeEndpoint; },
		api,
		// A turn this browser sent is the one the host will route back to it.
		markSend: (sessionId) => api.markMobileSession(sessionId),
		flushCommits: () => {
			if (latestBanner !== null) commitNode(latestBanner);
		},
	};
}

test("a finished root turn raises one local banner and push does not stack", () => {
	const { booted, notice, rendered, roots, markSend } = localNoticeHarness();
	const byId = { "root-1": { title: "Main" } };
	const running = new Map([["root-1", { running: true }]]);
	const idle = new Map([["root-1", { running: false }]]);

	// The very first render has no baseline and must stay silent.
	notice.emitLocalNotices(null, running, byId);
	assert.equal(rendered.length, 0, "the baseline render raised a banner");

	markSend("root-1");
	notice.emitLocalNotices(running, idle, byId);
	assert.equal(rendered.length, 1, "a finished root turn raised no banner");
	assert.equal(rendered[0], "Main — The work finished.", "title and body reached the toast");
	assert.equal(roots.length, 1, "one banner root");
	assert.equal(roots[0].getAttribute("data-rdsh-notice-host"), "", "the banner rendered into the notice host");
	assert.equal(roots[0].textContent, "Main — The work finished.", "the notice host carries the banner text");

	// The worker's hand-off for the same event arrives inside the 4s window.
	notice.onWorkerMessage({
		data: { type: "dsh-mobile-maxxing:notify", title: "Main", body: "done", sessionId: "root-1", kind: "turn-end" },
	});
	assert.equal(rendered.length, 1, "the push hand-off stacked a second banner");
	booted.disposeAll();
});

test("badge counts only known root sessions, never children or unknowns", () => {
  const { booted, notice } = localNoticeHarness();
  const statuses = new Map([["root", { completionUnread: true }], ["forked", { completionUnread: true }], ["child", { completionUnread: true }], ["child2", { pendingInteraction: { kind: "question" } }], ["unknown", { completionUnread: true }]]);
  const byId = { root: { title: "Root" }, forked: { parentId: "previous-root" }, child: { origin: "subagent" }, child2: { origin: "subagent", parentId: "root" } };
  assert.equal(notice.countSessionStatuses(statuses, notice.rootSessionIds(byId)), 2);
  assert.equal(notice.countSessionStatuses(statuses, notice.rootSessionIds(null)), 0);
  booted.disposeAll();
});

test("a forked root with parentId still emits a completion notice", () => {
  const { booted, notice, rendered, markSend } = localNoticeHarness();
  const byId = { root: { parentId: "previous-root", title: "Forked root" } };
  markSend("root");
  notice.emitLocalNotices(new Map([["root", { running: true }]]), new Map([["root", { running: false }]]), byId);
  assert.deepEqual(rendered, ["Forked root — The work finished."]);
  booted.disposeAll();
});

test("a subagent turn end and a first render raise no local banner", () => {
	const { booted, notice, rendered } = localNoticeHarness();
	const byId = { "child-1": { origin: "subagent", parentId: "root", title: "Child" } };
	const running = new Map([["child-1", { running: true }]]);
	const idle = new Map([["child-1", { running: false }]]);

	notice.emitLocalNotices(null, running, byId);
	assert.equal(rendered.length, 0, "the first render notified");
	notice.emitLocalNotices(running, idle, byId);
	assert.equal(rendered.length, 0, "a subagent turn end notified");
	// Missing fields must not throw either.
	assert.doesNotThrow(() => notice.emitLocalNotices(
		new Map([["root-x", null]]),
		new Map([["root-x", { running: false }]]),
		null,
	));
	booted.disposeAll();
});



test("a rendered local banner acknowledges its event without visibility polling", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts, markSend } = localNoticeHarness({ endpoint });
	const settle = async () => {
		for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
	};
	await settle();
	assert.equal(ackPosts.length, 0, "boot must not report visibility or send ACKs");
	const byId = { "root-ack": { title: "Main" } };
	const running = new Map([["root-ack", { running: true }]]);
	const idle = new Map([["root-ack", { running: false }]]);
	markSend("root-ack");
	notice.emitLocalNotices(running, idle, byId);
	await settle();
	assert.equal(rendered.length, 1);
	assert.equal(ackPosts.length, 1, "the rendered banner did not acknowledge the host event");
	assert.equal(ackPosts[0].url, "api/dsh-mobile-maxxing/push/ack");
	assert.equal(ackPosts[0].options.keepalive, true);
	assert.deepEqual(JSON.parse(ackPosts[0].options.body), {
		endpoint, sessionId: "root-ack", kind: "turn-end", origin: "https://app.example:8446",
	});
	notice.emitLocalNotices(idle, idle, byId);
	await settle();
	assert.equal(ackPosts.length, 1, "an unchanged snapshot sent another ACK");
	assert.deepEqual(booted.disposeAll(), []);
});

test("hidden, unsubscribed, and just-backgrounded pages cannot suppress push", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const byId = { "root-ack": { title: "Main" } };
	const running = new Map([["root-ack", { running: true }]]);
	const idle = new Map([["root-ack", { running: false }]]);
	const hidden = localNoticeHarness({ endpoint, initialVisibility: "hidden" });
	hidden.markSend("root-ack");
	hidden.notice.emitLocalNotices(running, idle, byId);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(hidden.ackPosts, [], "a hidden page acknowledged an invisible banner");
	hidden.booted.disposeAll();

	const unregistered = localNoticeHarness();
	unregistered.markSend("root-ack");
	unregistered.notice.emitLocalNotices(running, idle, byId);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(unregistered.ackPosts, [], "a device without push subscription sent an ACK");
	unregistered.booted.disposeAll();

	let releaseSubscription;
	const gate = new Promise((resolve) => { releaseSubscription = resolve; });
	const transitioning = localNoticeHarness({ endpoint, subscriptionGate: gate });
	transitioning.markSend("root-ack");
	transitioning.notice.emitLocalNotices(running, idle, byId);
	transitioning.booted.sandbox.document.visibilityState = "hidden";
	releaseSubscription();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(transitioning.ackPosts, [], "the page acknowledged after being backgrounded");
	transitioning.booted.disposeAll();
});

test("a new pending interaction raises a question banner once", () => {
	const { booted, notice, rendered } = localNoticeHarness();
	const byId = { "root-2": { title: "Ask" } };
	const running = new Map([["root-2", { running: true }]]);
	const asked = new Map([["root-2", { running: true, pendingInteraction: { kind: "question" } }]]);

	notice.emitLocalNotices(null, running, byId);
	assert.equal(rendered.length, 0, "the first render notified");
	notice.emitLocalNotices(running, asked, byId);
	assert.equal(rendered.length, 1, "a new question raised no banner");
	assert.equal(rendered[0], "Ask — Confirm");
	// The same map identity is not a transition.
	notice.emitLocalNotices(asked, asked, byId);
	assert.equal(rendered.length, 1, "an unchanged map raised another banner");
	booted.disposeAll();
});

/** Let the page's promises (subscription lookup, ACK fetch) settle. */
async function settleNoticeWork() {
	for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a root turn finished while another session is open raises a local banner", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts } = localNoticeHarness({ endpoint });
	const byId = { "root-pc": { title: "Main" } };
	const running = new Map([["root-pc", { running: true }]]);
	const idle = new Map([["root-pc", { running: false }]]);

	// In-app delivery is independent of which browser started the turn.
	notice.emitLocalNotices(running, idle, byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 1, "a root turn from another device stayed silent");
	assert.equal(ackPosts.length, 1, "the visible banner did not acknowledge its event");
	booted.disposeAll();
});

test("a turn this browser did send raises one banner and one ACK", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts, markSend } = localNoticeHarness({ endpoint });
	const byId = { "root-phone": { title: "Main" } };
	const running = new Map([["root-phone", { running: true }]]);
	const idle = new Map([["root-phone", { running: false }]]);

	markSend("root-phone");
	notice.emitLocalNotices(running, idle, byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 1, "a turn this browser sent raised no banner");
	assert.equal(ackPosts.length, 1, "a turn this browser sent was not acknowledged");
	assert.equal(JSON.parse(ackPosts[0].options.body).sessionId, "root-phone");
	booted.disposeAll();
});

test("a question from another device still raises a local banner", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts } = localNoticeHarness({ endpoint });
	const byId = { "root-ask": { title: "Ask" } };
	const running = new Map([["root-ask", { running: true }]]);
	const asked = new Map([["root-ask", { running: true, pendingInteraction: { kind: "question" } }]]);

	// A question needs the user wherever the turn came from.
	notice.emitLocalNotices(running, asked, byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 1, "an unmarked session lost its question banner");
	assert.equal(ackPosts.length, 1, "a question banner was not acknowledged");
	assert.equal(JSON.parse(ackPosts[0].options.body).kind, "question");
	booted.disposeAll();
});

test("an unmarked root session keeps its local banner", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, markSend } = localNoticeHarness({ endpoint, onlyMobileTurns: false });
	const byId = { "root-pc": { title: "Main" } };
	const running = new Map([["root-pc", { running: true }]]);
	const idle = new Map([["root-pc", { running: false }]]);

	// The config answer arrives on boot; without it the host default (true)
	// applies. Marked here so the config fetch is not racing the assertion.
	markSend("root-unused");
	await settleNoticeWork();
	notice.emitLocalNotices(running, idle, byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 1, "onlyMobileTurns:false still suppressed a legitimately notified turn");
	booted.disposeAll();
});

test("the ACK waits for the banner commit and is sent once", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts, markSend, flushCommits } = localNoticeHarness({ endpoint, commits: "manual" });
	const byId = { "root-ack": { title: "Main" } };
	const running = new Map([["root-ack", { running: true }]]);
	const idle = new Map([["root-ack", { running: false }]]);

	markSend("root-ack");
	notice.emitLocalNotices(running, idle, byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 1, "the banner was not rendered");
	assert.deepEqual(ackPosts, [], "the ACK was sent before the banner committed");
	flushCommits();
	await settleNoticeWork();
	assert.equal(ackPosts.length, 1, "the committed banner did not acknowledge its event");
	// StrictMode and a re-run effect call the same commit twice.
	flushCommits();
	flushCommits();
	await settleNoticeWork();
	assert.equal(ackPosts.length, 1, "a repeated commit sent a second ACK");
	booted.disposeAll();
});

test("a second banner that replaces a shown one is acknowledged on its own", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts, markSend } = localNoticeHarness({ endpoint });
	const byId = { "root-a": { title: "A" }, "root-b": { title: "B" } };
	markSend("root-a");
	markSend("root-b");

	// First banner commits while it is on screen (its hold is still running).
	notice.emitLocalNotices(new Map([["root-a", { running: true }]]), new Map([["root-a", { running: false }]]), byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 1, "the first banner was not rendered");
	assert.equal(ackPosts.length, 1, "the first banner did not acknowledge its event");

	// The second banner is the same component at the same position: without its
	// own identity React reuses the instance and the mount effect never runs
	// again, so its event would never be acknowledged.
	notice.emitLocalNotices(new Map([["root-b", { running: true }]]), new Map([["root-b", { running: false }]]), byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 2, "the second banner was not rendered");
	assert.equal(ackPosts.length, 2, "the second banner was never acknowledged");
	assert.deepEqual(
		ackPosts.map((post) => JSON.parse(post.options.body).sessionId),
		["root-a", "root-b"],
		"the two banners acknowledged the wrong events",
	);
	booted.disposeAll();
});

test("a teardown during the subscription lookup acknowledges nothing", async () => {
	const endpoint = "https://web.push.apple.com/device";
	let releaseSubscription;
	const gate = new Promise((resolve) => { releaseSubscription = resolve; });
	const harness = localNoticeHarness({ endpoint, subscriptionGate: gate });
	const byId = { "root-gone": { title: "Main" } };

	harness.markSend("root-gone");
	harness.notice.emitLocalNotices(new Map([["root-gone", { running: true }]]), new Map([["root-gone", { running: false }]]), byId);
	// HMR / teardown unmounts the banner while the endpoint lookup is still in
	// flight; the page is still "visible" but nothing is on screen any more.
	harness.booted.disposeAll();
	releaseSubscription();
	await settleNoticeWork();
	assert.deepEqual(harness.ackPosts, [], "a torn-down page acknowledged an unmounted banner");
});

test("a banner replaced before it commits is never acknowledged", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, notice, rendered, ackPosts, markSend, flushCommits } = localNoticeHarness({ endpoint, commits: "manual" });
	const byId = { "root-a": { title: "A" }, "root-b": { title: "B" } };
	const running = new Map([["root-a", { running: true }], ["root-b", { running: true }]]);
	const idle = new Map([["root-a", { running: false }], ["root-b", { running: false }]]);

	markSend("root-a");
	markSend("root-b");
	// Two events in one snapshot; the last banner replaces the first before
	// React commits, so only the visible one may be acknowledged.
	notice.emitLocalNotices(running, idle, byId);
	await settleNoticeWork();
	assert.equal(rendered.length, 2, "both transitions rendered a banner");
	assert.deepEqual(ackPosts, [], "an uncommitted banner acknowledged its event");
	flushCommits();
	await settleNoticeWork();
	assert.equal(ackPosts.length, 1, "exactly the visible banner acknowledges its event");
	assert.equal(JSON.parse(ackPosts[0].options.body).sessionId, "root-b", "the replaced banner was acknowledged");
	booted.disposeAll();
});

test("the old worker's hand-off is answered only after the banner commits", async () => {
	const { booted, notice, rendered, flushCommits } = localNoticeHarness({ commits: "manual" });
	const ports = [];
	notice.onWorkerMessage({
		data: { type: "dsh-mobile-maxxing:notify", title: "Main", body: "done", sessionId: "root-old", kind: "turn-end" },
		ports: [{ postMessage: (value) => ports.push(value) }],
	});
	assert.equal(rendered.length, 1, "the hand-off raised no banner");
	assert.deepEqual(ports, [], "the hand-off was accepted before the banner committed");
	flushCommits();
	assert.deepEqual(ports, ["shown"], "the committed banner did not answer the hand-off");
	booted.disposeAll();
});

test("a foreground test shows one banner and never asks for a push", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, api, rendered, testPushes, ackPosts } = localNoticeHarness({ endpoint });
	await settleNoticeWork();
	await api.sendTestNotification();
	assert.equal(rendered.length, 1, "the foreground test raised no banner");
	assert.equal(rendered[0], "DSH test notification — This banner is how it arrives while the app is open.");
	// The host's test route sends a real Web Push, and the worker must show
	// every push it receives, so asking for it would put an OS notification on
	// top of the app the user is looking at (#98).
	assert.deepEqual(testPushes, [], "a foreground test still took the push path");
	assert.deepEqual(ackPosts, [], "the test banner acknowledged an event");
	booted.disposeAll();
});

test("a foreground test without a subscription reports it instead of a banner", async () => {
	const { booted, api, rendered, testPushes } = localNoticeHarness({ endpoint: "" });
	await settleNoticeWork();
	await assert.rejects(() => api.sendTestNotification(), /not enabled on this device/);
	assert.equal(rendered.length, 0, "a banner claimed push works with no subscription");
	assert.deepEqual(testPushes, [], "a missing subscription still took the push path");
	booted.disposeAll();
});

test("a backgrounded page still takes the push path for a test", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, api, rendered, testPushes } = localNoticeHarness({ endpoint, initialVisibility: "hidden" });
	await settleNoticeWork();
	await api.sendTestNotification();
	assert.equal(testPushes.length, 1, "the background test did not reach the push path");
	assert.equal(rendered.length, 0, "a hidden page rendered a banner");
	booted.disposeAll();
});

test("a failed test push on a hidden page is reported", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, api, rendered, testPushes, ackPosts } = localNoticeHarness({ endpoint, pushTest: "fail", initialVisibility: "hidden" });
	await settleNoticeWork();
	await assert.rejects(() => api.sendTestNotification(), /Push was rejected/);
	assert.equal(testPushes.length, 1, "the test did not reach the push path");
	assert.equal(rendered.length, 0, "the test raised a local banner before the push result");
	assert.deepEqual(ackPosts, [], "the test acknowledged an event");
	booted.disposeAll();
});

test("a launch re-registers this device's subscription and names the one it replaced", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const previous = "https://web.push.apple.com/previous";
	const { booted, subscribePosts } = localNoticeHarness({
		endpoint,
		notification: { permission: "granted" },
		storage: { "rdsh-mobile-ux:push-endpoint": previous },
	});
	await settleNoticeWork();
	assert.equal(subscribePosts.length, 1, "the launch did not refresh the subscription");
	const body = JSON.parse(subscribePosts[0].options.body);
	assert.equal(body.subscription.endpoint, endpoint);
	assert.equal(body.previousEndpoint, previous, "the replaced endpoint was not named");
	assert.equal(body.origin, "https://app.example:8446");
	// The next launch names the endpoint it now holds.
	assert.equal(booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-endpoint"), endpoint);
	booted.disposeAll();
});

test("a launch names no previous endpoint while the registration did not change", async () => {
	const endpoint = "https://web.push.apple.com/device";
	const { booted, subscribePosts } = localNoticeHarness({
		endpoint,
		notification: { permission: "granted" },
		storage: { "rdsh-mobile-ux:push-endpoint": endpoint },
	});
	await settleNoticeWork();
	assert.equal(subscribePosts.length, 1);
	assert.equal(JSON.parse(subscribePosts[0].options.body).previousEndpoint, "", "an unchanged endpoint was reported as replaced");
	booted.disposeAll();
});

test("a launch without permission or a subscription registers nothing", async () => {
	const noPermission = localNoticeHarness({
		endpoint: "https://web.push.apple.com/device",
		notification: { permission: "default" },
	});
	await settleNoticeWork();
	assert.deepEqual(noPermission.subscribePosts, [], "a permission-less launch registered a subscription");
	noPermission.booted.disposeAll();

	const noSubscription = localNoticeHarness({ endpoint: "", notification: { permission: "granted" } });
	await settleNoticeWork();
	assert.deepEqual(noSubscription.subscribePosts, [], "a launch with no subscription posted one");
	noSubscription.booted.disposeAll();
});

test("an opted-in missing subscription is recreated and its old endpoint retired", async () => {
	const old = "https://web.push.apple.com/old", replacement = "https://web.push.apple.com/new";
	const h = localNoticeHarness({ endpoint: "", recoverEndpoint: replacement, notification: { permission: "granted" }, storage: { "rdsh-mobile-ux:push-enabled": "true", "rdsh-mobile-ux:push-endpoint": old } });
	await h.api.syncPushSubscription();
	assert.equal(h.subscribeAttempts, 1);
	assert.equal(h.subscribePosts.length, 1);
	assert.equal(JSON.parse(h.subscribePosts[0].options.body).previousEndpoint, old);
	assert.equal(h.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-endpoint"), replacement);
	h.booted.disposeAll();
	assert.equal(h.windowHandlers.has("online"), false);
});

test("a failed server registration retries on reconnect", async () => {
	const replacement = "https://web.push.apple.com/new";
	const h = localNoticeHarness({ endpoint: "", recoverEndpoint: replacement, notification: { permission: "granted" }, storage: { "rdsh-mobile-ux:push-enabled": "true" }, subscribeStatuses: [503, 200] });
	await h.api.syncPushSubscription();
	assert.equal(h.subscribePosts.length, 1);
	assert.equal(h.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-endpoint"), null);
	h.windowHandlers.get("online")();
	await h.api.syncPushSubscription();
	assert.equal(h.subscribePosts.length, 2);
	assert.equal(h.subscribeAttempts, 1, "the existing browser subscription should be reused");
	assert.equal(h.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-endpoint"), replacement);
	h.booted.disposeAll();
});

test("disabled or legacy-unsubscribed browsers are never re-enabled automatically", async () => {
	for (const enabled of [undefined, "false"]) {
		const storage = { "rdsh-mobile-ux:push-endpoint": "https://web.push.apple.com/old" };
		if (enabled !== undefined) storage["rdsh-mobile-ux:push-enabled"] = enabled;
		const h = localNoticeHarness({ endpoint: "", recoverEndpoint: "https://web.push.apple.com/new", notification: { permission: "granted" }, storage });
		await h.api.syncPushSubscription();
		assert.equal(h.subscribeAttempts, 0);
		assert.equal(h.subscribePosts.length, 0);
		h.booted.disposeAll();
	}
});

test("disabling during a pending re-subscribe leaves notifications disabled", async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const h = localNoticeHarness({ endpoint: "", recoverEndpoint: "https://web.push.apple.com/new", notification: { permission: "granted" }, storage: { "rdsh-mobile-ux:push-enabled": "true" }, subscribeGate: gate });
	await settleNoticeWork();
	assert.equal(h.subscribeAttempts, 1);
	const disabling = h.api.disableNotifications();
	release();
	await disabling;
	assert.equal(h.activeEndpoint, "");
	assert.equal(h.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-enabled"), "false");
	assert.equal(h.subscribePosts.length, 0);
	h.booted.disposeAll();
});

test("disabling while the permission prompt is open does not opt back in", async () => {
	let resolvePermission;
	const permission = new Promise((resolve) => { resolvePermission = resolve; });
	const h = localNoticeHarness({ endpoint: "", recoverEndpoint: "https://web.push.apple.com/new", notification: { permission: "granted", requestPermission: () => permission }, storage: { "rdsh-mobile-ux:push-enabled": "false" } });
	const enabling = h.api.enableNotifications();
	await h.api.disableNotifications();
	resolvePermission("granted");
	await enabling;
	assert.equal(h.subscribeAttempts, 0);
	assert.equal(h.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-enabled"), "false");
	h.booted.disposeAll();
});

test("disabling waits for an explicit enable in flight and removes its subscription", async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const h = localNoticeHarness({ endpoint: "", recoverEndpoint: "https://web.push.apple.com/new", notification: { permission: "granted", requestPermission: async () => "granted" }, storage: { "rdsh-mobile-ux:push-enabled": "false" }, subscribeGate: gate });
	const enabling = h.api.enableNotifications();
	await settleNoticeWork();
	assert.equal(h.subscribeAttempts, 1);
	const disabling = h.api.disableNotifications();
	release();
	await Promise.all([enabling, disabling]);
	assert.equal(h.activeEndpoint, "");
	assert.equal(h.booted.sandbox.localStorage.getItem("rdsh-mobile-ux:push-enabled"), "false");
	h.booted.disposeAll();
});

test("a local-only notice still marks the banner for the worker hand-off", async () => {
	const { booted, notice, rendered, markSend } = localNoticeHarness();
	const byId = { "root-1": { title: "Main" } };
	const running = new Map([["root-1", { running: true }]]);
	const idle = new Map([["root-1", { running: false }]]);
	markSend("root-1");
	notice.emitLocalNotices(running, idle, byId);
	assert.equal(rendered.length, 1, "the banner was not rendered");
	assert.equal(notice.localNoticeRecent("root-1", "turn-end"), true, "a committed banner is not deduplicated against the hand-off");
	booted.disposeAll();
});

/* ---------------------------------------------------------------------- */
/* #59: landscape drawer nav folds into one accessible More row           */
/* ---------------------------------------------------------------------- */

/** A small element with the event/children support the More menu needs. */
function navNode(doc, tag = "div") {
	const node = element();
	const listeners = new Map();
	node.tagName = String(tag).toUpperCase();
	node.children = [];
	node.parentElement = null;
	node.className = "";
	node.textContent = "";
	node.addEventListener = (type, handler) => {
		if (!listeners.has(type)) listeners.set(type, []);
		listeners.get(type).push(handler);
	};
	node.removeEventListener = (type, handler) => {
		const list = listeners.get(type);
		if (list === undefined) return;
		const at = list.indexOf(handler);
		if (at >= 0) list.splice(at, 1);
	};
	node.dispatchNav = (type, props = {}) => {
		const event = {
			type,
			target: node,
			currentTarget: node,
			defaultPrevented: false,
			propagationStopped: false,
			preventDefault() { this.defaultPrevented = true; },
			stopPropagation() { this.propagationStopped = true; },
			stopImmediatePropagation() { this.propagationStopped = true; },
			...props,
		};
		for (const handler of [...(listeners.get(type) ?? [])]) handler.call(node, event);
		return event;
	};
	node.click = () => node.dispatchNav("click");
	node.focus = () => { doc.activeElement = node; };
	node.appendChild = (child) => {
		if (child.parentElement !== null) child.remove();
		child.parentElement = node;
		node.children.push(child);
		return child;
	};
	node.append = (...children) => {
		for (const child of children) node.appendChild(child);
	};
	node.insertBefore = (child, reference) => {
		if (child.parentElement !== null) child.remove();
		const at = node.children.indexOf(reference);
		child.parentElement = node;
		if (at < 0) node.children.push(child);
		else node.children.splice(at, 0, child);
		return child;
	};
	node.after = (sibling) => {
		const parent = node.parentElement;
		if (parent === null) return;
		parent.insertBefore(sibling, node.nextElementSibling);
	};
	node.remove = () => {
		const parent = node.parentElement;
		if (parent === null) return;
		const at = parent.children.indexOf(node);
		if (at >= 0) parent.children.splice(at, 1);
		node.parentElement = null;
	};
	node.contains = (target) => target === node || node.children.some((child) => child.contains(target));
	node.querySelectorAll = (selector) => {
		const found = [];
		const walk = (current) => {
			for (const child of current.children) {
				if (navMatches(child, selector)) found.push(child);
				walk(child);
			}
		};
		walk(node);
		return found;
	};
	node.querySelector = (selector) => node.querySelectorAll(selector)[0] ?? null;
	Object.defineProperty(node, "nextElementSibling", {
		get() {
			if (node.parentElement === null) return null;
			const siblings = node.parentElement.children;
			return siblings[siblings.indexOf(node) + 1] ?? null;
		},
	});
	Object.defineProperty(node, "lastElementChild", {
		get() { return node.children[node.children.length - 1] ?? null; },
	});
	return node;
}

/** The tiny selector language the nav fixture and the menu use. */
function navMatches(node, selector) {
	for (const branch of selector.split(",")) {
		const part = branch.trim();
		if (part === "") continue;
		const tag = (part.match(/^([A-Za-z][\w-]*)/) ?? [])[1];
		if (tag !== undefined && node.tagName !== tag.toUpperCase()) continue;
		const classMatch = part.match(/\.([A-Za-z0-9_-]+)/);
		if (classMatch !== null && !String(node.className).split(/\s+/).includes(classMatch[1])) continue;
		const attributes = [...part.matchAll(/\[([A-Za-z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g)];
		if (attributes.length === 0) {
			if (tag !== undefined || classMatch !== null) return true;
			continue;
		}
		if (attributes.every(([, name, doubleQuoted, singleQuoted]) => node.hasAttribute(name)
			&& ((doubleQuoted ?? singleQuoted) === undefined || node.getAttribute(name) === (doubleQuoted ?? singleQuoted)))) return true;
	}
	return false;
}

function navBoot({ mode = "mobile", narrow = false, lang = undefined, labels = {} } = {}) {
	const label = (name, fallback) => labels[name] ?? fallback;
	const frames = [];
	const docListeners = [];
	const windowListeners = [];
	const created = [];
	const counts = { plugins: 0, automation: 0, settings: 0 };
	let nav = null;
	let body = null;
	let newSession = null;
	let plugins = null;
	let automation = null;
	const booted = bootClient({
		mode,
		narrow,
		lang,
		copy: COPY,
		frames,
		windowAdd(type, handler) { windowListeners.push({ type, handler }); },
		windowRemove(type, handler) {
			const at = windowListeners.findIndex((entry) => entry.type === type && entry.handler === handler);
			if (at >= 0) windowListeners.splice(at, 1);
		},
		configureDocument(doc) {
			body = navNode(doc, "body");
			nav = navNode(doc, "nav");
			nav.className = "hHd-Xa_panelList";
			newSession = navNode(doc, "button");
			plugins = navNode(doc, "button");
			automation = navNode(doc, "button");
			newSession.setAttribute("aria-label", label("newSession", "New Session"));
			plugins.setAttribute("aria-label", label("plugins", "Plugins"));
			automation.setAttribute("aria-label", label("automation", "Automation tasks"));
			nav.append(newSession, plugins, automation);
			body.append(nav);
			doc.body = body;
			doc.createElement = (tag) => {
				const node = navNode(doc, tag);
				created.push(node);
				return node;
			};
			doc.querySelector = (selector) => {
				if (selector === "nav.hHd-Xa_panelList") return nav;
				if (selector === "[data-rdsh-settings-row]"
					|| selector === "[data-rdsh-settings-row], .rdsh-mux-settings-row") return nav.querySelector("[data-rdsh-settings-row]");
				if (selector === "[data-rdsh-nav-more]") return nav.querySelector("[data-rdsh-nav-more]");
				return null;
			};
			doc.querySelectorAll = (selector) => {
				if (selector === "[data-rdsh-settings-row], .rdsh-mux-settings-row"
					|| selector === "[data-rdsh-nav-more]"
					|| selector === "[data-rdsh-nav-more-hidden]"
					|| selector === "[data-rdsh-more-row]") return nav.querySelectorAll(selector);
				return [];
			};
			doc.addEventListener = (type, handler, options) => {
				const capture = options === true || (options !== undefined && options !== null && options.capture === true);
				docListeners.push({ type, handler, capture });
			};
			doc.removeEventListener = (type, handler, options) => {
				const capture = options === true || (options !== undefined && options !== null && options.capture === true);
				const at = docListeners.findIndex((entry) => entry.type === type && entry.handler === handler && entry.capture === capture);
				if (at >= 0) docListeners.splice(at, 1);
			};
		},
	});
	const run = () => {
		while (frames.length > 0) frames.shift()();
	};
	run();
	return {
		booted,
		doc: booted.sandbox.document,
		sandbox: booted.sandbox,
		nav,
		body,
		newSession,
		plugins,
		automation,
		created,
		docListeners,
		windowListeners,
		counts,
		run,
		settingsRow: () => nav.querySelector("[data-rdsh-settings-row]"),
		more: () => nav.querySelector("[data-rdsh-nav-more]"),
		menus: () => body.querySelectorAll(".rdsh-mux-nav-more-menu"),
		items: () => body.querySelectorAll("button[role='menuitem']"),
	};
}

test("#59 landscape folds the three nav rows into one More row", () => {
	const fixture = navBoot();
	const more = fixture.more();
	assert.ok(more, "the landscape More row was not created");
	assert.equal(more.getAttribute("aria-haspopup"), "menu");
	assert.equal(more.getAttribute("aria-expanded"), "false");
	assert.equal(more.getAttribute("aria-label"), COPY.en["mux.navMore"]);
	assert.equal(more.className.includes("rdsh-mux-nav-more"), true);
	assert.equal(more.nextElementSibling, fixture.plugins, "More is not in the first folded row's slot");
	for (const row of [fixture.plugins, fixture.automation, fixture.settingsRow()]) {
		assert.equal(row.hasAttribute("data-rdsh-nav-more-hidden"), true, "a folded row is still visible");
	}
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-settings-row]").length, 1, "the Settings row was duplicated");

	// Repainting must not duplicate the More row or the single #87 Settings row.
	for (let pass = 0; pass < 3; pass += 1) fixture.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more]").length, 1);
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-settings-row]").length, 1);
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more-hidden]").length, 3);
	fixture.booted.disposeAll();
});

test("#59 the More menu focuses and activates each folded row", () => {
	const fixture = navBoot();
	const settingsRow = fixture.settingsRow();
	fixture.plugins.click = () => { fixture.counts.plugins += 1; };
	fixture.automation.click = () => { fixture.counts.automation += 1; };
	settingsRow.click = () => { fixture.counts.settings += 1; };
	const more = fixture.more();

	for (const [index, countKey] of [[0, "plugins"], [1, "automation"], [2, "settings"]]) {
		more.click();
		const menus = fixture.menus();
		assert.equal(menus.length, 1, "More did not open exactly one menu");
		const menu = menus[0];
		assert.equal(menu.getAttribute("role"), "menu");
		assert.equal(menu.getAttribute("aria-label"), COPY.en["mux.navMore.menu"]);
		const items = fixture.items();
		assert.deepEqual(items.map((item) => item.textContent), ["Plugins", "Automation tasks", "Settings"]);
		assert.equal(fixture.doc.activeElement, items[0], "the first menu item did not receive focus");
		// ArrowDown moves focus without leaving the menu.
		items[0].dispatchNav("keydown", { key: "ArrowDown" });
		assert.equal(fixture.doc.activeElement, items[1], "ArrowDown did not move focus");
		items[1].dispatchNav("keydown", { key: "ArrowUp" });
		assert.equal(fixture.doc.activeElement, items[0], "ArrowUp did not move focus");
		assert.equal(more.getAttribute("aria-expanded"), "true");
		items[index].click();
		assert.equal(fixture.counts[countKey], 1, `the ${countKey} row did not run`);
		assert.equal(menu.parentElement, null, "the menu stayed after item selection");
		assert.equal(more.getAttribute("aria-expanded"), "false");
		assert.equal(more.hasAttribute("aria-controls"), false);
	}
	fixture.booted.disposeAll();
});

test("#59 the More menu dismisses on Escape, outside press, Tab and resize", () => {
	const fixture = navBoot();
	const more = fixture.more();
	const lastDoc = (type) => [...fixture.docListeners].reverse().find((entry) => entry.type === type && entry.capture);
	const lastWindow = (type) => [...fixture.windowListeners].reverse().find((entry) => entry.type === type);

	more.click();
	let menu = fixture.menus()[0];
	assert.ok(menu, "the menu did not open");
	lastDoc("pointerdown").handler({ target: fixture.body });
	assert.equal(menu.parentElement, null, "an outside press did not close the menu");
	assert.equal(more.getAttribute("aria-expanded"), "false");

	more.click();
	menu = fixture.menus()[0];
	const escape = { key: "Escape", prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; } };
	lastDoc("keydown").handler(escape);
	assert.equal(menu.parentElement, null, "Escape did not close the menu");
	assert.equal(escape.prevented, 1, "Escape was not consumed");
	assert.equal(fixture.doc.activeElement, more, "Escape did not restore focus to More");

	more.click();
	menu = fixture.menus()[0];
	fixture.items()[0].dispatchNav("keydown", { key: "Tab" });
	assert.equal(menu.parentElement, null, "Tab left the menu behind");

	more.click();
	menu = fixture.menus()[0];
	lastWindow("resize").handler();
	assert.equal(menu.parentElement, null, "a resize did not close the menu");
	assert.equal(more.getAttribute("aria-expanded"), "false");

	// Rotating back to portrait removes More and restores the stock rows.
	fixture.sandbox.innerWidth = 390;
	fixture.sandbox.window.innerWidth = 390;
	fixture.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(fixture.more(), null, "portrait kept the landscape More row");
	for (const row of [fixture.plugins, fixture.automation, fixture.settingsRow()]) {
		assert.equal(row.hasAttribute("data-rdsh-nav-more-hidden"), false, "portrait kept a folded row hidden");
	}
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-settings-row]").length, 1);
	fixture.booted.disposeAll();
});

test("#59 a language switch relabels the same More row in place", () => {
	const fixture = navBoot();
	const more = fixture.more();
	assert.equal(more.getAttribute("aria-label"), COPY.en["mux.navMore"]);
	// The real button's innerHTML carries the title span; the stub discards
	// markup, so the node the copy is written into is attached here.
	const title = navNode(fixture.doc, "span");
	title.className = "hHd-Xa_panelTitle hHd-Xa_wide";
	title.textContent = COPY.en["mux.navMore"];
	more.append(title);
	let titleText = COPY.en["mux.navMore"];
	let titleWrites = 0;
	Object.defineProperty(title, "textContent", {
		configurable: true,
		get: () => titleText,
		set(value) {
			titleWrites += 1;
			titleText = String(value);
		},
	});
	let ariaWrites = 0;
	const setAttribute = more.setAttribute;
	more.setAttribute = (name, value) => {
		if (name === "aria-label") ariaWrites += 1;
		return setAttribute.call(more, name, value);
	};

	// The node already exists in English; the switch must relabel it.
	fixture.sandbox.__RDSH_PWA_LANG__ = "ja";
	fixture.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(fixture.more(), more, "the language switch replaced the More row");
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more]").length, 1, "the language switch duplicated More");
	assert.equal(more.getAttribute("aria-label"), "その他");
	assert.equal(title.textContent, "その他", "the visible title kept the old language");
	assert.equal(titleWrites, 1, "the title was not rewritten exactly once");
	assert.equal(more.children.length, 1, "the title sync added nodes");

	// A re-apply must not write the same label again: every write wakes the
	// MutationObserver that scheduled this pass.
	fixture.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	fixture.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(ariaWrites, 1, "a pass with no language change rewrote aria-label");
	assert.equal(titleWrites, 1, "a pass with no language change rewrote the title");

	// An open menu keeps its state and focus across the relabel.
	more.click();
	const menu = fixture.menus()[0];
	const item = fixture.items()[0];
	assert.equal(fixture.doc.activeElement, item, "the menu did not focus its first item");
	assert.equal(more.getAttribute("aria-expanded"), "true");
	const controls = more.getAttribute("aria-controls");
	fixture.sandbox.__RDSH_PWA_LANG__ = "en";
	fixture.booted.sandbox.__RDSH_MOBILE_UX__.decorateNow();
	assert.equal(more.getAttribute("aria-label"), "More");
	assert.equal(title.textContent, "More");
	assert.equal(titleWrites, 2);
	assert.equal(fixture.menus().length, 1, "the language switch closed or duplicated the menu");
	assert.equal(menu.parentElement, fixture.body, "the open menu left the page");
	assert.equal(more.getAttribute("aria-expanded"), "true");
	assert.equal(more.getAttribute("aria-controls"), controls);
	assert.equal(fixture.doc.activeElement, item, "the language switch stole menu focus");

	const escape = { key: "Escape", preventDefault() {}, stopPropagation() {} };
	[...fixture.docListeners].reverse().find((entry) => entry.type === "keydown" && entry.capture).handler(escape);
	assert.equal(menu.parentElement, null, "Escape stopped closing the menu");
	assert.equal(fixture.doc.activeElement, more, "Escape stopped restoring focus to More");
	fixture.booted.disposeAll();
});

test("#59 the More row is mobile-landscape only and is removed on dispose", () => {
	const portrait = navBoot({ narrow: true });
	assert.equal(portrait.more(), null, "a portrait phone got the landscape More row");
	assert.equal(portrait.nav.querySelectorAll("[data-rdsh-nav-more-hidden]").length, 0);
	assert.ok(portrait.settingsRow(), "the portrait Settings row is missing");
	portrait.booted.disposeAll();

	const desktop = navBoot({ mode: "desktop", narrow: false });
	assert.equal(desktop.more(), null, "a desktop got the landscape More row");
	assert.equal(desktop.nav.querySelectorAll("[data-rdsh-nav-more-hidden]").length, 0);
	assert.equal(desktop.newSession.hasAttribute("aria-label"), true, "the desktop nav was rewritten");
	desktop.booted.disposeAll();

	const landscape = navBoot();
	const more = landscape.more();
	more.click();
	assert.equal(landscape.menus().length, 1);
	landscape.booted.disposeAll();
	assert.equal(landscape.more(), null, "dispose left the More row");
	assert.equal(landscape.menus().length, 0, "dispose left the More menu");
	assert.equal(landscape.nav.querySelectorAll("[data-rdsh-nav-more-hidden]").length, 0, "dispose left folded rows hidden");
	assert.equal(landscape.nav.children.includes(landscape.plugins), true, "dispose removed a stock row");
	assert.equal(landscape.nav.children.includes(landscape.automation), true, "dispose removed a stock row");
	assert.equal(landscape.settingsRow(), null, "dispose kept the injected Settings row");
});

test("#80 a full ja shell folds the three rows and runs every More action", () => {
	const labels = { newSession: "新しいセッションを作成", plugins: "プラグイン", automation: "自動化タスク" };
	const fixture = navBoot({ lang: "ja", labels });
	const more = fixture.more();
	assert.ok(more, "the ja landscape More row was not created");
	const settingsRow = fixture.settingsRow();
	assert.ok(settingsRow, "the ja Settings row was not injected");
	for (const row of [fixture.plugins, fixture.automation, settingsRow]) {
		assert.equal(row.hasAttribute("data-rdsh-nav-more-hidden"), true, "a ja folded row is still visible");
	}
	// The injected row still follows Automation tasks when its label is ja.
	assert.equal(fixture.automation.nextElementSibling, settingsRow, "the ja Settings row did not follow Automation tasks");

	fixture.plugins.click = () => { fixture.counts.plugins += 1; };
	fixture.automation.click = () => { fixture.counts.automation += 1; };
	settingsRow.click = () => { fixture.counts.settings += 1; };

	more.click();
	const items = fixture.items();
	assert.deepEqual(
		items.map((item) => item.textContent),
		["プラグイン", "自動化タスク", COPY.ja["mux.settingsRow"]],
		"the ja More menu does not list the three folded rows",
	);
	for (const item of items) item.click();
	assert.deepEqual(fixture.counts, { plugins: 1, automation: 1, settings: 1 }, "a ja More item did not run its stock row");
	assert.equal(fixture.menus().length, 0, "the ja More menu stayed open");
	fixture.booted.disposeAll();
});

test("#80 a full ja desktop keeps the stock nav and installs no phone controls", () => {
	const labels = { newSession: "新しいセッションを作成", plugins: "プラグイン", automation: "自動化タスク" };
	const fixture = navBoot({ mode: "desktop", narrow: false, lang: "ja", labels });
	assert.equal(fixture.more(), null, "a ja desktop got the landscape More row");
	assert.equal(fixture.settingsRow(), null, "a ja desktop got the injected Settings row");
	assert.equal(fixture.nav.querySelectorAll("[data-rdsh-nav-more-hidden]").length, 0, "a ja desktop folded a row");
	assert.equal(fixture.plugins.getAttribute("aria-label"), "プラグイン", "a ja desktop nav was rewritten");
	assert.equal(fixture.docListeners.length, 0, "a ja desktop installed the mobile click listener");
	fixture.booted.disposeAll();
});


/**
 * A question card stand-in for the answer-field rules. Only the structural
 * queries those rules make are answered; anything label-based throws, so a
 * translation regression cannot pass through this fake.
 */
function questionCardFixture({ options = 2, checked = 0, custom = "" } = {}) {
	const feedback = { textContent: "" };
	let clicks = 0;
	const submit = {
		click() {
			clicks += 1;
		},
	};
	return {
		feedback,
		get clicks() {
			return clicks;
		},
		querySelectorAll(selector) {
			assert.doesNotMatch(selector, /aria-label/, "the question guard matched a translated label");
			assert.match(selector, /role="(?:radio|checkbox)"/, "the option list was not found structurally");
			return new Array(options).fill({});
		},
		querySelector(selector) {
			assert.doesNotMatch(selector, /aria-label/, "the question guard matched a translated label");
			if (selector.includes('aria-checked="true"')) return checked > 0 ? {} : null;
			if (selector.includes('_footerActions')) return { querySelectorAll: () => [{}, submit] };
			if (selector.includes('_feedback')) return feedback;
			if (selector === "textarea") return { value: custom };
			return null;
		},
	};
}

/** A synthetic keydown; only what the rule reads. */
function enterKey(overrides = {}) {
	const event = {
		key: "Enter",
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		isComposing: false,
		keyCode: 13,
		prevented: 0,
		stopped: 0,
		preventDefault() {
			event.prevented += 1;
		},
		stopPropagation() {
			event.stopped += 1;
		},
		stopImmediatePropagation() {},
		...overrides,
	};
	return event;
}

test("question listeners detach on field replacement, card removal and plugin disposal", () => {
	const booted = bootClient({ mode: "mobile", narrow: true });
	const behavior = booted.sandbox.__RDSH_MOBILE_UX__.questionCard;
	const eventTarget = () => {
		const listeners = new Map();
		return {
			listeners,
			addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
			removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
			emit(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
		};
	};
	const field1 = eventTarget(), field2 = eventTarget();
	let currentField = field1;
	const submit = {};
	const card = Object.assign(eventTarget(), {
		querySelector(selector) {
			if (selector === "textarea") return currentField;
			if (selector.includes("_options")) return {};
			if (selector.includes("_footerActions")) return { querySelectorAll: () => [submit] };
			return null;
		},
		removeAttribute() {}, setAttribute() {}, contains() { return false; },
	});
	behavior.install(card);
	behavior.install(card);
	assert.equal(field1.listeners.get("keydown").size, 1);
	const first = enterKey(); field1.emit("keydown", first);
	assert.equal(first.stopped, 1);
	currentField = field2; behavior.install(card);
	assert.equal(field1.listeners.get("keydown").size, 0);
	assert.equal(field2.listeners.get("keydown").size, 1);
	behavior.clear(card);
	assert.equal(field2.listeners.get("keydown").size, 0);
	assert.equal(card.listeners.get("click").size, 0);
	behavior.install(card);
	booted.disposeAll();
	assert.equal(field2.listeners.get("keydown").size, 0);
	assert.equal(card.listeners.get("focusin").size, 0);
	const after = enterKey(); field2.emit("keydown", after);
	assert.equal(after.stopped, 0, "disposed plugin must not intercept Enter");
});

test("#26 a question with options needs one selected, a free-text question does not", () => {
	const booted = bootClient({ mode: "mobile", narrow: true });
	const { needsSelection } = booted.sandbox.__RDSH_MOBILE_UX__.questionCard;

	assert.equal(needsSelection(questionCardFixture({ options: 2, checked: 0 })), true, "an empty question was accepted");
	assert.equal(needsSelection(questionCardFixture({ options: 2, checked: 1 })), false, "a chosen option was rejected");
	assert.equal(needsSelection(questionCardFixture({ options: 3, checked: 2 })), false, "two multi-select choices were rejected");
	assert.equal(needsSelection(questionCardFixture({ options: 2, custom: "custom answer" })), false, "a custom answer alongside options was rejected");
	assert.equal(needsSelection(questionCardFixture({ options: 2, custom: "  \n " })), true, "blank custom text was accepted");
	// A free-text-only question has no options to choose, so its text is the answer.
	assert.equal(needsSelection(questionCardFixture({ options: 0 })), null, "a free-text-only question became unsendable");
	booted.disposeAll();
});

test("#26 Enter in the answer field breaks the line; only Cmd/Ctrl+Enter sends", () => {
	const booted = bootClient({ mode: "mobile", narrow: true, copy: COPY, lang: "ja" });
	const { keyDown } = booted.sandbox.__RDSH_MOBILE_UX__.questionCard;

	const plain = enterKey();
	const plainCard = questionCardFixture({ options: 2, checked: 1 });
	keyDown(plain, plainCard);
	assert.equal(plain.stopped, 1, "plain Enter was left to upstream's submit handler");
	assert.equal(plain.prevented, 0, "plain Enter lost its newline");
	assert.equal(plainCard.clicks, 0, "plain Enter submitted the question");

	const shifted = enterKey({ shiftKey: true });
	keyDown(shifted, plainCard);
	assert.equal(shifted.prevented, 0, "Shift+Enter lost its newline");
	assert.equal(shifted.stopped, 0, "Shift+Enter was intercepted needlessly");

	const composing = enterKey({ isComposing: true });
	keyDown(composing, plainCard);
	assert.equal(composing.stopped, 0, "an IME confirm was intercepted");
	assert.equal(plainCard.clicks, 0, "an IME confirm submitted the question");

	const chord = enterKey({ ctrlKey: true });
	const empty = questionCardFixture({ options: 2, checked: 0 });
	keyDown(chord, empty);
	assert.equal(chord.prevented, 1, "Cmd/Ctrl+Enter was not taken over");
	assert.equal(empty.clicks, 0, "Cmd/Ctrl+Enter sent a zero-selection answer");
	assert.equal(empty.feedback.textContent, COPY.ja["question.selectRequired"], "the missing choice was not explained in ja");

	const meta = enterKey({ metaKey: true });
	const chosen = questionCardFixture({ options: 2, checked: 1 });
	keyDown(meta, chosen);
	assert.equal(chosen.clicks, 1, "Cmd/Ctrl+Enter did not press the submit button");
	assert.equal(chosen.feedback.textContent, "", "a valid send showed the missing-choice message");

	const customWithOptions = questionCardFixture({ options: 2, custom: "custom answer" });
	keyDown(enterKey({ ctrlKey: true }), customWithOptions);
	assert.equal(customWithOptions.clicks, 1, "a custom answer with options could not be submitted");
	const freeText = enterKey({ ctrlKey: true });
	const onlyText = questionCardFixture({ options: 0 });
	keyDown(freeText, onlyText);
	assert.equal(onlyText.clicks, 1, "a free-text-only question could not be sent from the keyboard");
	booted.disposeAll();
});


test("#26 the missing-choice message clears when a choice lands, an upstream error stays", () => {
	const booted = bootClient({ mode: "mobile", narrow: true, copy: COPY, lang: "ja" });
	const { clearFeedback } = booted.sandbox.__RDSH_MOBILE_UX__.questionCard;
	const card = questionCardFixture({ options: 2, checked: 1 });
	card.feedback.textContent = COPY.ja["question.selectRequired"];
	clearFeedback(card);
	assert.equal(card.feedback.textContent, "", "the refusal stayed after a choice was made");
	card.feedback.textContent = COPY.en["question.selectRequired"];
	clearFeedback(card);
	assert.equal(card.feedback.textContent, COPY.en["question.selectRequired"], "an en refusal was not cleared");
	card.feedback.textContent = "Please complete this question first.";
	clearFeedback(card);
	assert.equal(card.feedback.textContent, "Please complete this question first.", "an upstream error was cleared");
	booted.disposeAll();
});
