/**
 * #84: the open model picker must stay inside the phone's safe area.
 *
 * Upstream places the menu with a 12px margin against `window.innerWidth`.
 * That ignores a landscape notch (safe-area-inset-left/right) and the visible
 * band reported by `visualViewport` while the keyboard is up. The plugin
 * corrects the menu's inline left (plus a width cap only when the safe band is
 * narrower than the menu) and follows upstream's own inline rewrites with a
 * style observer, so there is no drag gesture and no rAF poll.
 *
 * The browser half is a single bundle with no exports, so these tests evaluate
 * the model-search block on its own against a small DOM, the same way
 * `model-search-focus.test.mjs` drives the same helper.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const block = source.match(/    let modelSearchState = null;[\s\S]*?\n    function decorateModelSearch\(\) \{[\s\S]*?\n    \}/)[0];
// #97: matched by class suffix and menu role instead of a literal hash.
const MENU_SELECTOR = '[class*="_menu"][role="menu"], [class*="_menu"][role="group"]';
const ROW_SELECTOR = '[class*="_searchRow"]';

/** The inline-style surface the menu and this module share. */
function styleSheet(initial = {}) {
	const properties = new Map(Object.entries(initial));
	return {
		get left() {
			return properties.get("left") ?? "";
		},
		set left(value) {
			properties.set("left", String(value));
		},
		get maxWidth() {
			return properties.get("max-width") ?? "";
		},
		set maxWidth(value) {
			properties.set("max-width", String(value));
		},
		removeProperty(name) {
			properties.delete(name);
		},
		getPropertyValue(name) {
			return properties.get(name) ?? "";
		},
	};
}

/** A node with the attribute/listener/style surface the block touches. */
function element(tagName, { style = {}, width = 0 } = {}) {
	const attributes = new Map();
	const listeners = new Map();
	return {
		tagName,
		parentElement: null,
		isConnected: true,
		disabled: false,
		style: styleSheet(style),
		offsetWidth: width,
		focusCount: 0,
		blurCount: 0,
		hasAttribute(name) {
			return attributes.has(name);
		},
		setAttribute(name, value) {
			attributes.set(name, String(value));
		},
		removeAttribute(name) {
			attributes.delete(name);
		},
		addEventListener(type, handler) {
			const list = listeners.get(type) ?? [];
			list.push(handler);
			listeners.set(type, list);
		},
		removeEventListener(type, handler) {
			const list = listeners.get(type);
			if (list === undefined) return;
			const at = list.indexOf(handler);
			if (at !== -1) list.splice(at, 1);
		},
		listenerCount(type) {
			return (listeners.get(type) ?? []).length;
		},
		focus() {
			this.focusCount += 1;
		},
		blur() {
			this.blurCount += 1;
		},
		getBoundingClientRect() {
			return { left: 0, top: 0, right: width, bottom: 0, width, height: 0 };
		},
	};
}

/** A menu with an optional model-search field, as upstream renders it. */
function makeMenu({ left = "12px", width = 300, withInput = true } = {}) {
	const menu = element("div", { style: { left }, width });
	if (!withInput) {
		menu.querySelector = () => null;
		return { menu, row: null, input: null };
	}
	const row = element("div");
	const input = element("input");
	input.parentElement = row;
	input.closest = (selector) => (selector === ROW_SELECTOR ? row : null);
	menu.querySelector = (selector) => (selector === "input" ? input : null);
	return { menu, row, input };
}

/** Boot just the model-search block against a stubbed visible viewport. */
function fixture({ mobile = true, width = 390, visualWidth = width, insetLeft = 0, insetRight = 0, viewportLeft = 0 } = {}) {
	let menu = null;
	const frames = [];
	const observers = [];
	const state = { mobile, insetLeft, insetRight, visualWidth, viewportLeft };
	const bandListeners = { window: [], viewport: [] };
	const listen = (target) => ({
		addEventListener(type, handler) {
			bandListeners[target].push({ type, handler });
		},
		removeEventListener(type, handler) {
			const at = bandListeners[target].findIndex((entry) => entry.type === type && entry.handler === handler);
			if (at !== -1) bandListeners[target].splice(at, 1);
		},
	});
	class FakeMutationObserver {
		constructor(callback) {
			this.callback = callback;
			this.disconnected = false;
			observers.push(this);
		}
		observe(target, options) {
			this.target = target;
			this.options = options;
		}
		disconnect() {
			this.disconnected = true;
		}
		trigger() {
			if (!this.disconnected) this.callback([], this);
		}
	}
	const document = {
		activeElement: null,
		querySelector(selector) {
			return selector === MENU_SELECTOR ? menu : null;
		},
	};
	const sandbox = vm.createContext({
		phone: () => state.mobile,
		document,
		window: {
			innerWidth: width,
			...listen("window"),
			visualViewport: {
				...listen("viewport"),
				get width() {
					return state.visualWidth;
				},
				get offsetLeft() {
					return state.viewportLeft;
				},
			},
		},
		safeInset: (edge) => (edge === "left" ? state.insetLeft : edge === "right" ? state.insetRight : 0),
		// The block's structural menu lookup reads these from the module scope.
		modelTrigger: () => null,
		clearOwnedAttribute: () => {},
		MutationObserver: FakeMutationObserver,
		requestAnimationFrame(callback) {
			frames.push(callback);
			return frames.length;
		},
	});
	const api = vm.runInContext(
		`(() => {\n${block}\nreturn { decorateModelSearch, clearModelSearch };\n})()`,
		sandbox,
	);
	return {
		document,
		state,
		observers,
		decorate: api.decorateModelSearch,
		clear: api.clearModelSearch,
		open: (options) => {
			const picker = makeMenu(options);
			menu = picker.menu;
			return picker;
		},
		close: () => {
			menu = null;
		},
		flushFrames: () => {
			for (const callback of frames.splice(0)) callback();
		},
		band: {
			count: (target) => bandListeners[target].length,
			fire: (type) => {
				for (const target of ["window", "viewport"]) {
					for (const entry of [...bandListeners[target]]) {
						if (entry.type === type) entry.handler();
					}
				}
			},
		},
	};
}

test("#84 a menu already inside the safe band keeps upstream's position", () => {
	const f = fixture({ width: 844, insetLeft: 59 });
	const picker = f.open({ left: "300px", width: 300 });
	f.decorate();
	assert.equal(picker.menu.style.left, "300px", "a menu inside the band was moved");
	assert.equal(picker.menu.style.maxWidth, "", "an uncapped menu gained a width cap");
});

test("#84 a safe-left of 59px keeps the menu 8px clear of the notch", () => {
	const f = fixture({ width: 844, insetLeft: 59 });
	const picker = f.open({ left: "12px", width: 300 });
	f.decorate();
	assert.equal(picker.menu.style.left, "67px", "the menu stayed under the landscape notch");
});

test("#84 a menu at the right edge moves left and shrinks to the safe width", () => {
	// 320px-wide phone, 12px safe right: the usable band is 8..300.
	const f = fixture({ width: 320, insetRight: 12 });
	const picker = f.open({ left: "300px", width: 300 });
	f.decorate();
	assert.equal(picker.menu.style.left, "8px", "the menu kept overflowing the right safe edge");
	assert.equal(picker.menu.style.maxWidth, "292px", "the menu was not capped to the safe band");
});

test("#84 visualViewport offsets move both bounds with a keyboard pan", () => {
	// iOS zooms a 12px search field when the keyboard opens. The layout stays
	// 390px, but the visible band is 260px wide and panned 20px to the right.
	const g = fixture({ width: 390, visualWidth: 260, insetLeft: 59, insetRight: 20, viewportLeft: 20 });
	const picker = g.open({ left: "30px", width: 150 });
	g.decorate();
	assert.equal(picker.menu.style.left, "87px", "the left floor ignored visualViewport.offsetLeft");
	// Upstream repositions beyond the right edge; the observer re-clamps.
	picker.menu.style.left = "400px";
	g.observers[0].trigger();
	assert.equal(picker.menu.style.left, "102px", "the right ceiling ignored visualViewport.offsetLeft");
	assert.ok(parseFloat(picker.menu.style.left) + 150 <= 252, "the menu still crosses the visible right edge");
});

test("#84 a desktop pass neither moves the menu nor observes it", () => {
	const f = fixture({ mobile: false, width: 390, insetLeft: 59 });
	const picker = f.open({ left: "12px", width: 300 });
	f.decorate();
	assert.equal(picker.menu.style.left, "12px", "a desktop pass clamped the menu");
	assert.equal(f.observers.length, 0, "a desktop pass installed a style observer");
	assert.equal(picker.input.hasAttribute("data-rdsh-model-search"), false, "a desktop pass decorated the search");
});

test("#84 dispose disconnects the style observer and drops the width cap", () => {
	const f = fixture({ width: 320, insetLeft: 59, insetRight: 12 });
	const picker = f.open({ left: "12px", width: 300 });
	f.decorate();
	assert.equal(picker.menu.style.left, "67px", "the menu was not clamped before disposal");
	assert.equal(picker.menu.style.maxWidth, "233px", "the menu was not capped before disposal");
	const observer = f.observers[0];
	assert.ok(observer !== undefined, "no style observer was installed");
	f.clear();
	assert.equal(observer.disconnected, true, "dispose left the style observer connected");
	assert.equal(picker.menu.style.maxWidth, "", "dispose left the plugin's width cap behind");
	picker.menu.style.left = "12px";
	observer.trigger();
	assert.equal(picker.menu.style.left, "12px", "the disconnected observer still wrote the menu");
});

test("#84 a band change re-clamps without upstream rewriting left", () => {
	const f = fixture({ width: 390 });
	const picker = f.open({ left: "12px", width: 300 });
	f.decorate();
	assert.equal(picker.menu.style.left, "12px", "setup moved a menu inside the band");
	// The phone rotates: the notch moves to the left edge. Nothing writes the
	// menu's inline left, so only the band listener can re-run the clamp.
	f.state.insetLeft = 59;
	f.band.fire("resize");
	assert.equal(picker.menu.style.left, "67px", "the band change did not re-run the clamp");
	// A keyboard pan reports through the visual viewport's own scroll event.
	f.state.insetLeft = 0;
	f.state.visualWidth = 240;
	f.band.fire("scroll");
	assert.equal(picker.menu.style.left, "8px", "the visual viewport scroll was not watched");
});

test("#84 dispose removes the band listeners", () => {
	const f = fixture({ width: 390 });
	f.open({ left: "12px", width: 300 });
	f.decorate();
	assert.equal(f.band.count("window"), 2, "the window band listeners were not installed");
	assert.equal(f.band.count("viewport"), 2, "the visual viewport band listeners were not installed");
	f.clear();
	assert.equal(f.band.count("window"), 0, "dispose kept the window band listeners");
	assert.equal(f.band.count("viewport"), 0, "dispose kept the visual viewport band listeners");
});

test("#84 the root pane is clamped even though it has no search field", () => {
	const f = fixture({ width: 844, insetLeft: 59 });
	const picker = f.open({ left: "12px", width: 300, withInput: false });
	f.decorate();
	assert.equal(picker.menu.style.left, "67px", "the root Model/Effort menu escaped the notch");
});
