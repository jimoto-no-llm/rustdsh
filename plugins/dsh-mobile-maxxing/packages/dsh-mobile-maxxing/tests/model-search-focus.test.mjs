/**
 * #55: the model picker's search field must keep the keyboard up on Android.
 *
 * `decorateModelSearch` runs on every decoration pass. It used to disable the
 * field (and blur it) each time, so the pass that follows the user's own tap
 * undid that tap: the keyboard flashed open and closed at once. The fix keeps
 * the field enabled from the tap until the picker closes, and starts the next
 * open "disabled until tapped" again (the iOS auto-focus guard).
 *
 * The browser half is a single bundle with no exports, so these tests evaluate
 * the model-search block on its own against a small DOM, the same way
 * `mobile-settings-first.test.mjs` drives one helper.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const block = source.match(/    let modelSearchState = null;[\s\S]*?\n    function decorateModelSearch\(\) \{[\s\S]*?\n    \}/)[0];
// #97: the picker no longer carries a literal class hash. The fallback path
// (no aria-controls) matches the `menu` suffix plus a menu role; the search row
// is likewise matched by its suffix.
const MENU_SELECTOR = '[class*="_menu"][role="menu"], [class*="_menu"][role="group"]';
const ROW_SELECTOR = '[class*="_searchRow"]';

/** A node with the attribute, listener and focus surface the block touches. */
function element(document, tagName) {
	const attributes = new Map();
	const listeners = new Map();
	const node = {
		tagName,
		document,
		parentElement: null,
		isConnected: true,
		disabled: false,
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
		dispatch(type) {
			for (const handler of [...(listeners.get(type) ?? [])]) handler({ type, target: node });
		},
		focus() {
			document.activeElement = node;
			node.focusCount += 1;
		},
		blur() {
			if (document.activeElement === node) document.activeElement = null;
			node.blurCount += 1;
		},
	};
	return node;
}

/** The menu / search row / input tree the picker renders. */
function makePicker(document, { enabled = true } = {}) {
	const row = element(document, "div");
	const input = element(document, "input");
	input.disabled = !enabled;
	input.parentElement = row;
	const menu = element(document, "div");
	menu.querySelector = (selector) => (selector === "input" ? input : null);
	input.closest = (selector) => (selector === ROW_SELECTOR ? row : null);
	return { menu, row, input };
}

/** Boot just the model-search block; `open` swaps in a fresh picker. */
function fixture({ mobile = true } = {}) {
	const document = {
		activeElement: null,
		querySelector(selector) {
			return selector === MENU_SELECTOR ? menu : null;
		},
	};
	let menu = null;
	const frames = [];
	const state = { mobile };
	const sandbox = vm.createContext({
		phone: () => state.mobile,
		document,
		// #84 reads the visible viewport; this fixture never measures layout.
		window: { innerWidth: 390, visualViewport: { width: 390, offsetLeft: 0 } },
		safeInset: () => 0,
		// The block's structural menu lookup reads these from the module scope.
		modelTrigger: () => null,
		clearOwnedAttribute: () => {},
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
		frames,
		decorate: api.decorateModelSearch,
		clear: api.clearModelSearch,
		open: (options) => {
			const picker = makePicker(document, options);
			menu = picker.menu;
			return picker;
		},
		close: () => {
			menu = null;
		},
		flushFrames: () => {
			for (const callback of frames.splice(0)) callback();
		},
	};
}

test("the picker opens with its search disabled until the row is tapped", () => {
	const f = fixture();
	const picker = f.open({ enabled: true });
	picker.input.focus();
	f.decorate();
	assert.equal(picker.input.disabled, true, "the open picker kept an enabled search");
	assert.equal(f.document.activeElement, null, "the field kept focus, so the keyboard would open");
	assert.equal(picker.row.listenerCount("pointerdown"), 1, "the row has no tap listener");
});

test("a tap survives the decoration passes that follow it", () => {
	const f = fixture();
	const picker = f.open({ enabled: true });
	f.decorate();
	picker.row.dispatch("pointerdown");
	assert.equal(picker.input.disabled, false, "the tap did not enable the field");
	f.flushFrames();
	assert.equal(f.document.activeElement, picker.input, "the tap did not focus the field");

	// The app re-renders the picker on the same tap. Those passes used to
	// disable and blur the field again, which is the keyboard flash.
	f.decorate();
	f.decorate();
	assert.equal(picker.input.disabled, false, "a later pass disabled the search");
	assert.equal(f.document.activeElement, picker.input, "a later pass blurred the search");
	assert.equal(picker.input.blurCount, 0, "the field was blurred after the user tapped it");
	assert.equal(picker.row.listenerCount("pointerdown"), 1, "the tap listener was duplicated");
});

test("closing the picker restores 'disabled until tapped' for the next open", () => {
	const f = fixture();
	const first = f.open({ enabled: true });
	f.decorate();
	first.row.dispatch("pointerdown");
	f.flushFrames();
	f.decorate();
	assert.equal(first.input.disabled, false, "the tapped search was not usable");

	// Closing unmounts the menu and its input. A later pass notices and forgets
	// the tap; the next open gets a fresh input and starts disabled again.
	first.input.isConnected = false;
	f.close();
	f.decorate();

	const second = f.open({ enabled: true });
	second.input.focus();
	f.decorate();
	assert.equal(second.input.disabled, true, "the reopened picker inherited the old tap");
	assert.equal(f.document.activeElement, null, "the reopened picker kept focus");
});

test("a closed picker is forgotten even if no pass ran while it was gone", () => {
	const f = fixture();
	const first = f.open({ enabled: true });
	f.decorate();
	first.row.dispatch("pointerdown");
	f.flushFrames();

	first.input.isConnected = false;
	f.close();
	const second = f.open({ enabled: true });
	f.decorate();
	assert.equal(second.input.disabled, true, "the reopened picker inherited the old tap");
	f.decorate();
	assert.equal(second.input.disabled, true, "a later pass enabled a search nobody tapped");
});

test("a desktop pass neither disables nor blurs the field", () => {
	const f = fixture({ mobile: false });
	const picker = f.open({ enabled: true });
	picker.input.focus();
	f.decorate();
	assert.equal(picker.input.disabled, false, "a desktop pass disabled the search");
	assert.equal(f.document.activeElement, picker.input, "a desktop pass blurred the search");
	assert.equal(picker.input.hasAttribute("data-rdsh-model-search"), false, "a desktop pass decorated the search");
	assert.equal(picker.row.listenerCount("pointerdown"), 0, "a desktop pass installed the tap listener");
});

test("a pass that turns desktop puts back the disabled state it found", () => {
	const f = fixture();
	const picker = f.open({ enabled: true });
	f.decorate();
	assert.equal(picker.input.disabled, true, "the mobile pass did not disable the search");

	f.state.mobile = false;
	f.decorate();
	assert.equal(picker.input.disabled, false, "the desktop restore did not undo the mobile disable");
});
