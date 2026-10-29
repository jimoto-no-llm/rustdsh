/**
 * #44 desktop/mobile boundary and #46 right-panel layering.
 *
 * The regex checks in `client-integrity.test.mjs` pin the source shape. This
 * file drives the actual transition instead: the module is booted in a stub
 * browser, the width predicate is flipped 767→768→767, `syncWidth()` is
 * called exactly as the media-query listener calls it, and the resulting DOM
 * is inspected. It also parses the two stylesheets the browser receives and
 * proves the phone half is wrapped mechanically.
 *
 * The browser geometry check for #46 lives in `boundary-layering.e2e.mjs`
 * (run with the CDP endpoint); this file cannot measure layout.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------ */
/* Stylesheet parsing                                                  */
/* ------------------------------------------------------------------ */

function cssTemplate(name) {
	const tick = String.fromCharCode(96);
	const match = CLIENT.match(new RegExp(`const ${name} = ${tick}([\\s\\S]*?)${tick};\\n`));
	assert.ok(match, `${name} exists`);
	// The exit/split selectors are assembled from PROBES at runtime; render the
	// same text here so the rule assertions still read ordinary CSS. The split
	// selector is built from the live probe table, so a missing ja label fails
	// the stylesheet assertion below.
	const rightPanelExit = '[data-rdsh-rightpanel] [aria-label="Exit fullscreen"], [data-rdsh-rightpanel] [aria-label="全画面表示を終了"]';
	const rightPanelSplit = PROBES.split
		.map((label) => `[data-rdsh-rightpanel] [aria-label="${label}"]`)
		.join(", ");
	return match[1]
		.replace(/\$\{NARROW_QUERY\}/g, "(max-width: 767px)")
		.replace(/\$\{RIGHT_PANEL_EXIT\}/g, rightPanelExit)
		.replace(/\$\{RIGHT_PANEL_SPLIT\}/g, rightPanelSplit);
}

function cssBlocks() {
	return [cssTemplate("CSS"), cssTemplate("CSS_DEVICE"), cssTemplate("CSS_PHONE")];
}

/** One entry per declaration block, with the chain of enclosing at-rules. */
function cssRules(css) {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	const stack = [];
	let current = "";
	for (const character of source) {
		if (character === "{") {
			stack.push(current.trim());
			if (current.trim() !== "") rules.push({ head: current.trim(), at: [...stack.slice(0, -1)] });
			current = "";
			continue;
		}
		if (character === "}") {
			stack.pop();
			current = "";
			continue;
		}
		current += character;
	}
	return rules;
}

test("the mobile stylesheet is a separate mode-scoped style node", () => {
	const phone = cssTemplate("CSS_PHONE");
	assert.doesNotMatch(phone, /@media \(max-width: 767px\)/, "the mobile sheet regained a width wrapper");
	assert.equal((CLIENT.match(/@media \(max-width: 767px\)/g) ?? []).length, 0, "a literal width feature query was hand-written");
	assert.match(CLIENT, /setAttribute\("data-rdsh-mux-style", "phone"\)/, "the mobile sheet is not a separate style node");
	assert.match(CLIENT, /if \(phone\(\)\) \{[\s\S]{0,200}?phoneStyle = document\.createElement\("style"\)/, "the mobile sheet is not inserted by mode");
});

test("the device stylesheet only contains self-owned rules", () => {
	// The desktop half is the plugin's own Settings/toast chrome. Safe-area
	// rules are not here: env() is non-zero on a wide iPad in standalone mode,
	// so even those are phone-only under the #44 width contract.
	const allowed = [/^\.rdsh-mux-/];
	const upstream = cssRules(cssTemplate("CSS_DEVICE")).filter((rule) => !rule.at.some((head) => head.startsWith("@")));
	const leaked = upstream.filter((rule) => !allowed.some((pattern) => pattern.test(rule.head)));
	assert.deepEqual(leaked.map((rule) => rule.head), [], "a desktop stylesheet rule targets upstream layout");
	// The session colour frame lives in the mobile sheet, which a desktop
	// never receives.
	const phone = cssTemplate("CSS_PHONE");
	assert.match(phone, /\[data-rdsh-session-frame\]/, "the frame rule is missing from the mobile sheet");
});

test("#46 keeps the header in flow and lifts the panel's column", () => {
	const phone = cssTemplate("CSS_PHONE");
	assert.equal(
		/header\[data-rdsh-header\]\s*\{[^}]*display:\s*none/.test(phone),
		false,
		"the open panel still removes the header from layout",
	);
	assert.equal(
		/header\[data-rdsh-header\]\s*\{[^}]*visibility:\s*hidden/.test(phone),
		false,
		"the open panel hides the header with visibility instead of layering",
	);
	const column = cssRules(phone).find((rule) => rule.head === "[data-rdsh-frame] [data-rdsh-rightbar-col]");
	assert.ok(column, "the right column is not lifted");
	assert.match(phone, /\[data-rdsh-frame\] \[data-rdsh-rightbar-col\] \{ z-index: 60; \}/, "the panel column has no stacking order above the header");
	assert.match(
		phone,
		/\[data-rdsh-frame\] \[data-sidebar-right-panel\] \{ z-index: 60; \}/,
		"the upstream panel root is not lifted",
	);
	const panel = phone.slice(phone.indexOf("[data-rdsh-rightpanel] {"), phone.indexOf("[data-rdsh-rightpanel] table"));
	assert.match(panel, /isolation: isolate;/, "the panel layer has no stacking context");
	assert.equal(/position:/.test(panel), false, "the panel layer overrides upstream's own position");
	// The hamburger is no longer hidden when the panel opens: the panel column
	// and the upstream root now overlay it (60 vs 40). A hide rule coming back
	// would mean the stacking order regressed.
	assert.match(CLIENT, /\.rdsh-mux-fab \{[^}]*z-index: 40;/, "the FAB is no longer below the open panel");
	assert.equal(/html\[data-rdsh-rightpanel-open\] \.rdsh-mux-fab/.test(phone), false, "the FAB hide rule is back");
});

/* ------------------------------------------------------------------ */
/* A tiny real DOM, enough for a width transition                      */
/* ------------------------------------------------------------------ */

class FakeStyle {
	constructor() {
		this.properties = new Map();
		this.colorScheme = "";
	}
	setProperty(name, value) {
		this.properties.set(name, String(value));
	}
	removeProperty(name) {
		this.properties.delete(name);
	}
	getPropertyValue(name) {
		return this.properties.get(name) ?? "";
	}
	get marginBottom() {
		return this.getPropertyValue("margin-bottom");
	}
	set marginBottom(value) {
		this.setProperty("margin-bottom", value);
	}
}

class FakeNode {
	constructor(tag = "div") {
		this.tagName = String(tag).toUpperCase();
		this.attributes = new Map();
		this.children = [];
		this.parentNode = null;
		this.style = new FakeStyle();
		this.dataset = {};
		this.className = "";
		this.value = "";
		this.disabled = false;
		this.textContent = "";
		this.innerHTML = "";
		this.hidden = false;
		this.isConnected = false;
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	hasAttribute(name) {
		return this.attributes.has(name);
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	toggleAttribute(name, force) {
		if (force === true) this.attributes.set(name, "");
		else if (force === false || force === undefined) this.attributes.delete(name);
	}
	append(...nodes) {
		for (const node of nodes) {
			if (node === null || node === undefined) continue;
			node.parentNode = this;
			node.markConnected(this.isConnected || this.tagName === "BODY");
			this.children.push(node);
		}
	}
	prepend(node) {
		node.parentNode = this;
		node.markConnected(this.isConnected || this.tagName === "BODY");
		this.children.unshift(node);
	}
	appendChild(node) {
		this.append(node);
		return node;
	}
	remove() {
		if (this.parentNode === null) return;
		const index = this.parentNode.children.indexOf(this);
		if (index !== -1) this.parentNode.children.splice(index, 1);
		this.parentNode = null;
		this.markConnected(false);
	}
	markConnected(value) {
		this.isConnected = value;
		for (const child of this.children) child.markConnected(value);
	}
	querySelectorAll(selector) {
		return selectAll(this, selector);
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	closest() {
		return null;
	}
	contains(node) {
		if (node === this) return true;
		return this.children.some((child) => child.contains(node));
	}
	addEventListener() {}
	removeEventListener() {}
	focus() {}
	blur() {}
	click() {}
	getBoundingClientRect() {
		return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}
}

/** The last compound of each comma branch, then every simple token on it. */
function selectorMatcher(selector) {
	const branches = selector.split(",").map((branch) => branch.trim()).filter((branch) => branch !== "");
	const compounds = branches.map((branch) => {
		const parts = [];
		let current = "";
		let quote = null;
		let depth = 0;
		for (const character of branch) {
			if (quote !== null) {
				current += character;
				if (character === quote) quote = null;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				current += character;
				continue;
			}
			if (character === "[") depth += 1;
			else if (character === "]") depth -= 1;
			if (/\s/.test(character) && depth === 0) {
				if (current !== "") parts.push(current);
				current = "";
				continue;
			}
			current += character;
		}
		if (current !== "") parts.push(current);
		return parts[parts.length - 1] ?? "";
	});
	return (node) => compounds.some((compound) => matchesCompound(node, compound));
}

function matchesCompound(node, compound) {
	if (compound === "") return false;
	const classMatch = compound.match(/^\.([A-Za-z0-9_-]+)/);
	if (classMatch !== null) {
		if (!String(node.className).split(/\s+/).includes(classMatch[1])) return false;
		compound = compound.slice(classMatch[0].length);
	}
	const tagMatch = compound.match(/^[A-Za-z][A-Za-z0-9-]*/);
	if (tagMatch !== null) {
		if (node.tagName !== tagMatch[0].toUpperCase()) return false;
		compound = compound.slice(tagMatch[0].length);
	}
	const attributes = [...compound.matchAll(/\[([A-Za-z0-9_-]+)(?:([~^$*|]?=)(?:"([^"]*)"|'([^']*)'))?\]/g)];
	for (const [, name, operator, doubleQuoted, singleQuoted] of attributes) {
		if (!node.hasAttribute(name)) return false;
		if (operator === undefined) continue;
		const value = doubleQuoted ?? singleQuoted ?? "";
		const actual = node.getAttribute(name);
		if (operator === "=" && actual !== value) return false;
		if (operator === "^=" && !actual.startsWith(value)) return false;
		if (operator === "*=" && !actual.includes(value)) return false;
	}
	return attributes.length > 0 || classMatch !== null || tagMatch !== null;
}

function selectAll(root, selector, includeRoot = false) {
	const match = selectorMatcher(selector);
	const out = [];
	const walk = (node) => {
		if ((includeRoot || node !== root) && match(node)) out.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return out;
}

function makeDocument() {
	const html = new FakeNode("html");
	const head = new FakeNode("head");
	const body = new FakeNode("body");
	html.markConnected(true);
	html.append(head, body);
	const doc = {
		documentElement: html,
		head,
		body,
		activeElement: null,
		visibilityState: "visible",
		styleSheets: [],
		querySelectorAll: (selector) => selectAll(html, selector, true),
		querySelector: (selector) => selectAll(html, selector, true)[0] ?? null,
		getElementById: () => null,
		createElement: (tag) => new FakeNode(tag),
		addEventListener() {},
		removeEventListener() {},
		execCommand: () => false,
	};
	return doc;
}

function memoryStorage(seed = {}) {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
		clear: () => map.clear(),
	};
}

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

/**
 * Boot the module with a mutable width.
 *
 * Animation frames are queued instead of run, so a test can dispose first and
 * then flush the frames a boot/decorate/theme pass left behind. The assertions
 * are about the boundary path itself: `syncWidth()` is what the media listener
 * calls.
 */
function bootBoundary({ mode = null, narrow = true, seed = {}, safeTop = 0, safeLeft = 0, safeRight = 0, width = narrow ? 390 : 1024 } = {}) {
	const viewport = { narrow };
	const deviceMode = mode ?? (narrow ? "mobile" : "desktop");
	const document = makeDocument();
	const disposers = [];
	const frames = [];
	const meta = new FakeNode("meta");
	meta.setAttribute("name", "viewport");
	meta.setAttribute("content", "width=device-width, initial-scale=1");
	document.head.append(meta);
	const theme = { getTheme: () => ({ preference: "light", active: { colorScheme: "light", tokens: {} } }) };
	let definition;
	const windowListeners = new Map();
	const sandbox = {
		__RDSH_PWA_COPY__: COPY,
		__RDSH_PWA_PROBES__: PROBES,
		window: {
			__ModuleLoader__: { load(value) { definition = value; } },
			addEventListener(type, handler) { windowListeners.set(type, handler); },
			removeEventListener(type) { windowListeners.delete(type); },
		},
		document,
		navigator: stub(),
		location: stub(),
		localStorage: memoryStorage(seed),
		sessionStorage: memoryStorage(),
		matchMedia: (query) => ({
			matches: viewport.narrow && String(query).includes("max-width: 767px"),
			addEventListener() {},
			removeEventListener() {},
		}),
		addEventListener() {},
		removeEventListener() {},
		setTimeout: () => 0,
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
		cancelAnimationFrame() {},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		getComputedStyle: () => ({ paddingTop: `${safeTop}px`, paddingBottom: "0px", paddingLeft: `${safeLeft}px`, paddingRight: `${safeRight}px`, overflowY: "", overflowX: "", visibility: "visible", backgroundColor: "", rowGap: "0", getPropertyValue: () => "" }),
		console,
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		fetch: () => Promise.resolve(stub()),
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
		Notification: stub(),
		AudioContext: class AudioContext {},
		screen: stub(),
		innerWidth: width,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
		queueMicrotask,
		globalThis: undefined,
	};
	sandbox.globalThis = sandbox;
	for (const name of ["document", "matchMedia", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "location", "navigator", "localStorage", "screen", "performance", "innerWidth", "innerHeight", "addEventListener", "removeEventListener"]) {
		sandbox.window[name] = sandbox[name];
	}
	sandbox.__RDSH_DEVICE_MODE__ = deviceMode;
	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "the module registered itself");

	const plugin = definition.factory((name) => stub());
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
			register() {
				return () => {};
			},
		},
		get: (name) => (name === "theme" ? theme : undefined),
		on: () => () => {},
	};
	plugin.apply(ctx);
	const api = sandbox.__RDSH_MOBILE_UX__;
	// Desktop builds no plugin: there is no diagnostics object to read.
	if (deviceMode !== "mobile") assert.equal(api, undefined, "a desktop boot published mobile diagnostics");
	else assert.ok(api !== undefined, "the diagnostics surface is live");
	return {
		api,
		document,
		meta,
		viewport,
		deviceMode,
		disposers,
		theme,
		html: document.documentElement,
		body: document.body,
		setWidth(next) {
			viewport.narrow = next;
			// A desktop has no geometry readout: the no-op has no syncWidth.
			api?.syncWidth?.();
		},
		/** Run every queued frame, including ones queued while flushing. */
		flushFrames() {
			const pending = frames.splice(0);
			for (const callback of pending) callback();
			if (frames.length > 0) {
				const next = frames.splice(0);
				for (const callback of next) callback();
			}
		},
		dispose() {
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

/** Attach a node to the body so `document.querySelectorAll` can see it. */
function seed(booted, tag, attributes = {}) {
	const node = new FakeNode(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	booted.body.append(node);
	return node;
}

const PHONE_SAMPLE = {
	"[data-rdsh-header]": "header",
	"[data-rdsh-frame]": "div",
	"[data-rdsh-rightpanel]": "div",
	"[data-rdsh-session]": "div",
	"[data-rdsh-session-frame]": "div",
	"[data-rdsh-folder-frame]": "div",
	"[data-rdsh-folder-menu]": "div",
	"[data-rdsh-question-card]": "div",
	"[data-rdsh-todo-item]": "li",
	"[data-rdsh-transcript]": "div",
	"[data-rdsh-queue-dock]": "div",
	"[data-rdsh-settings-nav-arrow]": "button",
	"[data-rdsh-activity-icon]": "span",
	"[data-rdsh-typing-layer]": "span",
	"[data-rdsh-crop-button]": "button",
	"[data-rdsh-toast]": "div",
	"[data-rdsh-model-search]": "input",
	"[data-rdsh-stat-text]": "button",
	"[data-rdsh-hide-settings]": "html",
};

test("a narrow desktop stays desktop: no mobile surface and no width entry", () => {
	const booted = bootBoundary({ mode: "desktop", narrow: true, seed: { "dsh-mobile-maxxing:device-theme": "dark" } });
	// A 390px PC gets no phone style, drawer, viewport lock, palette or safe area.
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 0, "a narrow desktop created the drawer button");
	assert.equal(booted.document.head.querySelectorAll("[data-rdsh-mux-style=\"phone\"]").length, 0, "a narrow desktop got the mobile stylesheet");
	assert.equal(booted.meta.getAttribute("content"), "width=device-width, initial-scale=1", "a narrow desktop touched the viewport");
	assert.equal(booted.html.hasAttribute("data-rdsh-anim"), false, "a narrow desktop wrote the animation attribute");
	assert.equal(booted.body.hasAttribute("data-ds-dark-theme"), false, "a narrow desktop got the mobile palette");
	assert.equal(booted.api, undefined, "a narrow desktop built the mobile half");

	booted.setWidth(false);
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 0, "widening a desktop installed mobile chrome");
	assert.equal(booted.document.head.querySelectorAll("[data-rdsh-mux-style=\"phone\"]").length, 0, "widening a desktop added the mobile stylesheet");
	booted.setWidth(true);
	assert.equal(booted.document.head.querySelectorAll("[data-rdsh-mux-style=\"phone\"]").length, 0, "narrowing a desktop added the mobile stylesheet");
	assert.deepEqual(booted.dispose(), [], "dispose threw");
});

test("mobile survives 1024↔390 and only dispose removes its surface", () => {
	const booted = bootBoundary({ mode: "mobile", narrow: false, seed: { "dsh-mobile-maxxing:device-theme": "dark" } });
	booted.flushFrames();
	// A tablet at 1024px is mobile: drawer, sheet, lock and palette exist.
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 1, "a wide mobile boot did not create the drawer button");
	assert.equal(booted.document.head.querySelectorAll("[data-rdsh-mux-style=\"phone\"]").length, 1, "a wide mobile boot did not get the mobile stylesheet");
	assert.match(booted.meta.getAttribute("content"), /maximum-scale=1/, "a wide mobile boot did not lock zoom");
	assert.equal(booted.html.getAttribute("data-rdsh-anim"), "outline", "a wide mobile boot did not set the animation");
	assert.equal(booted.body.hasAttribute("data-ds-dark-theme"), true, "a wide mobile boot did not apply the palette");
	assert.equal(booted.api.phone(), true, "phone() is false on mobile");
	assert.equal(booted.api.state.narrow, false, "the geometry readout should see 1024px");

	const seeded = [];
	for (const [selector, tag] of Object.entries(PHONE_SAMPLE)) {
		if (selector === "[data-rdsh-hide-settings]") {
			booted.html.setAttribute("data-rdsh-hide-settings", "");
			continue;
		}
		seeded.push([selector, seed(booted, tag, { [selector.slice(1, -1)]: "" })]);
	}

	// Crossing 767px is geometry only: every mobile hook and style survives.
	booted.setWidth(true);
	assert.equal(booted.api.state.narrow, true, "the geometry readout did not follow the width");
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 1, "narrowing mobile removed the drawer");
	assert.equal(booted.document.head.querySelectorAll("[data-rdsh-mux-style=\"phone\"]").length, 1, "narrowing mobile removed the mobile stylesheet");
	assert.match(booted.meta.getAttribute("content"), /maximum-scale=1/, "narrowing mobile released the zoom lock");
	for (const [selector, node] of seeded) {
		assert.equal(node.hasAttribute(selector.slice(1, -1)), true, `${selector} was removed by a width crossing`);
	}
	booted.setWidth(false);
	for (const [selector, node] of seeded) {
		assert.equal(node.hasAttribute(selector.slice(1, -1)), true, `${selector} was removed by widening back`);
	}

	assert.deepEqual(booted.dispose(), [], "dispose threw");
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 0, "dispose left the drawer button behind");
	assert.equal(booted.document.head.querySelectorAll("[data-rdsh-mux-style=\"phone\"]").length, 0, "dispose left the mobile stylesheet behind");
	assert.equal(booted.meta.getAttribute("content"), "width=device-width, initial-scale=1", "dispose left the mobile viewport");
	assert.equal(booted.html.hasAttribute("data-rdsh-anim"), false, "dispose left the animation attribute");
	assert.equal(booted.html.hasAttribute("data-rdsh-drawer"), false, "dispose left the drawer state");
	assert.equal(booted.body.hasAttribute("data-ds-dark-theme"), false, "dispose left the mobile palette");
	for (const [selector, node] of seeded) {
		assert.equal(node.isConnected && node.hasAttribute(selector.slice(1, -1)), false, `${selector} survived dispose`);
	}
});

test("a mobile viewport meta this module created is removed on dispose", () => {
	const booted = bootBoundary({ mode: "mobile", narrow: true });
	booted.meta.remove();
	booted.setWidth(true);
	booted.flushFrames();
	const created = booted.document.head.querySelectorAll('meta[name="viewport"]');
	assert.equal(created.length, 1, "no viewport meta was created");
	assert.match(created[0].getAttribute("content"), /maximum-scale=1/);
	booted.dispose();
	assert.equal(booted.document.head.querySelectorAll('meta[name="viewport"]').length, 0, "the owned viewport meta survived dispose");
});

test("a mobile viewport with no content attribute gets that absence back", () => {
	// The baseline can be "no content attribute", which is not the string "".
	const booted = bootBoundary({ mode: "mobile", narrow: true });
	booted.meta.removeAttribute("content");
	booted.setWidth(true);
	booted.flushFrames();
	assert.match(booted.meta.getAttribute("content"), /maximum-scale=1/, "the mobile lock was not applied");
	booted.dispose();
	assert.equal(booted.meta.hasAttribute("content"), false, "the mobile lock content survived as an attribute");
});

test("the mobile viewport merges the keyboard token without duplicating a key", () => {
	const mobile = bootBoundary({ mode: "mobile", narrow: false });
	mobile.flushFrames();
	const content = mobile.meta.getAttribute("content");
	assert.match(content, /interactive-widget=resizes-content/, "the mobile viewport lost the keyboard token");
	assert.match(content, /maximum-scale=1/, "the mobile viewport lost the zoom lock");
	assert.match(content, /viewport-fit=cover/, "the mobile viewport lost edge-to-edge coverage");
	// The shipped tokens survive, and no key is emitted twice by the merge.
	assert.match(content, /width=device-width/);
	const keys = content.split(",").map((token) => token.trim().split("=")[0].toLowerCase());
	assert.equal(new Set(keys).size, keys.length, `a viewport key is duplicated: ${content}`);
	mobile.dispose();
	assert.equal(mobile.meta.getAttribute("content"), "width=device-width, initial-scale=1", "the shipped value was not restored");
});

test("safe-area root padding and style follow the device mode", () => {
	// #59: a landscape notch is reported as a left/right inset, so the module
	// has to publish those too (the popovers read them back).
	const mobile = bootBoundary({ mode: "mobile", narrow: false, safeTop: 47, safeLeft: 59, safeRight: 0 });
	assert.equal(mobile.html.hasAttribute("data-rdsh-safe-top"), true, "a wide mobile device did not write the inset attribute");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-safe-top"), "47px", "a wide mobile device did not write the inset variable");
	assert.equal(mobile.html.hasAttribute("data-rdsh-safe-left"), true, "a landscape notch did not write the left inset attribute");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-safe-left"), "59px", "a landscape notch did not write the left inset variable");
	assert.equal(mobile.html.hasAttribute("data-rdsh-safe-right"), false, "a zero right inset wrote an attribute");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-safe-right"), "0px", "a zero right inset was not written as 0px");
	mobile.setWidth(true);
	assert.equal(mobile.html.hasAttribute("data-rdsh-safe-top"), true, "a rotation removed the inset");
	mobile.dispose();
	assert.equal(mobile.html.hasAttribute("data-rdsh-safe-top"), false, "the safe-area attribute survived dispose");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-safe-top"), "", "the safe-area variable survived dispose");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-safe-left"), "", "the left safe-area variable survived dispose");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-safe-right"), "", "the right safe-area variable survived dispose");
	assert.equal(mobile.html.style.getPropertyValue("--rdsh-native-gap-px"), "", "the native-gap variable survived dispose");

	const desktop = bootBoundary({ mode: "desktop", narrow: true, safeTop: 47 });
	assert.equal(desktop.html.hasAttribute("data-rdsh-safe-top"), false, "a narrow desktop wrote a safe-area inset");
	assert.equal(desktop.html.style.getPropertyValue("--rdsh-safe-top"), "", "a narrow desktop wrote a safe-area variable");
	desktop.dispose();
});

test("a queued frame cannot resurrect the mobile surface after dispose", () => {
	const booted = bootBoundary({ mode: "mobile", narrow: true, seed: { "dsh-mobile-maxxing:device-theme": "dark" } });
	booted.setWidth(true);
	booted.flushFrames();
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 1, "the drawer was not installed");
	assert.match(booted.meta.getAttribute("content"), /maximum-scale=1/, "the mobile lock was not applied");
	assert.equal(booted.body.hasAttribute("data-ds-dark-theme"), true, "the mobile palette was not applied");

	assert.deepEqual(booted.dispose(), [], "dispose threw");
	assert.equal(booted.meta.getAttribute("content"), "width=device-width, initial-scale=1", "dispose did not restore the viewport");
	assert.equal(booted.body.hasAttribute("data-ds-dark-theme"), false, "dispose did not release the palette");

	booted.flushFrames();
	assert.equal(booted.meta.getAttribute("content"), "width=device-width, initial-scale=1", "a stale frame re-locked the viewport");
	assert.equal(booted.body.hasAttribute("data-ds-dark-theme"), false, "a stale frame re-applied the mobile palette");
	assert.equal(booted.html.getAttribute("data-rdsh-device-theme"), null, "a stale frame re-added the device-theme attribute");
	assert.equal(booted.html.hasAttribute("data-rdsh-anim"), false, "a stale frame re-added the animation attribute");
	assert.equal(booted.html.hasAttribute("data-rdsh-drawer"), false, "a stale frame re-added the drawer state");
	assert.equal(booted.body.querySelectorAll(".rdsh-mux-fab").length, 0, "a stale frame re-created the drawer button");
});

/* ------------------------------------------------------------------ */
/* #72 iPad split view: the tablet tier inside the mobile surface      */
/* ------------------------------------------------------------------ */

/** A right-panel fixture shaped like upstream's frame/panel DOM. */
function wireClosest(node) {
	node.closest = function closest(selector) {
		let current = this;
		while (current !== null && current !== undefined) {
			if (selector === "[data-sidebar-right-panel]" && current.hasAttribute("data-sidebar-right-panel")) return current;
			if (selector === "[hidden]" && current.hasAttribute("hidden")) return current;
			if (selector === "[data-rdsh-rightpanel]" && current.hasAttribute("data-rdsh-rightpanel")) return current;
			current = current.parentElement ?? null;
		}
		return null;
	};
}

function ipadFrame(booted) {
	const root = new FakeNode("div");
	const slot = new FakeNode("div");
	const frame = new FakeNode("div");
	const center = new FakeNode("div");
	const rightbar = new FakeNode("div");
	frame.className = "_frame";
	center.className = "_centerCol";
	rightbar.className = "_rightbarCol";
	frame.append(center, rightbar);
	slot.append(frame);
	root.append(slot);
	root.firstElementChild = slot;
	slot.firstElementChild = frame;
	booted.body.append(root);
	booted.document.getElementById = (id) => (id === "root" ? root : null);
	return { frame, center, rightbar };
}

function ipadPanel(booted, { viewportWidth, dockWidth, open = true, label = "Fullscreen" }) {
	const boundary = new FakeNode("div");
	boundary.setAttribute("data-sidebar-right-panel", "push");
	if (open) boundary.setAttribute("data-sidebar-right-open", "");
	const panel = new FakeNode("div");
	panel.className = "_panel";
	const collapse = new FakeNode("button");
	// #97: upstream's stable panel-toggle attribute; the label is localised.
	collapse.setAttribute("data-sidebar-right-toggle", "");
	collapse.setAttribute("aria-label", "Collapse right sidebar");
	const fullscreen = new FakeNode("button");
	fullscreen.setAttribute("aria-label", label);
	const rect = (width) => () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 844, width, height: 844 });
	collapse.getBoundingClientRect = rect(30);
	fullscreen.getBoundingClientRect = rect(30);
	panel.getBoundingClientRect = rect(viewportWidth);
	boundary.getBoundingClientRect = rect(dockWidth);
	panel.append(collapse, fullscreen);
	boundary.append(panel);
	booted.body.append(boundary);
	boundary.parentElement = booted.body;
	panel.parentElement = boundary;
	collapse.parentElement = panel;
	fullscreen.parentElement = panel;
	for (const node of [boundary, panel, collapse, fullscreen]) wireClosest(node);
	let clicks = 0;
	fullscreen.click = () => {
		clicks += 1;
	};
	return { boundary, panel, fullscreen, clicks: () => clicks };
}

test("#59 a portrait phone stacks an existing split without changing desktop or landscape", () => {
	const phone = cssTemplate("CSS_PHONE");
	const start = phone.indexOf("@media (orientation: portrait) and (max-width: 767px)");
	assert.notEqual(start, -1);
	const end = phone.indexOf("/* The drawer floats", start);
	const rule = phone.slice(start, end);
	assert.ok(rule.includes('[data-sidebar-right-panel] [data-dockkit-split]:has(> [data-dockkit-host][data-dockkit-column="1"])'));
	assert.ok(rule.includes("grid-template-columns: minmax(0, 1fr) !important"));
	assert.ok(rule.includes("grid-template-rows: minmax(0, 1fr) minmax(0, 1fr) !important"));
	assert.ok(rule.includes('[data-dockkit-column="0"] { grid-area: 1 / 1 !important; }'));
	assert.ok(rule.includes('[data-dockkit-column="1"] { grid-area: 2 / 1 !important; }'));
	assert.ok(rule.includes('[data-dockkit-divider] { display: none !important; }'));
	assert.doesNotMatch(cssTemplate("CSS_DEVICE"), /grid-template-rows: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
});

test("#72 the tablet tier reserves the measured dock and keeps safe-area padding", () => {
	const phone = cssTemplate("CSS_PHONE");
	const tabletStart = phone.indexOf("@media (min-width: 768px)");
	assert.notEqual(tabletStart, -1, "the tablet tier is missing from the mobile sheet");
	const tabletEnd = phone.indexOf("\n  [data-rdsh-sidebar] {", tabletStart);
	assert.notEqual(tabletEnd, -1, "the tablet tier has no end marker");
	const tablet = phone.slice(tabletStart, tabletEnd);
	assert.match(
		tablet,
		/html\[data-rdsh-rightpanel-open\] \[data-rdsh-frame\]:not\(\[data-rightbar-fullscreen\]\) \{/,
		"the open tablet dock does not target the frame outside fullscreen",
	);
	assert.match(
		tablet,
		/grid-template-columns: 0 minmax\(400px, 1fr\) minmax\(300px, var\(--rdsh-rightbar-width, 45%\)\) !important;/,
		"the tablet dock does not keep the 400px conversation minimum or the 300px panel floor",
	);
	assert.match(
		tablet,
		/\[data-rdsh-rightpanel\] \[aria-label="Exit fullscreen"\], \[data-rdsh-rightpanel\] \[aria-label="全画面表示を終了"\] \{ display: inline-flex !important; \}/,
		"the tablet cannot leave fullscreen in en or ja",
	);
	// #72: the exit control is never hidden again. Hiding it left a fullscreen
	// panel with no way back once the tablet show rule lost to a later hide.
	assert.doesNotMatch(
		phone,
		/aria-label="(?:Exit fullscreen|全画面表示を終了)"[^{}]*\{[^}]*display:\s*none/,
		"a rule still hides the only way out of fullscreen",
	);
	// #59: the split control is hidden without depending on the panel tag, so
	// a closed or not-yet-decorated panel cannot offer it.
	assert.match(
		phone,
		/\[data-dockkit-split-button\] \{ display: none !important; \}/,
		"dockkit's pane split is reachable on a phone",
	);
	assert.doesNotMatch(tablet, /\[aria-label="Split"\].*display: (?:inline-flex|block)/, "dockkit's pane split was restored");
	assert.doesNotMatch(tablet, /padding-(?:top|right|bottom|left)/, "the tablet tier reset the panel's safe-area padding");

	// The phone sheet stays the base rule; only the open tablet dock overrides it.
	assert.match(phone, /\[data-rdsh-frame\] \{ grid-template-columns: 0 minmax\(0, 1fr\) 0 !important; \}/, "the phone sheet grid was lost");
	assert.match(phone, /\[data-rdsh-frame\]\[data-rightbar-fullscreen\] \{ grid-template-columns: 0 minmax\(0, 1fr\) 0 !important; \}/, "the fullscreen sheet grid was lost");
	// #59: the stable fullscreen surface owns the safe-area insets, and the
	// full-width inner pane must not pad them a second time. #72 must preserve
	// that split while it docks a pushed panel inside #root's padded frame.
	const panelRule = phone.slice(phone.indexOf("[data-rdsh-rightpanel] {"), phone.indexOf("[data-rdsh-rightpanel] table"));
	assert.doesNotMatch(panelRule, /padding-/, "the inner panel pane double-inset the stable safe-area surface");
	const fullscreenStart = phone.indexOf('[data-sidebar-right-panel="fullscreen"] {');
	assert.notEqual(fullscreenStart, -1, "the stable fullscreen safe-area surface is missing");
	const fullscreenRule = phone.slice(fullscreenStart, phone.indexOf("\n  }", fullscreenStart) + 5);
	assert.match(fullscreenRule, /right: calc\(-1 \* env\(safe-area-inset-right, 0px\)\) !important;/, "the fullscreen surface lost its notch offset");
	assert.match(fullscreenRule, /padding-left: env\(safe-area-inset-left, 0px\) !important;/, "the fullscreen surface lost its left inset");
	assert.match(fullscreenRule, /padding-right: env\(safe-area-inset-right, 0px\) !important;/, "the fullscreen surface lost its right inset");
	// The tablet tier lives in the mobile sheet, so a desktop never receives it.
	assert.doesNotMatch(cssTemplate("CSS_DEVICE"), /data-rdsh-rightpanel|rdsh-rightbar-width|min-width: 768px/, "the tablet dock leaked into the desktop sheet");
});

test("#72 1024px and 1180px mobile tag the upstream dock and never click Fullscreen", () => {
	for (const [width, dockWidth] of [[1024, 460], [1180, 531]]) {
		const booted = bootBoundary({ mode: "mobile", narrow: false, width });
		const frame = ipadFrame(booted);
		const panel = ipadPanel(booted, { viewportWidth: width, dockWidth });
		booted.api.decorateNow();

		assert.equal(panel.clicks(), 0, `the ${width}px tablet auto-clicked Fullscreen`);
		assert.equal(panel.fullscreen.hasAttribute("data-rdsh-auto-fired"), false, `the ${width}px tablet marked Fullscreen as fired`);
		assert.equal(booted.html.hasAttribute("data-rdsh-rightpanel-open"), true, `the ${width}px dock was not reported open`);
		assert.equal(panel.boundary.hasAttribute("data-rdsh-rightpanel"), true, `the ${width}px tablet did not tag the dock root`);
		assert.equal(panel.panel.hasAttribute("data-rdsh-rightpanel"), false, `the ${width}px tablet tagged the inner layer`);
		assert.equal(booted.html.style.getPropertyValue("--rdsh-rightbar-width"), `${dockWidth}px`, `the ${width}px dock width was not published`);
		assert.equal(frame.frame.hasAttribute("data-rdsh-frame"), true, `the ${width}px frame lost its mobile hook`);
		assert.equal(frame.center.hasAttribute("data-rdsh-center-col"), true, `the ${width}px center column lost its pin`);
		assert.equal(frame.rightbar.hasAttribute("data-rdsh-rightbar-col"), true, `the ${width}px right column lost its pin`);

		assert.deepEqual(booted.dispose(), [], `the ${width}px tablet dispose threw`);
		assert.equal(booted.html.hasAttribute("data-rdsh-rightpanel-open"), false, `the ${width}px open marker survived dispose`);
		assert.equal(booted.html.style.getPropertyValue("--rdsh-rightbar-width"), "", `the ${width}px dock width survived dispose`);
		assert.equal(panel.boundary.hasAttribute("data-rdsh-rightpanel"), false, `the ${width}px dock tag survived dispose`);
	}
});

test("#72 below 768px the phone sheet keeps its fullscreen promotion", () => {
	const booted = bootBoundary({ mode: "mobile", narrow: true, width: 390 });
	const frame = ipadFrame(booted);
	const panel = ipadPanel(booted, { viewportWidth: 390, dockWidth: 390 });
	booted.api.decorateNow();

	assert.equal(panel.clicks(), 1, "the phone no longer promotes its docked panel to the sheet");
	assert.equal(panel.fullscreen.getAttribute("data-rdsh-auto-fired"), "1", "the phone promotion was not marked once");
	assert.equal(panel.panel.hasAttribute("data-rdsh-rightpanel"), true, "the phone did not tag the fullscreen layer");
	assert.equal(panel.boundary.hasAttribute("data-rdsh-rightpanel"), false, "the phone tagged the tablet dock root");
	assert.equal(booted.html.style.getPropertyValue("--rdsh-rightbar-width"), "", "the phone wrote a tablet dock width");
	assert.equal(frame.frame.hasAttribute("data-rdsh-frame"), true, "the phone frame lost its mobile hook");

	// A second pass must not click the same button again.
	booted.api.decorateNow();
	assert.equal(panel.clicks(), 1, "the phone clicked Fullscreen twice");
	booted.dispose();
});

test("#80 the reviewed ja fullscreen label is promoted, but its exit label is not", () => {
	const booted = bootBoundary({ mode: "mobile", narrow: true, width: 390 });
	ipadFrame(booted);
	const panel = ipadPanel(booted, { viewportWidth: 390, dockWidth: 390, label: "全画面表示" });
	booted.api.decorateNow();
	assert.equal(panel.clicks(), 1, "the ja phone did not promote its docked panel");
	assert.equal(panel.fullscreen.getAttribute("data-rdsh-auto-fired"), "1");
	booted.dispose();

	// "全画面表示を終了" is the exit control; it must never be auto-clicked as
	// the enter control (an exact aria label, not a substring).
	const closing = bootBoundary({ mode: "mobile", narrow: true, width: 390 });
	ipadFrame(closing);
	const exit = ipadPanel(closing, { viewportWidth: 390, dockWidth: 390, label: "全画面表示を終了" });
	closing.api.decorateNow();
	assert.equal(exit.clicks(), 0, "the ja exit control was clicked as if it entered fullscreen");
	closing.dispose();
});

test("#72 a desktop at a tablet width stays untouched", () => {
	const booted = bootBoundary({ mode: "desktop", narrow: false, width: 1024 });
	assert.equal(booted.api, undefined, "a desktop built the mobile half");
	ipadFrame(booted);
	const panel = ipadPanel(booted, { viewportWidth: 1024, dockWidth: 460 });
	booted.flushFrames();
	assert.equal(panel.clicks(), 0, "a desktop clicked Fullscreen");
	assert.equal(booted.html.hasAttribute("data-rdsh-rightpanel-open"), false, "a desktop got the dock open marker");
	assert.equal(booted.html.style.getPropertyValue("--rdsh-rightbar-width"), "", "a desktop got a dock width");
	assert.equal(panel.boundary.hasAttribute("data-rdsh-rightpanel"), false, "a desktop got the mobile panel tag");
	assert.equal(booted.document.head.querySelectorAll('[data-rdsh-mux-style="phone"]').length, 0, "a desktop got the mobile stylesheet");
	assert.deepEqual(booted.dispose(), [], "a desktop dispose threw");
});
