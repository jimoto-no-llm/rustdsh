/**
 * iOS Safari ignores `interactive-widget=resizes-content`: with the keyboard up
 * only the visual viewport shrinks, and Safari pans the page to the caret. The
 * header then scrolls away and the composer's send button ends up under the
 * keyboard's floating form bar. The app must be pinned to the visual viewport
 * instead.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Run the pin against a fake window and report what it published. */
function pinFor(viewport, { phone = true, innerHeight = 800, dvh = 800, dialog = false, innerWidth = 390 } = {}) {
	const start = CLIENT.indexOf("    let heightProbe = null;");
	const end = CLIENT.indexOf("    function measureSafeArea()");
	assert.ok(start !== -1 && end > start, "keyboardOpen and fitVisualViewport are in the bundle");
	const attributes = new Map();
	const properties = new Map();
	const root = {
		toggleAttribute(name, force) { if (force) attributes.set(name, ""); else attributes.delete(name); },
		style: { setProperty(name, value) { properties.set(name, value); } },
	};
	const probe = { style: {}, isConnected: false, setAttribute() {}, remove() { this.isConnected = false; }, getBoundingClientRect: () => ({ height: dvh }) };
	const body = { append(node) { node.isConnected = true; } };
	const document = { documentElement: root, body, createElement: () => probe, querySelector: () => dialog ? {} : null };
	const sandbox = { window: { visualViewport: viewport, innerHeight, innerWidth }, document, Math, phone: () => phone };
	vm.runInNewContext(`${CLIENT.slice(start, end)}\nfitVisualViewport();`, sandbox);
	return { attributes: [...attributes.keys()], properties: Object.fromEntries(properties) };
}

test("with the keyboard up the app is pinned to the visual viewport", () => {
	// 800px layout, 480px left above the keyboard, panned 150px down by Safari.
	const open = pinFor({ height: 480, offsetTop: 150, scale: 1 });
	assert.deepEqual(open.attributes, ["data-rdsh-keyboard"]);
	assert.deepEqual(open.properties, { "--rdsh-vv-top": "150px", "--rdsh-vv-height": "480px" });
});

test("the pin works when the browser shrinks innerHeight with the keyboard", () => {
	// innerHeight follows the keyboard (480) but 100dvh keeps the web view height.
	const open = pinFor({ height: 480, offsetTop: 0, scale: 1 }, { innerHeight: 480, dvh: 800 });
	assert.deepEqual(open.attributes, ["data-rdsh-keyboard"]);
	assert.equal(open.properties["--rdsh-vv-height"], "480px");
	// Everything shrank together: the layout already fits, nothing to pin.
	assert.deepEqual(pinFor({ height: 480, offsetTop: 0, scale: 1 }, { innerHeight: 480, dvh: 480 }).attributes, []);
});

test("a pinch zoom, a closed keyboard or a desktop does not pin the app", () => {
	assert.deepEqual(pinFor({ height: 480, offsetTop: 0, scale: 2 }).attributes, [], "zoom shrinks the visual viewport too");
	assert.deepEqual(pinFor({ height: 790, offsetTop: 0, scale: 1 }).attributes, [], "a small inset is not a keyboard");
	assert.deepEqual(pinFor(undefined).attributes, [], "no visualViewport support");
	assert.deepEqual(pinFor({ height: 480, offsetTop: 150, scale: 1 }, { phone: false }).attributes, [], "desktop stays stock");
});

test("a landscape composer keeps its own keyboard and scroll geometry", () => {
	assert.deepEqual(pinFor({ height: 200, offsetTop: 0, scale: 1 }, { innerWidth: 844, innerHeight: 390, dvh: 390 }).attributes, []);
});

test("a dialog keeps its own keyboard and scroll geometry", () => {
	assert.deepEqual(pinFor({ height: 480, offsetTop: 150, scale: 1 }, { dialog: true }).attributes, []);
});

test("only a landscape phone compacts the conversation header without overlapping its drawer button", () => {
	const landscape = CLIENT.slice(CLIENT.indexOf("  @media (orientation: landscape) and (max-height: 500px)"), CLIENT.indexOf("  @media (orientation: portrait)"));
	assert.ok(landscape.startsWith("  @media (orientation: landscape) and (max-height: 500px)"), "tablets keep the full upstream header");
	assert.match(landscape, /header\[data-window-drag\]:has\(\[data-conversation-header-leading\]\) \{ height: 0 !important;/);
	assert.match(landscape, /header\[data-window-drag\]:has\(\[data-conversation-header-leading\]\) \[class\*="_titleRow"\] \{ display: none !important; \}/);
	assert.match(landscape, /header\[data-window-drag\]:has\(\[data-conversation-header-leading\]\) \[class\*="_headerCorner"\] \{[\s\S]*?position: fixed !important;/);
	assert.match(landscape, /\[class\*="_tabs"\]:has\(> \[data-conversation-tabs\]\) \{\s*box-sizing: border-box; padding-left: 64px !important;/);
	assert.doesNotMatch(landscape, /^    \[data-window-drag\]/m, "the right panel's dock strip must not be selected");
});

test("only deliberate focus is kept, including slash command editing", () => {
	assert.match(CLIENT, /if \(field === allowFocusElement\) return;/);
	assert.match(CLIENT, /if \(event.key === "Tab"\) \{\s*allowFocusElement = textBoxOf\(event.target\);/);
	assert.doesNotMatch(CLIENT, /allowFocusUntil/);
});

test("terminal surface taps authorize the helper textarea without allowing automatic focus", () => {
	const start = CLIENT.indexOf("    let allowFocusElement = null;");
	const end = CLIENT.indexOf("    // Keyboard: a sent message", start);
	assert.ok(start >= 0 && end > start);
	let blurred = 0;
	let queued = [];
	class Element {
		closest(selector) {
			if (selector === ".xterm") return this.terminal ?? null;
			if (selector.startsWith("input, textarea")) return this.field ?? null;
			return null;
		}
	}
	const input = new Element();
	input.tagName = "TEXTAREA";
	input.blur = () => { blurred++; };
	const terminal = { querySelector: () => input };
	const screen = new Element();
	screen.terminal = terminal;
	const sandbox = { Element, phone: () => true, document: { activeElement: input }, setTimeout: fn => queued.push(fn) };
	vm.runInNewContext(CLIENT.slice(start, end) + "\nthis.guard = onFocusInGuard; this.pointer = onFocusPointer;", sandbox);
	sandbox.guard({ target: Object.assign(input, { field: input }) });
	queued.splice(0).forEach(fn => fn());
	assert.equal(blurred, 1, "automatic focus must still be rejected");
	sandbox.guard({ target: input });
	sandbox.pointer({ target: screen });
	queued.splice(0).forEach(fn => fn());
	assert.equal(blurred, 1, "a pending blur must not cancel an intentional terminal tap");
	sandbox.guard({ target: input });
	queued.splice(0).forEach(fn => fn());
	assert.equal(blurred, 1, "terminal focus remains authorized");
});

test("a selected command chip is deleted through its editor for key and virtual-key input", () => {
	const start = CLIENT.indexOf("    function deleteSelectedCommandChip(event)");
	const end = CLIENT.indexOf("    function onKeyDown(event)", start);
	assert.ok(start !== -1 && end > start, "the mobile chip deletion handler is in the bundle");
	for (const event of [
		{ type: "keydown", key: "Backspace" },
		{ type: "beforeinput", inputType: "deleteContentBackward" },
	]) {
		let removed = false;
		let prevented = false;
		let stopped = false;
		let focused = false;
		const node = { getType: () => "command-chip", remove() { removed = true; } };
		const editor = { update(fn) { fn(); }, getEditorState: () => ({ _nodeMap: new Map([["3", node]]) }) };
		const chip = { __lexicalKey_test: "3" };
		const root = {
			__lexicalEditor: editor,
			hasAttribute: () => true,
			querySelector: () => chip,
			focus: () => { focused = true; },
		};
		const sandbox = {
			phone: () => true,
			allowFocusElement: null,
			event: {
				...event,
				target: { closest: () => root },
				preventDefault() { prevented = true; },
				stopImmediatePropagation() { stopped = true; },
			},
		};
		vm.runInNewContext(CLIENT.slice(start, end) + "\nresult = deleteSelectedCommandChip(event);", sandbox);
		assert.equal(sandbox.result, true);
		assert.equal(removed, true);
		assert.equal(prevented, true);
		assert.equal(stopped, true);
		assert.equal(focused, true);
		assert.equal(sandbox.allowFocusElement, root);
	}
});

test("the pin is torn down with the phone hooks", () => {
	const release = CLIENT.slice(CLIENT.indexOf("    function releaseSafeArea()"), CLIENT.indexOf("    let heightProbe = null;"));
	assert.match(release, /removeAttribute\("data-rdsh-keyboard"\)/);
	assert.match(release, /removeProperty\("--rdsh-vv-height"\)/);
});
