/**
 * #39: the workspace picker must keep its search row out of the phone's
 * status bar / notch.
 *
 * Upstream places the portal with a 12px margin against window.innerWidth /
 * innerHeight, which is the layout viewport (with viewport-fit=cover that
 * includes the cut-out). The original bug's first raw frame sat at y=12 with
 * an 820px panel, so the injected search row was painted inside the safe
 * band. The browser half is one bundle with no exports, so the clamp is
 * evaluated on its own against a stubbed visible viewport, the same way
 * model-menu-clamp.test.mjs drives the model clamp.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const block = source.match(/    function clampWorkspaceMenu\(menu\) \{[\s\S]*?\n    \}\n/)[0];

/** The inline-style surface the picker and this module share. */
function styleSheet(initial = {}) {
	const properties = new Map(Object.entries(initial));
	return {
		get top() {
			return properties.get("top") ?? "";
		},
		set top(value) {
			properties.set("top", String(value));
		},
		get left() {
			return properties.get("left") ?? "";
		},
		set left(value) {
			properties.set("left", String(value));
		},
		get width() {
			return properties.get("width") ?? "";
		},
		set width(value) {
			properties.set("width", String(value));
		},
		get maxWidth() {
			return properties.get("max-width") ?? "";
		},
		set maxWidth(value) {
			properties.set("max-width", String(value));
		},
	};
}

function picker({ top = "411px", left = "20px", width = 212, height = 414 } = {}) {
	return {
		style: styleSheet({ top, left }),
		offsetWidth: width,
		offsetHeight: height,
		getBoundingClientRect() {
			return { left: 0, top: 0, right: width, bottom: height, width, height };
		},
	};
}

function clampFor({ width = 390, height = 844, inset = {}, viewport = {} } = {}) {
	const insets = { top: 0, bottom: 0, left: 0, right: 0, ...inset };
	const viewportWidth = viewport.width ?? width;
	const viewportHeight = viewport.height ?? height;
	const sandbox = vm.createContext({
		window: {
			innerWidth: width,
			innerHeight: height,
			visualViewport: {
				width: viewportWidth,
				height: viewportHeight,
				offsetLeft: viewport.offsetLeft ?? 0,
				offsetTop: viewport.offsetTop ?? 0,
			},
		},
		safeInset: (edge) => insets[edge] ?? 0,
	});
	return vm.runInContext(`(() => {\n${block}\nreturn clampWorkspaceMenu;\n})()`, sandbox);
}

test("#39 a phone with no reported inset keeps upstream's placement", () => {
	const clamp = clampFor();
	const menu = picker();
	clamp(menu);
	assert.equal(menu.style.top, "411px", "a menu inside the band was moved");
	assert.equal(menu.style.left, "20px", "a menu inside the band was moved sideways");
	assert.equal(menu.style.maxWidth, "", "the clamp capped the picker's width");
});

test("#39 the raw first frame at y=12 is pushed below the status bar", () => {
	// The pre-decoration portal of the original bug: a full-height panel at the
	// top edge. Its search row is painted 4px inside the panel, so the row must
	// clear the 47px status bar.
	const clamp = clampFor({ inset: { top: 47 } });
	const menu = picker({ top: "12px", height: 820 });
	clamp(menu);
	assert.equal(menu.style.top, "55px", "the picker still starts inside the notch");
	assert.ok(parseFloat(menu.style.top) + 4 >= 47, "the search row is still under the status bar");
});

test("#39 a landscape notch moves the panel off the left cut-out", () => {
	const clamp = clampFor({ width: 844, height: 390, inset: { left: 59 } });
	const menu = picker({ left: "12px", height: 250 });
	clamp(menu);
	assert.equal(menu.style.left, "67px", "the picker stayed under the landscape notch");
});

test("#39 a home-indicator inset lifts the panel above it", () => {
	const clamp = clampFor({ inset: { top: 47, bottom: 34 } });
	const menu = picker({ top: "411px", height: 414 });
	clamp(menu);
	assert.equal(menu.style.top, "388px", "the panel still covers the home indicator");
	assert.ok(parseFloat(menu.style.top) + 414 <= 844 - 34, "the panel bottom is inside the inset");
});

test("#39 a keyboard-shrunk visual viewport moves the panel into the visible band", () => {
	const clamp = clampFor({ viewport: { height: 500 }, inset: { bottom: 34 } });
	const menu = picker({ top: "411px", height: 414 });
	clamp(menu);
	assert.equal(menu.style.top, "44px", "the panel stayed behind the keyboard");
});

test("#39 a panel taller than the band keeps its top (search row) visible", () => {
	const clamp = clampFor({ inset: { top: 47, bottom: 34 } });
	const menu = picker({ top: "12px", height: 900 });
	clamp(menu);
	assert.equal(menu.style.top, "55px", "an oversized panel lost its top edge");
});

test("#39 an unplaced portal is left to upstream", () => {
	const clamp = clampFor({ inset: { top: 47 } });
	const menu = picker({ top: "", left: "" });
	clamp(menu);
	assert.equal(menu.style.top, "", "the clamp placed a portal upstream had not placed");
	assert.equal(menu.style.left, "", "the clamp placed a portal upstream had not placed");
});
