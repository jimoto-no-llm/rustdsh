/**
 * #59 safe area: a landscape notch sits on the left or the right, and in
 * portrait the status bar sits above everything. Every fixed layer has to
 * take its inset from the device (`env(safe-area-inset-*)`), and every
 * JS-positioned popover from the values `measureSafeArea()` read, because
 * neither side can see the other.
 *
 * These checks are the source contract: the mobile stylesheet carries the
 * env() declarations, the desktop sheet carries none of them (#44), and the
 * popover code clamps through `safeInset()` instead of a fixed 12px. The
 * measured values themselves are driven through the stub browser in
 * `boundary-issues.test.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const TICK = String.fromCharCode(96);

/** Pull one `const NAME = ...;` stylesheet out of the client bundle. */
function cssTemplate(name) {
	const match = CLIENT.match(new RegExp(`const ${name} = ${TICK}([\\s\\S]*?)${TICK};\\n`));
	assert.ok(match, `${name} exists`);
	return match[1];
}

/** The body of the rule whose head is exactly `selector`. */
function ruleBody(css, selector) {
	const head = `${selector} {`;
	const start = css.indexOf(head);
	assert.notEqual(start, -1, `${selector} has no rule`);
	const end = css.indexOf("}", start);
	assert.notEqual(end, -1, `${selector} rule is unterminated`);
	return css.slice(start + head.length, end);
}

/** The source of one top-level `function name(...)` in the module. */
function functionBody(name) {
	const start = CLIENT.indexOf(`\n    function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	const end = CLIENT.indexOf("\n    }\n", start);
	assert.notEqual(end, -1, `${name} is terminated`);
	return CLIENT.slice(start, end);
}

test("every fixed layer pads the notch side itself", () => {
	const phone = cssTemplate("CSS_PHONE");
	const layers = [
		[".rdsh-mux-fab", ["left: calc(env(safe-area-inset-left, 0px) + 8px)"]],
		[".rdsh-mux-route-back", [
			"left: calc(env(safe-area-inset-left, 0px) + 8px)",
			"top: calc(env(safe-area-inset-top, 0px) + 8px)",
		]],
		["[data-rdsh-sidebar]", [
			"padding-left: env(safe-area-inset-left, 0px)",
			"padding-right: env(safe-area-inset-right, 0px)",
		]],
		["[data-shortcut-modal=\"settings\"]", [
			"padding-left: env(safe-area-inset-left, 0px)",
			"padding-right: env(safe-area-inset-right, 0px)",
		]],
		["[data-shortcut-modal=\"settings\"] [data-rdsh-settings-close]", [
			"right: calc(env(safe-area-inset-right, 0px) + 12px) !important",
		]],
		// #59: the stable upstream panel surface owns the horizontal insets,
		// not the full-width pane this module tags inside it.
		["[data-sidebar-right-panel=\"fullscreen\"]", [
			"right: calc(-1 * env(safe-area-inset-right, 0px)) !important",
			"padding-left: env(safe-area-inset-left, 0px) !important",
			"padding-right: env(safe-area-inset-right, 0px) !important",
		]],
	];
	for (const [selector, declarations] of layers) {
		const body = ruleBody(phone, selector);
		for (const declaration of declarations) {
			assert.ok(body.includes(declaration), `${selector} lost: ${declaration}`);
		}
	}
});

test("the drawer width adds the notch padding to its 280px content", () => {
	const phone = cssTemplate("CSS_PHONE");
	const body = ruleBody(phone, "[data-rdsh-sidebar]");
	// Content = outer width - both paddings. The fixed 280px this replaced left
	// 221px of content under a 59px landscape inset, so the 252px rows were
	// clipped by the drawer's overflow: hidden.
	assert.ok(
		body.includes("width: calc(280px + env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px)) !important"),
		"the drawer width does not add both notch insets to its content width",
	);
	assert.ok(
		body.includes("max-width: calc(86vw + env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px))"),
		"the 86vw cap does not include the notch padding, so it would crush the content again",
	);
	assert.equal(/width: 280px !important/.test(body), false, "the fixed 280px drawer width is back");
	// Example arithmetic from the real-device report: 844x390, one 59px side.
	const content = (viewport, left, right) => Math.min(280 + left + right, 0.86 * viewport + left + right) - left - right;
	assert.equal(content(844, 59, 0), 280, "a left notch still leaves less than 280px of drawer content");
	assert.equal(content(844, 0, 59), 280, "a right notch still leaves less than 280px of drawer content");
	assert.equal(content(390, 0, 0), 280, "a portrait phone lost drawer content");
	assert.equal(content(320, 0, 0), 275.2, "the narrow-phone 86vw cap changed");
});

test("the right panel pads upstream's stable surface, not the tagged pane", () => {
	const phone = cssTemplate("CSS_PHONE");
	const surface = ruleBody(phone, '[data-sidebar-right-panel="fullscreen"]');
	// The root is right-anchored inside #root's padded frame. Pulling its far
	// edge back to the viewport edge makes the horizontal insets line up
	// instead of double-insetting a pushed panel.
	assert.ok(surface.includes("box-sizing: border-box !important"), "the panel surface does not include its padding in 100vw");
	assert.ok(surface.includes("right: calc(-1 * env(safe-area-inset-right, 0px)) !important"), "the fullscreen panel cannot reach the viewport edge on a right notch");
	assert.ok(surface.includes("padding-left: env(safe-area-inset-left, 0px) !important"), "the fullscreen panel left edge is not cleared");
	assert.ok(surface.includes("padding-right: env(safe-area-inset-right, 0px) !important"), "the fullscreen panel right edge is not cleared");
	assert.equal(/padding-top|padding-bottom/.test(surface), false, "#root already pads the vertical edges; the panel would double them");

	const tagged = ruleBody(phone, "[data-rdsh-rightpanel]");
	assert.equal(/padding-(top|right|bottom|left):/.test(tagged), false, "the full-width pane still adds a second safe-area padding");
	// The file tree lives inside this same surface (data-files-state=tree >
	// data-files-body), so its own rule must not carry a competing inset.
	assert.match(phone, /\[data-rdsh-files-tree\] \[data-files-entry\]/, "the file tree hook moved out of the panel surface");
});

test("the root pads the in-flow content on every side", () => {
	const phone = cssTemplate("CSS_PHONE");
	// The header, the transcript and the composer are in flow inside #root, so
	// the root padding is what moves them clear of a landscape notch.
	assert.match(ruleBody(phone, "html[data-rdsh-safe-left] #root"), /padding-left: env\(safe-area-inset-left, 0px\)/);
	assert.match(ruleBody(phone, "html[data-rdsh-safe-right] #root"), /padding-right: env\(safe-area-inset-right, 0px\)/);
	assert.match(ruleBody(phone, "html[data-rdsh-safe-top] #root"), /padding-top: env\(safe-area-inset-top, 0px\)/);
});

test("iOS 27: only a standalone WebKit app gets the fixed, unpainted top-edge box", () => {
	const shell = cssTemplate("CSS");
	// Everywhere else the node is inert: a Safari tab would turn its toolbar
	// opaque, and Chromium has no top-edge blur to cancel.
	assert.match(ruleBody(shell, ".dsh-mobile-maxxing-top-edge"), /display: none/);
	const gate = "@supports (-webkit-touch-callout: none) {";
	const start = shell.indexOf(gate);
	assert.notEqual(start, -1, "the top-edge box is not limited to iOS WebKit");
	const block = shell.slice(start, shell.indexOf("\n}\n", start));
	const body = ruleBody(block, 'html[data-dsh-mobile-maxxing="standalone"] .dsh-mobile-maxxing-top-edge');
	// What WebKit's top-edge sampling needs: a fixed, full-width box on top of
	// everything at the top centre, with a declared background colour.
	for (const declaration of [
		"display: block",
		"position: fixed",
		"top: 0",
		"left: 0",
		"right: 0",
		"z-index: 2147483647",
		"pointer-events: none",
		"background-color: var(--dsw-alias-bg-base, #151517)",
		"-webkit-background-clip: text",
		"background-clip: text",
	]) {
		assert.ok(body.includes(declaration), `the top-edge box lost: ${declaration}`);
	}
	const height = Number(/(?:^|[\s;])height: (\d+)px/.exec(body)?.[1]);
	assert.ok(height > 10, `WebKit ignores a fixed box 10px or thinner, got ${height}px`);
	// WebKit drops a nearly transparent or hidden candidate, so the blur returns.
	assert.equal(/opacity|visibility/.test(body), false, "the top-edge box hides itself from WebKit");
});

test("the left/right insets never reach the desktop stylesheet", () => {
	const device = cssTemplate("CSS_DEVICE");
	for (const pattern of [
		"#root",
		"[data-rdsh-sidebar]",
		".rdsh-mux-fab",
		"[data-shortcut-modal=\"settings\"]",
		"[data-rdsh-rightpanel]",
		"[data-sidebar-right-panel=\"fullscreen\"]",
		".rdsh-mux-route-back",
		"data-rdsh-safe-left",
		"data-rdsh-safe-right",
		"safe-area-inset-left",
		"safe-area-inset-right",
	]) {
		assert.equal(device.includes(pattern), false, `the desktop sheet gained a phone-only rule: ${pattern}`);
	}
});

test("the JS popovers clamp against the measured insets", () => {
	for (const name of ["showDetailPopover", "showTitlePopover", "queueMenuAt", "openFilesMenu"]) {
		const body = functionBody(name);
		for (const edge of ["left", "right", "top"]) {
			assert.ok(body.includes(`safeInset("${edge}")`), `${name} does not read the ${edge} inset`);
		}
		assert.equal(body.includes("Math.max(12,"), false, `${name} still clamps to a fixed 12px`);
	}
});

test("the measured values are released with the rest of the surface", () => {
	const release = functionBody("releaseSafeArea");
	assert.ok(release.includes('["top", "bottom", "left", "right"]'), "the attribute release list lost an edge");
	assert.match(release, /root\.removeAttribute\(`data-rdsh-safe-\$\{name\}`\)/, "the attribute release is gone");
	for (const edge of ["left", "right"]) {
		assert.ok(release.includes(`root.style.removeProperty("--rdsh-safe-${edge}")`), `releaseSafeArea keeps --rdsh-safe-${edge}`);
	}
	const measure = functionBody("measureSafeArea");
	for (const edge of ["left", "right"]) {
		assert.ok(measure.includes(`root.style.setProperty("--rdsh-safe-${edge}"`), `measureSafeArea does not publish --rdsh-safe-${edge}`);
	}
});
