/**
 * The desktop client half is a hard no-op.
 *
 * The user's contract is "a PC is not changed at all": on a desktop the plugin
 * must not build a part, require React, register a slot, touch the DOM, write a
 * style, read storage, register a service worker, install a listener, queue a
 * timer or call fetch. These tests drive the *real* `client.js` in a VM and
 * record every one of those operations, then assert the log is empty.
 *
 * A positive control boots the same bundle in mobile mode and shows the same
 * recorder filling up — otherwise "nothing happened" could just mean the
 * harness was broken.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/**
 * A sandbox that logs every side effect instead of performing it.
 *
 * Reads that the contract allows before the no-op gate (`documentElement`'s
 * mode attribute) are logged too, so a test can pin exactly how far a desktop
 * boot is allowed to look.
 */
function recordingSandbox({ mode, attr = null, saved = {}, width = 390 } = {}) {
	const events = [];
	const requireCalls = [];
	const ctxCalls = [];
	const slotNames = [];
	const attributes = new Map();
	const context = vm.createContext({});
	if (attr !== null) attributes.set("data-rdsh-device-mode", attr);

	const track = (label) => (...args) => {
		events.push(label);
		return undefined;
	};
	const documentElement = {
		getAttribute(name) {
			events.push(`documentElement.getAttribute:${name}`);
			return attributes.has(name) ? attributes.get(name) : null;
		},
		setAttribute(name) {
			events.push(`documentElement.setAttribute:${name}`);
			attributes.set(name, "");
		},
		removeAttribute(name) {
			events.push(`documentElement.removeAttribute:${name}`);
			attributes.delete(name);
		},
		hasAttribute(name) {
			events.push(`documentElement.hasAttribute:${name}`);
			return attributes.has(name);
		},
		toggleAttribute(name) {
			events.push(`documentElement.toggleAttribute:${name}`);
		},
		get style() {
			events.push("documentElement.style");
			return { setProperty: track("style.setProperty"), removeProperty: track("style.removeProperty") };
		},
	};
	const element = () => ({
		setAttribute: track("element.setAttribute"),
		removeAttribute: track("element.removeAttribute"),
		append: track("element.append"),
		remove: track("element.remove"),
		addEventListener: track("element.addEventListener"),
		querySelector: track("element.querySelector"),
		style: { setProperty: track("style.setProperty"), removeProperty: track("style.removeProperty") },
	});
	const document = {
		documentElement,
		head: { append: track("head.append"), appendChild: track("head.appendChild"), querySelector: track("head.querySelector") },
		body: { append: track("body.append"), appendChild: track("body.appendChild"), querySelector: track("body.querySelector") },
		createElement(label) {
			events.push(`createElement:${label}`);
			return element();
		},
		createTextNode: track("createTextNode"),
		createRange: track("createRange"),
		addEventListener: track("document.addEventListener"),
		removeEventListener: track("document.removeEventListener"),
		querySelector: track("document.querySelector"),
		querySelectorAll: track("document.querySelectorAll"),
		getElementById: track("document.getElementById"),
		styleSheets: [],
		visibilityState: "visible",
	};
	const storage = {
		getItem: track("localStorage.getItem"),
		setItem: track("localStorage.setItem"),
		removeItem: track("localStorage.removeItem"),
		key: track("localStorage.key"),
		get length() {
			events.push("localStorage.length");
			return 0;
		},
	};
	const mediaQuery = { matches: false, addEventListener: track("matchMedia.addEventListener"), removeEventListener: track("matchMedia.removeEventListener") };
	const window = {
		__ModuleLoader__: {
			load(value) {
				window.__definition = value;
			},
		},
		addEventListener: track("window.addEventListener"),
		removeEventListener: track("window.removeEventListener"),
		matchMedia(query) {
			events.push(`matchMedia:${query}`);
			return mediaQuery;
		},
		innerWidth: width,
		innerHeight: 844,
		devicePixelRatio: 3,
		localStorage: storage,
		sessionStorage: storage,
		navigator: {
			get serviceWorker() {
				events.push("navigator.serviceWorker");
				return undefined;
			},
			get userAgent() {
				events.push("navigator.userAgent");
				return "Mozilla/5.0";
			},
			get platform() {
				events.push("navigator.platform");
				return "";
			},
			get maxTouchPoints() {
				events.push("navigator.maxTouchPoints");
				return 0;
			},
		},
		location: { origin: "http://localhost:3080", href: "http://localhost:3080/", pathname: "/", search: "", hash: "" },
		screen: { width, height: 844 },
		performance: { now: () => 0 },
		setTimeout: track("setTimeout"),
		clearTimeout: track("clearTimeout"),
		setInterval: track("setInterval"),
		clearInterval: track("clearInterval"),
		requestAnimationFrame: track("requestAnimationFrame"),
		cancelAnimationFrame: track("cancelAnimationFrame"),
		fetch: track("fetch"),
	};
	const sandbox = {
		window,
		document,
		navigator: window.navigator,
		location: window.location,
		localStorage: storage,
		sessionStorage: storage,
		screen: window.screen,
		performance: window.performance,
		matchMedia: (query) => window.matchMedia(query),
		addEventListener: window.addEventListener,
		removeEventListener: window.removeEventListener,
		setTimeout: window.setTimeout,
		clearTimeout: window.clearTimeout,
		setInterval: window.setInterval,
		clearInterval: window.clearInterval,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		fetch: window.fetch,
		getComputedStyle: track("getComputedStyle"),
		MutationObserver: class {
			constructor() {
				events.push("new MutationObserver");
			}
			observe() {
				events.push("MutationObserver.observe");
			}
			disconnect() {}
		},
		IntersectionObserver: class {
			constructor() {
				events.push("new IntersectionObserver");
			}
			observe() {
				events.push("IntersectionObserver.observe");
			}
			disconnect() {}
		},
		Element: class Element {},
		HTMLElement: class HTMLElement {},
		Node: class Node {},
		Event: class Event {},
		CustomEvent: class CustomEvent {},
		PointerEvent: class PointerEvent {},
		KeyboardEvent: class KeyboardEvent {},
		TouchEvent: class TouchEvent {},
		Touch: class Touch {},
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		console: { error(...a) { events.push("console.error:" + String(a[1] && (a[1].stack || a[1].message) || a[0]).slice(0, 400)); }, warn() {}, log() {}, info() {} },
		__RDSH_PWA_PROBES__: PROBES,
		__RDSH_PWA_COPY__: COPY,
		...saved,
	};
	if (mode !== undefined) sandbox.__RDSH_DEVICE_MODE__ = mode;
	// The real page exposes these through `window` as well; the parts use both.
	window.document = document;
	window.navigator = window.navigator;
	window.localStorage = storage;
	window.sessionStorage = storage;
	window.location = window.location;
	window.setTimeout = window.setTimeout;
	window.clearTimeout = window.clearTimeout;
	window.setInterval = window.setInterval;
	window.clearInterval = window.clearInterval;
	window.requestAnimationFrame = window.requestAnimationFrame;
	window.cancelAnimationFrame = window.cancelAnimationFrame;
	window.getComputedStyle = sandbox.getComputedStyle;
	sandbox.globalThis = sandbox;
	window.__definition = undefined;
	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	const definition = window.__definition;
	assert.ok(definition !== undefined, "the module registered itself");
	// Enough of the three allowed modules that the mobile parts can build; a
	// desktop boot must never ask for them in the first place.
	const react = {
		createElement: () => ({}),
		Fragment: "Fragment",
		useState: () => [null, () => {}],
		useEffect: () => {},
		useRef: () => ({ current: null }),
		useMemo: (factory) => factory(),
		useCallback: (factory) => factory,
		memo: (value) => value,
	};
	const requireStub = (name) => {
		requireCalls.push(name);
		if (name === "react") return react;
		if (name === "react-dom/client") return { createRoot: () => ({ render() {} }) };
		return {};
	};
	const ctx = {
		effect() {
			ctxCalls.push("effect");
			return () => {};
		},
		inject() {
			ctxCalls.push("inject");
			return () => {};
		},
		slots: {
			inject(name) {
				ctxCalls.push("slots.inject");
				slotNames.push(String(name));
				return () => {};
			},
			register() {
				ctxCalls.push("slots.register");
				return () => {};
			},
		},
		get() {
			ctxCalls.push("get");
			return undefined;
		},
		on() {
			ctxCalls.push("on");
			return () => {};
		},
	};
	return {
		definition,
		events,
		requireCalls,
		ctxCalls,
		slotNames,
		attributes,
		context,
		build: () => definition.factory(requireStub),
		apply: (plugin) => plugin.apply(ctx),
	};
}

/** Everything a desktop boot must not do, in one list. */
function sideEffects(log, { allowMarkerRead = false } = {}) {
	return log.filter((entry) => !(allowMarkerRead && entry === "documentElement.getAttribute:data-rdsh-device-mode"));
}

test("a desktop boot is a no-op: no part, no require, no slot, no DOM, no storage", () => {
	for (const width of [390, 1024]) {
		const run = recordingSandbox({ mode: "desktop", width, saved: { __RDSH_PWA_LANG__: "ja" } });
		const plugin = run.build();
		assert.equal(typeof plugin.apply, "function", "the module did not return a usable plugin");
		assert.equal(plugin.inject, undefined, "a desktop plugin declared slot dependencies");
		run.apply(plugin);
		assert.deepEqual(run.requireCalls, [], `a desktop at ${width}px required a module`);
		assert.deepEqual(run.ctxCalls, [], `a desktop at ${width}px used the plugin context`);
		// An injected global answers the question before the DOM is consulted.
		assert.deepEqual(run.events, [], `a desktop at ${width}px touched the page`);
		assert.deepEqual([...run.attributes.keys()], [], `a desktop at ${width}px wrote a marker`);
	}
});

test("a missing bootstrap reads the marker once, then stops", () => {
	const run = recordingSandbox({ width: 390 });
	const plugin = run.build();
	run.apply(plugin);
	assert.deepEqual(run.requireCalls, []);
	assert.deepEqual(run.ctxCalls, []);
	// The single allowed read is the host's own marker; nothing is written.
	assert.deepEqual(run.events, ["documentElement.getAttribute:data-rdsh-device-mode"]);
	assert.equal(run.attributes.has("data-rdsh-device-mode"), false, "the client wrote a marker it does not own");
});

test("an invalid global falls back to a valid marker, and a valid global wins", () => {
	// No marker: an invalid global has nothing to fall back to, so desktop.
	const bare = recordingSandbox({ mode: "tablet", width: 390 });
	const barePlugin = bare.build();
	bare.apply(barePlugin);
	assert.deepEqual(sideEffects(bare.events, { allowMarkerRead: true }), [], "an invalid global touched the page");
	assert.deepEqual(bare.ctxCalls, [], "an invalid global built a part");

	// A valid mobile marker is the documented fallback and must boot.
	const fallback = recordingSandbox({ mode: "tablet", attr: "mobile", width: 390 });
	const fallbackPlugin = fallback.build();
	assert.equal(Array.isArray(fallbackPlugin.inject) || fallbackPlugin.inject !== undefined, true, "the mobile fallback did not build");

	// A valid desktop global wins over a contradictory marker and stays no-op.
	const desktop = recordingSandbox({ mode: "desktop", attr: "mobile", width: 390 });
	const desktopPlugin = desktop.build();
	desktop.apply(desktopPlugin);
	assert.deepEqual(desktop.ctxCalls, [], "the contradictory marker built the mobile half");
	assert.equal(desktop.attributes.get("data-rdsh-device-mode"), "mobile", "the client rewrote the host marker");
	assert.deepEqual(desktop.events, [], "a valid desktop global still read the page");
});

test("saved opt-ins, themes and install state never wake a desktop", () => {
	const run = recordingSandbox({
		mode: "desktop",
		width: 390,
		saved: { __RDSH_PWA_LANG__: "ja" },
	});
	// A browser that used the plugin before still has these keys.
	run.attributes.set("ignored", "");
	const plugin = run.build();
	run.apply(plugin);
	assert.deepEqual(run.events, [], "a desktop with saved state touched the page");
	assert.deepEqual(run.ctxCalls, [], "a desktop with saved state built a part");
});

test("the same recorder fills up in mobile mode (positive control, 390 and 1024)", () => {
	for (const width of [390, 1024]) {
		const run = recordingSandbox({ mode: "mobile", width });
		const plugin = run.build();
		assert.notEqual(plugin.inject, undefined, `mobile at ${width}px collapsed into the no-op`);
		assert.deepEqual(run.requireCalls, [], "the parts are built by apply, not by the factory");
		run.apply(plugin);
		assert.ok(run.requireCalls.includes("react"), `mobile at ${width}px did not require React`);
		assert.ok(run.ctxCalls.includes("slots.inject"), `mobile at ${width}px registered no slot`);
		// The Settings sections are the tabs the user saw appear on a PC.
		assert.ok(run.slotNames.includes("settings.section"), `mobile at ${width}px registered no Settings section`);
	}
});
