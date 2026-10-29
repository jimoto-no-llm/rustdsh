/**
 * Static checks over the browser half.
 *
 * `client.js` is loaded verbatim, so a reference to something that no longer
 * exists is not a syntax error: it throws the first time that line runs, which
 * is usually during boot or on the first gesture. Two bulk edits here left
 * exactly that behind (`onModelFocusOut`, `textBoxOf`) while every other test
 * stayed green and only a real browser noticed. These checks are the cheap
 * substitute for that browser round trip.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Drop comments and string/template literals, keeping the code shape. */
function stripLiterals(source) {
	const out = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			const quote = character;
			index += 1;
			while (index < source.length) {
				if (source[index] === "\\") {
					index += 2;
					continue;
				}
				if (source[index] === quote) {
					index += 1;
					break;
				}
				index += 1;
			}
			out.push('""');
			continue;
		}
		out.push(character);
		index += 1;
	}
	return out.join("");
}

/** Every name this file brings into scope. */
function declaredNames(code) {
	const declared = new Set();
	const add = (name) => {
		if (/^[A-Za-z_$][\w$]*$/.test(name ?? "")) declared.add(name);
	};
	// A parameter list is flat (`a, b`) or a destructured object
	// (`{ sessionId, useMenuOpenState }`).
	const addParameters = (params) => {
		const text = params.trim();
		if (text.startsWith("{")) {
			for (const inner of text.replace(/^\{|\}$/g, "").split(",")) add(inner.split(":")[0].trim());
			return;
		}
		for (const part of text.split(",")) add(part.split("=")[0].trim());
	};
	for (const match of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
	for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
	// Object/class method shorthand: `name(...) {`.
	for (const match of code.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) add(match[1]);
	// Object destructuring.
	for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
		for (const part of match[1].split(",")) add(part.split(":")[0].trim().split("=")[0].trim());
	}
	// Array destructuring (React state pairs).
	for (const match of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
		for (const part of match[1].split(",")) add(part.trim());
	}
	// Arrow parameters, parenthesised and single.
	// One level of nesting covers a default parameter that is itself a call:
	// `function f(a = read(), b = read2())`.
	for (const match of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(((?:[^()]|\([^()]*\))*)\)/g)) addParameters(match[1]);
	for (const match of code.matchAll(/\(((?:[^()]|\([^()]*\))*)\)\s*=>/g)) addParameters(match[1]);
	for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(match[1]);
	return declared;
}

/** Keywords that take a parenthesised clause rather than a call. */
const NOT_A_CALLEE = new Set([
	"if", "for", "while", "switch", "catch", "return", "typeof", "new", "function", "await", "yield",
	"delete", "void", "in", "of", "instanceof", "do", "else", "try", "throw", "case", "super", "import",
	"export", "async", "class", "extends",
]);

/** Browser and host globals a call may legitimately target. */
const GLOBALS = new Set([
	"parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
	"setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
	"queueMicrotask", "structuredClone", "fetch", "atob", "btoa", "getComputedStyle", "matchMedia",
	"Boolean", "Number", "String", "Array", "Object", "Math", "JSON", "Date", "Promise", "Map", "Set", "WeakMap",
	"WeakSet", "Symbol", "RegExp", "Error", "TypeError", "RangeError", "Uint8Array", "Uint32Array", "Intl",
	"URL", "URLSearchParams", "Element", "HTMLElement", "Node", "Event", "CustomEvent", "PointerEvent",
	"KeyboardEvent", "InputEvent", "MouseEvent", "TouchEvent", "Touch", "DataTransfer", "MessageChannel",
	"Notification", "AudioContext", "webkitAudioContext", "MutationObserver", "IntersectionObserver",
	"ResizeObserver", "AbortController", "TextEncoder", "TextDecoder", "Blob", "File", "FileReader", "Image",
	"FormData", "Headers", "Request", "Response", "Proxy", "Reflect", "BigInt", "crypto", "performance",
	"console", "localStorage", "sessionStorage", "document", "window", "navigator", "location", "screen",
	"history", "self", "globalThis", "arguments", "require",
]);

/** Identifiers called as functions that nothing declares. */
function undefinedCalls(code) {
	const declared = declaredNames(code);
	const calls = new Set();
	for (const match of code.matchAll(/(?<![.?\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(match[1]);
	return [...calls]
		.filter((name) => !declared.has(name) && !NOT_A_CALLEE.has(name) && !GLOBALS.has(name))
		.sort();
}

test("no call targets an undeclared identifier", () => {
	// This is what a deleted helper looks like: the definition goes, one call
	// site stays, and nothing notices until that line runs.
	assert.deepEqual(undefinedCalls(stripLiterals(CLIENT)), []);
});

/** Names assigned without ever being declared — the state a bulk edit drops. */
function undefinedAssignments(code) {
	const declared = declaredNames(code);
	const keywords = new Set([
		"if", "for", "while", "switch", "catch", "return", "typeof", "new", "function", "await", "yield",
		"delete", "void", "in", "of", "instanceof", "do", "else", "try", "throw", "case", "super", "import",
		"export", "async", "class", "extends",
	]);
	const host = new Set(["globalThis", "window", "document", "navigator", "location", "localStorage",
		"sessionStorage", "screen", "history", "self", "console", "performance", "crypto", "module", "exports"]);
	const assigned = new Set();
	for (const match of code.matchAll(/(?<![.?\w$])([A-Za-z_$][\w$]*)\s*=(?!=)/g)) assigned.add(match[1]);
	return [...assigned].filter((name) => !declared.has(name) && !keywords.has(name) && !host.has(name)).sort();
}

test("no assignment targets an undeclared variable", () => {
	// `allowFocusElement = field` with the `let` above it deleted is a
	// ReferenceError on the first focus event, not at load time.
	assert.deepEqual(undefinedAssignments(stripLiterals(CLIENT)), []);
});

test("every addEventListener handler is defined", () => {
	const missing = [];
	for (const match of CLIENT.matchAll(/addEventListener\(\s*"[a-z]+"\s*,\s*([A-Za-z_$][\w$]*)/g)) {
		if (match[1] === "async") continue;
		if (!new RegExp(`function ${match[1]}\\b|(?:const|let|var) ${match[1]}\\s*=`).test(CLIENT)) missing.push(match[1]);
	}
	assert.deepEqual(missing, [], "a listener is registered without a definition");
});

test("the bundle registers exactly one client module", () => {
	const registrations = CLIENT.match(/window\.__ModuleLoader__\.load\(/g) ?? [];
	assert.equal(registrations.length, 1, "one package is one browser module");
	assert.match(CLIENT, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*"dsh-mobile-maxxing",/);
});

test("no data attribute is styled without ever being written", () => {
	const styled = new Set();
	for (const match of CLIENT.matchAll(/\[(data-rdsh-[a-z0-9-]+)\]/g)) styled.add(match[1]);
	const missing = [];
	for (const attribute of styled) {
		const exact = new RegExp(`(?:setAttribute|toggleAttribute)\\(\\s*"${attribute}"`).test(CLIENT);
		const prefix = attribute.split("-").slice(0, -1).join("-");
		const templated = new RegExp(`(?:setAttribute|toggleAttribute)\\(\\s*\`${prefix}-\\$\\{`).test(CLIENT);
		const quoted = new RegExp("[\"'`]" + attribute + "[\"'`]").test(CLIENT.replace(/\[(data-rdsh-[a-z0-9-]+)\]/g, ""));
		// A selector used solely to remove a node left by an older version is not a CSS hook.
		const legacyCleanup = attribute === "data-rdsh-panel-heading" && /querySelectorAll\("\[data-rdsh-panel-heading\]"\)[\s\S]{0,80}stale\.remove\(\)/.test(CLIENT);
		if (!exact && !templated && !quoted && !legacyCleanup) missing.push(attribute);
	}
	assert.deepEqual(missing, [], "styled but never written");
});

/** The source of one top-level helper, from its declaration to its closing brace. */
function helperBody(name) {
	const start = CLIENT.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	const close = CLIENT.indexOf("\n    }\n", start);
	return CLIENT.slice(start, close === -1 ? undefined : close);
}

test("the context meter reads the public Session list snapshot", () => {
	// #13: a real click opened the popover for about 80ms on every update, and
	// the rule that hid it only lived inside the phone media query, so a
	// settings modal flickered on desktop too.
	assert.equal(/data-rdsh-context-probe/.test(CLIENT), false, "the probe attribute and its rule are gone");
	assert.equal(/sessions\.projectionValues/.test(CLIENT), false, "projectionValues() is a private manager method");
	const meter = helperBody("contextUsageText");
	assert.equal(/\.click\(/.test(meter), false, "reading the meter must not click the button");
	assert.match(meter, /contextPressureOf\(sessions, sessionId\)/, "the meter goes through the projection reader");
	assert.match(meter, /projectedTokens \?\? pressure\.pressureTokens/, "the same numerator the upstream panel uses");
	// #36: `ClientSessions` exposes finished projections on its list snapshot,
	// not a projectionValues() method.
	const read = helperBody("contextPressureOf");
	assert.match(read, /sessions\.list\.getSnapshot\(\)/, "the figures come from the public list snapshot");
	assert.match(read, /byId\?\.\[sessionId\]\?\.projectionValues\?\.contextPressure/);
	assert.match(read, /projectionsBySession\?\.[^;]*values\?\.contextPressure/, "unhinted rows read the same value face");
});

test("the transcript keeps its column tag and the full-width measure", () => {
	// #14: the tag itself sets the 16px gutters, so the "24px or more"
	// heuristic can never hold again — a second decorate dropped the column.
	const body = helperBody("decorateTranscript");
	assert.match(body, /hasAttribute\("data-rdsh-transcript"\)/, "an already tagged node short-circuits the heuristic");
	assert.match(body, /data-rdsh-transcript-column/);
	// #69: the fixed 349px reading measure was replaced by the available
	// conversation width. The column keeps the tag and stays centred.
	assert.match(CLIENT, /\[data-rdsh-transcript-column\] \{\s*\n\s*width: 100% !important;/, "the column no longer uses the available width");
	assert.match(CLIENT, /\[data-rdsh-transcript-column\] \{[^}]*max-width: 100% !important;/, "a narrow viewport can overflow");
	assert.match(CLIENT, /\[data-rdsh-transcript-column\] \{[^}]*margin-left: auto !important;/, "the column is not centred");
});

test("the question card uses the composer's 16px viewport gutters", () => {
	// The card is no longer pinned to the transcript's 349px column: on a
	// phone it is viewport - 32px so both edges sit 16px from the screen. The
	// frame spans the seat, box-sizing keeps its own padding from enlarging it,
	// and flex must not shrink the card back to the content width.
	assert.match(
		CLIENT,
		/\[data-rdsh-question-frame\] \{[^}]*box-sizing: border-box !important;[^}]*width: 100% !important;[^}]*max-width: 100% !important;[^}]*justify-content: flex-start !important;[^}]*padding-left: 16px !important; padding-right: 16px !important;/,
		"the question frame no longer spans the seat with a 16px gutter",
	);
	assert.match(
		CLIENT,
		/\[data-rdsh-question-frame\] > \[data-rdsh-question-card\] \{[^}]*flex: 0 0 auto !important;[^}]*width: calc\(100vw - 32px\) !important;[^}]*max-width: calc\(100vw - 32px\) !important;[^}]*margin-left: 0 !important; margin-right: 0 !important;/,
		"the card is not viewport - 32px with zero auto margins",
	);
	assert.match(CLIENT, /\[data-rdsh-question-card\] > \[class\*="_header"\]/, "the direct-child header padding is gone");
	assert.match(CLIENT, /\[data-rdsh-question-card\] > \[class\*="_footer"\]/, "the direct-child footer padding is gone");
	assert.equal(/\[data-rdsh-question-card\] \[class\*="_footer"\]/.test(CLIENT), false, "the descendant selector is back");
	assert.equal(/\[data-rdsh-question-card\] \[class\*="_option"\]/.test(CLIENT), false, "the ambiguous option selector is back");
	assert.match(CLIENT, /\[class\*="_field"\] > \* \{ font-size: 16px/, "the answer mirror and the textarea share the font");
});

test("the device theme never writes the shared preference", () => {
	// #5: theme.setTheme() writes the profile, which is what propagated a phone
	// change to every connected browser. The override must stay browser-local.
	assert.equal(/setTheme\s*\(/.test(stripLiterals(CLIENT)), false, "theme.setTheme() must never be called");
	assert.match(CLIENT, /dsh-mobile-maxxing:device-theme/, "the choice is stored per browser");
	assert.match(CLIENT, /data-ds-dark-theme/, "the override repaints the upstream palette attribute");
});

// ---------------------------------------------------------------------------
// Phone scoping: anything that dresses upstream DOM, or that assumes a finger,
// has to stay inside the phone query or a desktop session looks like a phone.
// ---------------------------------------------------------------------------

/** One `const NAME = \`…\`;` template, with the query interpolated in. */
function cssTemplate(name) {
	const tick = String.fromCharCode(96);
	const match = CLIENT.match(new RegExp(`const ${name} = ${tick}([\\s\\S]*?)${tick};\\n`));
	assert.ok(match, `${name} exists`);
	return match[1].replace(/\$\{NARROW_QUERY\}/g, "(max-width: 767px)");
}

/**
 * Both stylesheets as the browser receives them: the PWA shell, and the phone
 * half wrapped mechanically by `phoneStyles()`.
 */
function cssBlocks() {
	const shell = cssTemplate("CSS");
	const device = cssTemplate("CSS_DEVICE");
	const phone = cssTemplate("CSS_PHONE");
	return [shell, device, phone];
}

/**
 * Flatten a stylesheet into one entry per declaration block.
 *
 * Comments are dropped first: this file's comments quote selectors, and a
 * brace inside prose would otherwise open a block.
 */
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
		if (character === ";") {
			current = "";
			continue;
		}
		current += character;
	}
	return rules;
}

/** The text just inside a function declaration or an arrow constant. */
function functionHead(name, length = 900) {
	const declared = CLIENT.indexOf(`function ${name}(`);
	const assigned = CLIENT.indexOf(`const ${name} = (`);
	const at = declared >= 0 ? declared : assigned;
	assert.ok(at >= 0, `${name} is missing`);
	return CLIENT.slice(at, at + length);
}

test("upstream hooks are styled only in the mobile stylesheet", () => {
	// The report behind this test: on a desktop, running sessions showed the
	// phone ring, the open row was painted with a hard-coded #232324, image
	// previews were darkened and cropped. The boundary is now the bootstrapped
	// mode: the mobile sheet is a separate <style> that a desktop never gets.
	const device = cssTemplate("CSS_DEVICE");
	const leaked = cssRules(device)
		.filter((rule) => /\[data-rdsh-/.test(rule.head))
		.map((rule) => rule.head);
	assert.deepEqual(leaked, [], "an upstream hook leaked into the always-on stylesheet");
	const phone = cssTemplate("CSS_PHONE");
	assert.match(phone, /\[data-rdsh-session-frame\]/, "the session frame rule is not in the mobile sheet");
	assert.match(phone, /\[data-rdsh-folder-frame\]/, "the folder frame rule is not in the mobile sheet");
	assert.doesNotMatch(phone, /@media \(max-width: 767px\)/, "the mobile sheet regained a max-width wrapper");
	// The drawer header toggle: every pointer state is label-primary on a
	// transparent background, no Android tap flash, and no delayed tooltip.
	assert.match(
		CLIENT,
		/\[data-rdsh-sidebar-toggle\],\s*\n\s*\[data-rdsh-sidebar-toggle\]:is\(:hover, :active, :focus\) \{\s*\n\s*color: var\(--dsw-alias-label-primary\) !important;\s*\n\s*background: transparent !important;/,
		"the drawer header toggle does not follow the reference paint",
	);
	assert.match(CLIENT, /\[data-rdsh-sidebar-toggle\] \* \{ -webkit-tap-highlight-color: transparent; \}/, "the toggle children keep the tap flash");
	assert.match(CLIENT, /html:has\(\[data-rdsh-sidebar-toggle\]:is\(:hover, :focus\)\) \[role="tooltip"\] \{ display: none !important; \}/, "the toggle tooltip is not suppressed");
});

test("NARROW_QUERY is geometry only and has one definition", () => {
	// Width is still measured for the Settings readout and for the mobile
	// layout's own geometry, but it no longer selects the mode.
	const definitions = [...CLIENT.matchAll(/const NARROW_QUERY = "([^"]+)";/g)].map((match) => match[1]);
	assert.equal(definitions.length, 1, "the width query is defined once, at module scope");
	assert.equal(definitions[0], "(max-width: 767px)", "the geometry query gained an orientation or pointer clause");
	assert.equal(
		(CLIENT.match(/@media \(max-width: 767px\)/g) ?? []).length,
		0,
		"a hand-written width feature query came back",
	);
	assert.match(CLIENT, /function phone\(\) \{\s*return DEVICE_MODE === "mobile";/, "phone() is not the bootstrapped mode");
});

test("Enter follows the phone width, as in the reference build", () => {
	// The phone default (Enter inserts a newline) is the opposite of the stock
	// composer. The reference gated it on width only, so a narrow desktop
	// window gets the phone behaviour too.
	const head = functionHead("onKeyDownCapture", 1200);
	assert.match(head, /const finger = phone\(\);/, "onKeyDownCapture no longer asks about the layout");
	assert.match(head, /if \(!finger && !notifyDeviceTurns\(\)\) return;/, "a wide desktop only enters the key path for the #15 opt-in");
	assert.doesNotMatch(stripLiterals(head), /coarsePointer\s*\(/, "a narrow fine pointer would lose the phone default");
});

test("panel-wide decorations stay off the desktop", () => {
	// Both of these reach across upstream UI: the stats dock reads a number
	// from upstream buttons and the lightbox injects a crop button. A wide
	// window must also undo what a narrower pass left behind.
	const stats = functionHead("decorateStatsDock", 700);
	assert.match(stats, /if \(!phone\(\)\) \{/, "decorateStatsDock is not mode-gated");
	assert.match(stats, /clearOwnedAttribute\("data-rdsh-stat-text"\)/, "a desktop pass leaves the stats hook");
	const lightbox = functionHead("decorateLightbox", 700);
	assert.match(lightbox, /if \(!phone\(\)\) \{/, "decorateLightbox is not mode-gated");
	assert.match(lightbox, /clearLightboxHooks\(\)/, "a desktop pass leaves the crop button");
});

test("dispose removes the mobile hooks, including the colour frame", () => {
	// The mobile surface is fixed at boot and removed by dispose, never by a
	// width crossing. Attributes are still stripped with the rest so a live
	// reload starts clean, and the frame CSS lives in the mobile sheet.
	assert.match(CLIENT, /function clearSessionRowHooks\(\)/, "no row cleanup");
	assert.match(CLIENT, /function clearPhoneHooks\(\)/, "no header/typing cleanup");
	const width = CLIENT.slice(CLIENT.indexOf("const applyWidthBoundary = () => {"), CLIENT.indexOf("const onMedia =", CLIENT.indexOf("const applyWidthBoundary = () => {")));
	assert.match(width, /emit\(\{ narrow: narrow\(\) \}\);/, "syncWidth no longer updates the geometry readout");
	assert.match(width, /if \(!phone\(\)\) return;/, "syncWidth still runs mobile effects on a desktop");
	assert.doesNotMatch(width, /clearPhoneHooks|installDrawer|applyDeviceTheme|enforceNoZoomViewport/, "a width crossing still changes the mobile surface");
	assert.match(CLIENT, /"data-rdsh-sidebar-toggle"/, "the sidebar toggle tag is not cleaned up");
	const toggle = functionHead("decorateSidebarToggle", 1700);
	assert.match(toggle, /if \(!phone\(\)\)/, "the sidebar toggle is tagged on a desktop");
	assert.match(toggle, /sidebarToggle\(\)/, "the decorator does not share the action locator");
	const toggleAt = CLIENT.indexOf("function decorateSidebarToggle(");
	const toggleBody = CLIENT.slice(toggleAt, CLIENT.indexOf("\n    }\n", toggleAt));
	assert.doesNotMatch(toggleBody, /document\.querySelector\(/, "the decorator bypasses the bounded locator");
	assert.match(toggleBody, /if \(toggle === null\) return;/, "the decorator leaves a stale tag when the toggle is missing");
	const locator = functionHead("sidebarToggle", 1700);
	assert.match(locator, /\[data-slot="sidebar"\]/, "the sidebar toggle search is not bounded by its slot");
	assert.match(locator, /if \(sidebar === null\) return null;/, "a missing sidebar falls back to a global control");
	assert.match(locator, /ariaLabelSelector\("button", "sidebarOpen", "Open sidebar"\)/, "the drawer's open label vocabulary is not used");
	assert.match(locator, /ariaLabelSelector\("button", "sidebarCollapse", "Collapse sidebar"\)/, "the drawer's collapse label vocabulary is not used");
	assert.match(locator, /\[data-window-drag\]/, "the localized structural fallback is missing");
	assert.match(locator, /const openLabels = probeValues\("sidebarOpen", \["Open sidebar"\]\)/, "closing does not check the known open labels");
	assert.match(locator, /!openLabels\.includes\(button\.getAttribute\("aria-label"\)\)/, "closing can click a control known to open the sidebar");
	const action = functionHead("toggleDrawer", 500);
	assert.match(action, /sidebarToggle\(\)/, "the drawer action bypasses the decorator locator");
	assert.match(action, /ariaLabelSelector\("button", "sidebarOpen", "Open sidebar"\)/, "the stock action fallback is gone");
	assert.match(action, /ariaLabelSelector\("button", "sidebarCollapse", "Collapse sidebar"\)/, "the stock action fallback lost its collapse label");
	const close = functionHead("closeDrawer", 1400);
	assert.match(close, /const collapse = sidebarToggle\(true\)/, "the close path does not use the collapse-only locator");
	assert.match(close, /ariaLabelSelector\("button", "sidebarCollapse", "Collapse sidebar"\)/, "the close path lost its collapse-only stock fallback");
	assert.doesNotMatch(close, /Open sidebar/, "the close path can click a control known to open the sidebar");
	// Session rows are still visited on every pass, but the function only
	// writes the mobile hooks (frame included) in mobile mode.
	assert.match(CLIENT, /^\s+decorateSessionRows\(\);\s*$/m, "session rows are no longer visited on desktop");
	assert.match(
		CLIENT,
		/function decorateSessionRows\(\) \{\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!phone\(\)\) \{\s*\n\s*if \(rowHooksActive\) clearSessionRowHooks\(\);\s*\n\s*return;\s*\n\s*\}/,
		"the desktop pass does not clear the mobile row hooks",
	);
	const phoneCss = cssTemplate("CSS_PHONE");
	assert.match(phoneCss, /\[data-rdsh-session-frame\]/, "the session frame rule is not in the mobile stylesheet");
	assert.match(phoneCss, /\[data-rdsh-folder-frame\]/, "the folder frame rule is not in the mobile stylesheet");
	assert.doesNotMatch(phoneCss, /@media \(max-width: 767px\)/, "the frame is behind a width wrapper again");
	assert.match(CLIENT, /"data-rdsh-session-frame",/, "the frame hook is not in the cleanup list");
	assert.match(CLIENT, /"data-rdsh-folder-frame",/, "the folder frame hook is not in the cleanup list");
	assert.match(CLIENT, /"data-rdsh-folder-menu",/, "the folder menu hook is not in the cleanup list");
});

test("folder frames reuse the native menu cell and claim only the folder portal", () => {
	// The icon looked misaligned because the item carried its own padding, gap
	// and 16px seat. It is now the same MenuItemButton native pin/rename use.
	const item = functionHead("ColorFrameMenuItem", 1600);
	assert.match(item, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/, "the colour-frame row does not use the shell primitive");
	assert.match(item, /MenuItemButton/, "the colour-frame row no longer renders MenuItemButton");
	assert.match(item, /icon: frameIcon\(\)/, "the frame glyph is not passed through the native icon seat");
	assert.doesNotMatch(item, /rdsh-frame-menu-item/, "the hand-built menu cell came back");
	const phone = cssTemplate("CSS_PHONE");
	assert.doesNotMatch(phone, /\.rdsh-frame-menu-item/, "the custom menu-cell geometry came back");
	assert.doesNotMatch(phone, /\.rdsh-frame-menu-icon/, "the custom icon seat came back");

	// No slot exists for the workspace menu: ownership is the portal the click
	// opened, linked aria-controls <-> id. Labels are never read.
	assert.match(CLIENT, /const SESSION_FRAME_KEY = "rdsh-mobile-ux:session-frames"/, "the session key moved");
	assert.match(CLIENT, /const FOLDER_FRAME_KEY = "dsh-mobile-maxxing:folder-frames"/, "the folder key is not the dsh namespace");
	const attach = functionHead("attachFolderMenu", 2600);
	assert.match(attach, /menu\.setAttribute\(FOLDER_MENU_ATTR/, "the claimed portal is not marked");
	assert.match(attach, /button\.setAttribute\("aria-controls", id\)/, "the anchor does not own the portal by aria-controls");
	assert.doesNotMatch(attach, /aria-haspopup/, "the folder anchor claims a picker/model popup");
	assert.match(attach, /MenuItemButton/, "the folder row is not the native menu cell");
	const decorateAt = CLIENT.indexOf("function decorateFolderMenu(");
	const decorate = CLIENT.slice(decorateAt, CLIENT.indexOf("\n    function showFramePalette", decorateAt));
	assert.match(decorate, /!pending\.known\.has\(node\)/, "a menu that was already open can be claimed");
	assert.match(decorate, /!node\.hasAttribute\(FOLDER_MENU_ATTR\)/, "an already-decorated portal can be claimed twice");
	assert.doesNotMatch(decorate, /textContent|aria-label|labelOf/, "a folder menu was matched by its copy");
	const arm = functionHead("armFolderMenu", 1200);
	assert.match(arm, /folderRowMenuButton\(row\) !== button/, "a non-menu row action can arm the claim");
	assert.match(arm, /workspaceKeyOf\(row\) === ""/, "the Ungrouped bucket can arm a folder claim");
	const escape = functionHead("onKeyDown", 400);
	assert.match(escape, /closeFramePalette\(\)/, "Escape does not close the frame palette");

	// #97 moved the session row actions into decorateRowActions. The folder
	// pass is per row pass, not per session row, and must stay outside it.
	const rowsAt = CLIENT.indexOf("function decorateSessionRows(");
	const rowActionsAt = CLIENT.indexOf("function decorateRowActions(");
	const rows = CLIENT.slice(rowsAt, rowActionsAt);
	assert.match(rows, /for \(const row of document\.querySelectorAll\('\[data-row-key\^="workspace:"\]'\)\)/, "folder rows are not visited once per pass");
	assert.match(rows, /decorateFolderMenu\(\)/, "the folder menu is not decorated once per pass");
	const actions = CLIENT.slice(rowActionsAt, CLIENT.indexOf("let rowHooksActive", rowActionsAt));
	assert.doesNotMatch(actions, /applyFolderFrame|decorateFolderMenu/, "the folder pass moved back inside decorateRowActions");
});

test("the live-speed poller only runs in mobile mode", () => {
	const body = functionHead("LiveSpeed", 2400);
	assert.match(body, /if \(!sessionId \|\| !phone\) \{/, "the poller runs on a desktop");
	assert.match(body, /if \(!phone \|\| speed === null\) return null;/, "the speed label renders on a desktop");
});

test("resize only drops gestures on a real width change or a rotation", () => {
	// The reference did not reset gestures on resize at all. Height-only
	// changes (keyboard, URL bar) and visualViewport events must leave an
	// in-flight swipe alone; a real width change, a rotation or leaving the
	// phone layout still resets it, and touchend/touchcancel always clear.
	assert.match(functionHead("resetGestures", 400), /edgeSwipe = null;\s*\n\s*touchStart = null;/, "no gesture reset");
	// There is a second `onResize` in the crop editor; anchor on the rotation
	// state that only the boot handler declares.
	const at = CLIENT.indexOf("let rotationTimer = 0;");
	assert.ok(at >= 0, "no rotation follow-up");
	const resize = CLIENT.slice(at, at + 1900);
	assert.match(resize, /let gestureWidth = window\.innerWidth;/, "the boot handler does not remember the width");
	assert.match(resize, /if \(window\.innerWidth !== gestureWidth\) \{[\s\S]{0,120}?resetGestures\(\);/, "a width change does not reset gestures");
	assert.match(resize, /const onOrientation = \(\) => \{[\s\S]{0,120}?resetGestures\(\);/, "a rotation does not reset gestures");
	assert.match(resize, /measureSafeArea\(\)/, "resize does not re-measure");
	assert.match(resize, /scheduleDecorate\(\)/, "resize does not redecorate");
	assert.match(resize, /rotationTimer = window\.setTimeout\(\(\) => \{[\s\S]{0,200}?measureSafeArea\(\);[\s\S]{0,100}?scheduleDecorate\(\);[\s\S]{0,80}?\}, 350\)/, "no follow-up pass for the late safe-area values");
	assert.match(CLIENT, /visualViewport\?\.addEventListener\("resize", onLayoutResize\)/, "the visual viewport is not watched");
	assert.doesNotMatch(CLIENT, /visualViewport\?\.addEventListener\("resize", onResize\)/, "visualViewport still empties the gesture");
	assert.match(CLIENT, /attributeFilter: \[[^\]]*"data-sidebar-collapsed"/, "drawer changes are not observed");
	assert.match(CLIENT, /attributeFilter: \[[^\]]*"data-rightbar-collapsed"/, "panel changes are not observed");
});

test("#76 keyboard-hide recovery only re-runs the existing layout pass", () => {
	// iPadOS can hide the keyboard with the composer focused and no
	// visualViewport resize. The recovery must be measurement + decorate + fit
	// from lifecycle signals, not a fake reflow, a document scroll or a blur:
	// the native blank strip belongs to WebKit and the composer to upstream.
	const at = CLIENT.indexOf("const applyKeyboardRecovery =");
	assert.ok(at >= 0, "no keyboard-hide recovery");
	const end = CLIENT.indexOf("const scheduleKeyboardRecovery", at);
	assert.ok(end > at, "the recovery body is unterminated");
	const body = CLIENT.slice(at, end);
	assert.match(body, /measureSafeArea()/, "the recovery does not re-measure");
	assert.match(body, /scheduleDecorate()/, "the recovery does not redecorate");
	assert.match(body, /scheduleTerminalFit()/, "the recovery does not refit the terminal");
	assert.doesNotMatch(body, /scrollTo|scrollTop|style\.(?:height|display|transform)|offsetHeight|blur\(|\.focus\(/, "the recovery fakes a reflow, scrolls or moves focus");
	// A keyboard-shrunk layout height must not become a published native gap.
	assert.match(body, /keyboardSettled\(\)/, "the recovery ignores whether the keyboard has gone");
	assert.match(CLIENT, /layoutHeightMax - window\.innerHeight > LAYOUT_SHRINK_MAX_PX/, "a keyboard-sized layout height can be published as a native gap");
	const installAt = CLIENT.indexOf("if (phone()) {\n          document.addEventListener(\"focusout\", onKeyboardFocusOut, true);", at);
	assert.ok(installAt > at, "the recovery listeners are not mobile-only");
});

test("#76 the keyboard-hide listeners and pending work are torn down", () => {
	for (const line of [
		'document.removeEventListener("focusout", onKeyboardFocusOut, true)',
		'document.removeEventListener("visibilitychange", onKeyboardVisibility)',
		'window.removeEventListener("blur", scheduleKeyboardRecovery)',
		'window.removeEventListener("focus", scheduleKeyboardRecovery)',
	]) {
		assert.ok(CLIENT.includes(line), `teardown lost: ${line}`);
	}
	assert.match(CLIENT, /if \(keyboardRecoveryFrame !== 0\) \{\s*cancelAnimationFrame\(keyboardRecoveryFrame\)/, "a queued recovery frame survives teardown");
	assert.match(CLIENT, /clearTimeout\(keyboardRecoveryTimer\)/, "a pending recovery timer survives teardown");
});

test("the right panel is only looked for inside its own subtree", () => {
	// A hidden route keeps a 0x0 copy of the collapse button; walking up from
	// it without a boundary tagged the app frame as the panel, which then hid
	// the header and the drawer button with no way back on a phone.
	assert.match(CLIENT, /const RIGHT_PANEL_ROOT = "\[data-sidebar-right-panel\]"/, "no boundary");
	assert.match(functionHead("visibleCollapseButton", 900), /rect\.width <= 0 \|\| rect\.height <= 0/, "the 0x0 ghost is not skipped");
	assert.match(CLIENT, /const boundary = collapse\.closest\(RIGHT_PANEL_ROOT\)/, "the walk is not bounded");
	assert.match(CLIENT, /while \(node !== null && node !== boundary && node !== document\.body\)/, "the walk ignores the boundary");
	assert.match(functionHead("forgetRightPanel", 700), /querySelectorAll\("\[data-rdsh-rightpanel\]"\)/, "stale panel tags are kept");
	assert.match(CLIENT, /host\.closest\("\[hidden\]"\) === null/, "a hidden panel still counts as open");
});

test("a finger drag in the terminal becomes a wheel event", () => {
	// The bundled xterm 6.0 scrolls only on wheel events (there is no DOM
	// scroller), so this bridge is the whole fix; CSS can only get out of its
	// way.
	assert.match(CLIENT, /const XTERM_SCROLLER = "\.xterm-scrollable-element"/, "the scroller node is not named");
	assert.match(CLIENT, /wheel\.deltaMode = 0/, "the wheel delta is not pixel mode");
	assert.match(CLIENT, /wheel\.deltaY = -pixels \* TERMINAL_WHEEL_PER_PX/, "the wheel delta is not derived from the drag");
	assert.match(CLIENT, /function onTouchMove\(event\) \{\s*\n\s*if \(moveTerminalDrag\(event\)\) return;/, "the bridge does not own the gesture");
	assert.match(CLIENT, /function onTouchStart\(event\) \{\s*\n\s*startTerminalDrag\(event\);/, "no drag start");
	assert.match(CLIENT, /function onEdgeSwipeEnd\(\) \{\s*\n\s*edgeSwipe = null;\s*\n\s*endTerminalDrag\(\);/, "the drag outlives the gesture");
	// ...and the overscroll guard must stop cancelling the drags the bridge wants.
	assert.match(CLIENT, /target\.closest\("textarea, input, \.xterm"\)\) return;/, "the overscroll guard still cancels terminal drags");
	assert.match(CLIENT, /target\.closest\("input, textarea, \[contenteditable=true\], \.xterm/, "the back-swipe still claims terminal drags");
});

test("#59 landscape nav More is a mobile-sheet control", () => {
	const phone = cssTemplate("CSS_PHONE");
	const device = cssTemplate("CSS_DEVICE");
	assert.match(phone, /\[data-rdsh-nav-more-hidden\] \{ display: none !important; \}/, "the folded rows have no hide rule");
	assert.match(phone, /\.rdsh-mux-nav-more-menu/, "the More menu has no phone styling");
	assert.doesNotMatch(device, /rdsh-nav-more|data-rdsh-nav-more/, "a landscape nav rule leaked into the device sheet");
	// The gate is phone mode AND landscape geometry, not a width breakpoint.
	assert.match(
		CLIENT,
		/function navMoreLandscape\(\) \{\s*return phone\(\) && window\.innerWidth > window\.innerHeight;\s*\}/,
		"the More gate is not mobile-landscape",
	);
	assert.match(CLIENT, /function clearSidebarNavMore\(\)/, "the injected More row has no cleanup path");
});

test("the right panel keeps upstream tab dimensions but its tap replay", () => {
	assert.match(functionHead("decorateRightPanelTabs", 600), /querySelectorAll\('\[data-rdsh-rightpanel\] \[role="tab"\]\[data-dockkit-tab\]'\)/, "the tab selector is not attribute-based");
	assert.match(functionHead("decorateRightPanelTabs", 600), /tab\.setAttribute\("data-rdsh-rtab", ""\)/, "the tab hook is never written");
	// A tap the app turned into a drag never produces a click; replay one.
	assert.match(CLIENT, /tabReplayTimer = window\.setTimeout\(\(\) => \{[\s\S]{0,500}?tabTap\.tab\.dispatchEvent\(new MouseEvent\("click"/, "no tap replay");
	assert.match(CLIENT, /if \(tabTap\.fired \|\| !tabTap\.tab\.isConnected\) return;/, "the replay is not one-shot");
	assert.match(CLIENT, /target\.closest\("\[data-rdsh-rtab\]"\) === tabCandidate\.tab\) tabCandidate\.fired = true;/, "a real click does not cancel the replay");
	// The merged build enlarged the strip (44px rows, min-width 88px, pan-x,
	// selected-only close). The reference leaves the upstream dimensions.
	assert.doesNotMatch(CLIENT, /\[data-rdsh-rightpanel\] \[data-dockkit-tab\] \{\s*\n\s*height: 44px/, "the 44px tab row is still applied");
	assert.doesNotMatch(CLIENT, /\[data-rdsh-rightpanel\] \[data-dockkit-tab\] \{[^}]*min-width: 88px/, "the widened tab minimum is still applied");
	assert.doesNotMatch(CLIENT, /data-dockkit-strip-tabs\] \{\s*\n\s*touch-action: pan-x/, "the tab strip is still forced to pan-x");
	assert.doesNotMatch(CLIENT, /data-dockkit-tab-close\] \{ display: none !important; \}/, "the upstream hover close is still suppressed");
});

import { COPY, PROBES, copyFor } from "../lib/copy.js";
/** Files that render or serve UI copy. `lib/copy.js` is the only exception. */
const UI_FILES = ["client.js", "index.js", "sw.js", "notify/host.js"];

/** CJK kana, ideographs and compatibility ideographs. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Extract every string and template literal, skipping comments.
 *
 * Regex literals are deliberately not collected: the one CJK literal left in
 * `client.js` is a punctuation character class used to pace the title typing
 * animation, not copy. Everything a user can read must be a string.
 */
function stringLiterals(source) {
	const literals = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (character !== '"' && character !== "'" && character !== "`") {
			index += 1;
			continue;
		}
		const quote = character;
		let text = "";
		index += 1;
		while (index < source.length) {
			if (source[index] === "\\") {
				text += source.slice(index, index + 2);
				index += 2;
				continue;
			}
			if (source[index] === quote) {
				index += 1;
				break;
			}
			text += source[index];
			index += 1;
		}
		literals.push(text);
	}
	return literals;
}



test("no UI copy carries CJK outside the dictionary", () => {
	// The original bug: Japanese literals shipped in a shell that renders in
	// English. Copy now lives in lib/copy.js; a CJK string anywhere else is a
	// regression, whatever the reason. The one exception is index.js's
	// DEFAULTS.description: it is the legacy ja default kept for direct
	// readers of DEFAULTS, while the effective description comes from
	// lib/copy.js for the configured language.
	const allowed = new Set(["index.js: DeepSeek Harness をアプリのように起動します。"]);
	const offenders = [];
	for (const file of UI_FILES) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		for (const literal of stringLiterals(source)) {
			if (CJK.test(literal) && !allowed.has(`${file}: ${literal}`)) offenders.push(`${file}: ${literal.slice(0, 60)}`);
		}
	}
	assert.deepEqual(offenders, [], "a string literal outside lib/copy.js contains CJK");
});

test("every t() key exists in the English dictionary", () => {
	const keys = new Set([...CLIENT.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]));
	assert.ok(keys.size > 50, "the client uses the dictionary for its UI");
	const missing = [...keys].filter((key) => !(key in COPY.en));
	assert.deepEqual(missing, [], "a t() key has no English string");
});

test("the English dictionary has no CJK and no empty strings", () => {
	const empty = Object.entries(COPY.en).filter(([, value]) => typeof value !== "string" || value === "");
	assert.deepEqual(empty, [], "English keys carry a string");
	const cjk = Object.entries(COPY.en).filter(([, value]) => CJK.test(value));
	assert.deepEqual(cjk, [], "English copy is English");
});

test("the Japanese pack covers every English key with real copy", () => {
	// The reference copy is restored: no key may fall back to English and no
	// pack may invent a key the code never renders.
	const unknown = Object.keys(COPY.ja).filter((key) => !(key in COPY.en));
	assert.deepEqual(unknown, [], "the ja pack carries an unknown key");
	const missing = Object.keys(COPY.en).filter((key) => !(key in COPY.ja));
	assert.deepEqual(missing, [], "the ja pack is missing keys");
	const empty = Object.entries(COPY.ja).filter(([, value]) => typeof value !== "string" || value === "");
	assert.deepEqual(empty, [], "a ja key is empty");
	const samePlaceholders = Object.keys(COPY.en).filter((key) => {
		const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
		return names(COPY.en[key]) !== names(COPY.ja[key]);
	});
	assert.deepEqual(samePlaceholders, [], "a ja string changes a placeholder");
	assert.equal(copyFor("ja")["tab.mobile"], "モバイル", "the ja pack is not used");
	assert.equal(copyFor("xx")["tab.mobile"], COPY.en["tab.mobile"], "an unknown language falls back to English");
});

test("upstream label probes cover English and Japanese", () => {
	// These are never rendered: they are how decoration finds the shell's
	// controls. A single-language probe would silently stop matching if the
	// shell's locale changed, so every known locale stays listed.
	for (const key of ["actions", "stop", "settingsMenu", "untitled"]) {
		assert.ok(Array.isArray(PROBES[key]) && PROBES[key].length >= 2, `${key} is bilingual`);
	}
	assert.ok(PROBES.untitled.includes("new session"));
	assert.ok(PROBES.untitled.includes("新しいセッション"));
	// #59: the landscape More menu and the drawer route-close both use these.
	assert.ok(PROBES.navPlugins.includes("Plugins"));
	assert.ok(PROBES.navAutomation.includes("Automation tasks"));
});

test("representative Japanese copy matches the reference wording", () => {
	// Not just pack self-consistency: these are the strings a user sees. A
	// mistranslation or an accidental English fallback has to fail here.
	const expected = {
		"tab.mobile": "モバイル",
		"pwa.section.title": "アプリ（PWA）",
		"mux.fab.open": "セッション一覧を開く",
		"mux.fab.openWithCount": "セッション一覧を開く（未読・質問待ち {count}件）",
		// The row's visible name is part of the reference: it stays "Settings"
		// in the ja pack (the settings tab labels are Japanese, this row is not).
		"mux.settingsRow": "Settings",
		"add.label": "画像やファイルを追加",
		"crop.title": "画像をトリミング",
		"crop.cancel": "キャンセル",
		"crop.save": "クエリに追加",
		"frame.menu": "色枠",
		// The palette is shared by sessions and folders: no target in the label.
		"frame.paletteAria": "枠の色",
		"notify.turn.completed": "作業完了",
		"notify.questionHeader": "確認",
		"notify.previewQuestion": "このまま進めますか？",
		"sw.offlineHeading": "オフラインです",
		"sw.retry": "再試行",
		// Mixed Japanese/English reference: the turn counter stays English.
		"mux.stats.turn": "{count} turn",
		"mux.stats.turns": "{count} turns",
		// The stats usage line and the detail popover headings stay English too.
		"mux.stats.cacheHit": "Cache hit {percent}%",
		"mux.detail.goal": "Goal",
	};
	for (const [key, value] of Object.entries(expected)) {
		assert.equal(copyFor("ja")[key], value, `${key} does not match the reference Japanese`);
	}
	assert.equal(copyFor("en")["tab.mobile"], "Mobile");
	assert.equal(copyFor("en")["frame.paletteAria"], "Frame color", "the English palette label names a session only");
});

test("the local session-id copy row is gone (#99)", () => {
	// rc.3 registers its own `session-id` row in the same menu slot, so the
	// local part made the menu show two identical copy rows. Upstream is the
	// only owner now: the factory, its slot id and its copy keys stay gone.
	assert.equal(CLIENT.includes("sessionIdCopyPart"), false, "the local factory is still in the bundle");
	assert.equal(CLIENT.includes("rdsh-session-id-copy"), false, "the local slot id is still in the bundle");
	const copy = readFileSync(new URL("../lib/copy.js", import.meta.url), "utf8");
	assert.equal(/["']sessionId\./.test(copy), false, "a sessionId.* copy key is still shipped");
});

test("the retired diagnostics and custom hide are gone", () => {
	// The user removed the height/safe-area/gap and scroll diagnostics plus the
	// browser-side custom hide list. Nothing may creep back: no helper, no
	// public export, no listener and no Settings card.
	for (const gone of [
		"readViewportMetrics",
		"lastScrolls",
		"scrollChain",
		"recordScroll",
		"readHideExtra",
		"hide-extra",
		"hide-disabled",
	]) {
		assert.equal(CLIENT.includes(gone), false, `${gone} is still in the bundle`);
	}
	const start = CLIENT.indexOf("function MobileSection(");
	const end = CLIENT.indexOf("function InputSection(", start);
	const section = CLIENT.slice(start, end);
	for (const gone of ["mux.diag.", "mux.hidden.", "mux.row."]) {
		assert.equal(section.includes(gone), false, `the Settings section still renders ${gone}`);
	}
	// The standard hide list and the console option survive; the browser-side
	// overrides do not.
	assert.match(CLIENT, /const HIDE_DEFAULT = \[/, "the standard hide list is gone");
	assert.match(CLIENT, /function hideLabels\(\) \{[\s\S]*?\.\.\.HIDE_DEFAULT,[\s\S]*?\.\.\.probeValues\("hideControls"\),[\s\S]*?Array\.isArray\(CONFIG\.hideLabels\)/, "the localized defaults or the profile hide list are gone");
	assert.match(CLIENT, /function hideDisabled\(\) \{\s*\n\s*return CONFIG\.showHiddenControls === true;/, "the console option is gone");
});

/**
 * Shipped code files: the entries in package.json's `files` that carry source.
 * Tests are deliberately not listed, so this regression never scans itself.
 */
function shippedCodeFiles() {
	const root = new URL("../", import.meta.url);
	const files = ["index.js", "client.js", "sw.js", "cordis.patch.yml"].map((name) => new URL(name, root));
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
			if (entry.isDirectory()) walk(child);
			else if (/\.(?:js|mjs|json|ya?ml)$/.test(entry.name)) files.push(child);
		}
	};
	walk(new URL("notify/", root));
	walk(new URL("lib/", root));
	return files;
}

test("shipped code carries no personal provider or device identifiers", () => {
	// The reference UI is generic: no operator-specific provider name, account
	// path, or device/host label may reach copy that every install renders.
	// Tests are excluded by shippedCodeFiles(), so this only guards shipped code.
	const personal = new RegExp(
		[
			// a concrete account's home directory: /home/<user>, /Users/<user>
			String.raw`\/(?:home|Users)\/[A-Za-z0-9._-]+`,
			// desktop-style host labels: a short alphabetic prefix plus three
			// digits. Longer digit runs collide with standards and escapes, and
			// codec names share this shape without being identifiers.
			String.raw`(?<![\\#])\b(?!h26[45]\b|x26[45]\b)[a-z]{1,2}\d{3}\b`,
			// RFC 1918 private and Tailscale CGNAT IPv4 literals
			String.raw`\b10\.(?!0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\b`,
			String.raw`\b192\.168\.(?!0\.0\b)\d{1,3}\.\d{1,3}\b`,
			String.raw`\b172\.(?:1[6-9]|2\d|3[01])\.(?!0\.0\b)\d{1,3}\.\d{1,3}\b`,
			String.raw`\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?!0\.0\b)\d{1,3}\.\d{1,3}\b`,
		].join("|"),
	);
	const detects = (sample) => personal.test(sample);
	for (const sample of [
		"/home/example/app",
		"/Users/example/app",
		"pc123-desktop",
		"10.1.2.3",
		"172.20.3.4",
		"192.168.1.20",
		"100.101.102.103",
	]) {
		assert.ok(detects(sample), `the identifier shape ${sample} is not detected`);
	}
	for (const sample of ["icon-192", "sha256", "h264", "#ef4444", "p1363", "10.0.0.0", "172.16.0.0", "192.168.0.0", "100.64.0.0"]) {
		assert.ok(!detects(sample), `the generic token ${sample} is a false positive`);
	}
	const offenders = [];
	for (const file of shippedCodeFiles()) {
		const text = readFileSync(file, "utf8");
		const match = text.match(personal);
		if (match !== null) offenders.push(`${file.pathname}: ${match[0]}`);
	}
	assert.deepEqual(offenders, [], "a shipped file contains a personal provider or device identifier");
});

test("the question card viewport sizing is mobile-only", () => {
	// Desktop must keep the upstream card width: the 100vw - 32px rule lives
	// in the mobile stylesheet, which a desktop never receives.
	const rules = cssRules(cssTemplate("CSS_PHONE"));
	const frame = rules.find((rule) => rule.head === "[data-rdsh-question-frame]");
	const card = rules.find((rule) => rule.head === "[data-rdsh-question-frame] > [data-rdsh-question-card]");
	assert.ok(frame, "the question frame rule is missing from the mobile sheet");
	assert.ok(card, "the question card rule is missing from the mobile sheet");
});

test("the queue joins only at its lower corners and leaves the composer unchanged", () => {
	assert.match(CLIENT, /function decorateQueueJoin\(panel, dock\)/);
	assert.match(CLIENT, /data-rdsh-queue-join/);
	assert.match(CLIENT, /panel\.style\.removeProperty\("clip-path"\)/);
	assert.match(CLIENT, /queueRect\.bottom - cardRect\.top/);
	assert.match(CLIENT, /borderTopLeftRadius/);
	assert.match(CLIENT, /borderTopRightRadius/);
	assert.match(CLIENT, /addCorner\("left"/);
	assert.match(CLIENT, /addCorner\("right"/);
	assert.match(CLIENT, /decorateQueueJoin\(panel, dock\);/);
	// Main #37's measured seam is still what attaches the queue to the card.
	assert.match(CLIENT, /dock\.style\.marginBottom = \(-\(gapPx \+ 1\)\) \+ "px";/, "the measured seam was dropped");
	assert.match(CLIENT, /\[data-rdsh-queue-dock\] \{[^}]*z-index: 1 !important;/, "the join layer must paint above the composer");
	assert.match(CLIENT, /\[data-rdsh-queue-dock\] \{[^}]*overflow: visible !important;/, "the join cannot paint outside the dock");
	assert.match(CLIENT, /\[data-rdsh-queue-panel\] \{[^}]*border-bottom-left-radius: 0 !important;[^}]*border-bottom-right-radius: 0 !important;/);
	assert.match(CLIENT, /\.rdsh-mux-queue-preview \{[^}]*position: fixed;[^}]*max-height: min\(50vh, 360px\);[^}]*overflow-y: auto;/);
	assert.match(CLIENT, /\.rdsh-mux-queue-menu \{[^}]*position: fixed;/);
	const joinStart = CLIENT.indexOf("function decorateQueueJoin(panel, dock) {");
	const joinEnd = CLIENT.indexOf("\n\n    function decorateQueueDock()", joinStart);
	assert.ok(joinStart >= 0 && joinEnd > joinStart, "queue join helper is missing");
	const joinSource = CLIENT.slice(joinStart, joinEnd);
	assert.match(joinSource, /if \(!phone\(\)/, "the queue join is not mode-gated");
	assert.match(joinSource, /dock\.append\(bridge\)/, "the bridge is never attached");
	assert.doesNotMatch(joinSource, /card\.style\.|card\.setAttribute\(/, "the composer must not be mutated");
	const clearStart = CLIENT.indexOf("function clearQueueDockHooks()");
	const clearEnd = CLIENT.indexOf("\n\n", clearStart);
	assert.match(CLIENT.slice(clearStart, clearEnd), /data-rdsh-queue-join/, "teardown keeps the bridge");
	// The composer's own top corners stay untouched; #37's corner-zeroing rule
	// contradicted the PR47 contract and was removed in the integration.
	assert.doesNotMatch(CLIENT, /\[data-rdsh-queue-dock\]:has\(li\)[^{]*\{[^}]*border-top-left-radius:\s*0/, "the composer radius is still zeroed");
	const rules = cssRules(cssTemplate("CSS_PHONE"));
	for (const head of ["[data-rdsh-queue-dock]", "[data-rdsh-queue-panel]", "[data-rdsh-queue-join]", ".rdsh-mux-queue-preview", ".rdsh-mux-queue-menu"]) {
		assert.ok(rules.some((entry) => entry.head === head), `${head} is missing from the mobile sheet`);
	}
});
test("the workspace picker reserves its search band before the first placement", () => {
	const phone = cssTemplate("CSS_PHONE");
	// #39: upstream's Menu reads offsetWidth/offsetHeight in the layout effect
	// of the commit that mounts it, before the plugin can tag the portal. The
	// armed selector (set by the opening click) and the tagged selector must
	// describe the same box, or the first place() and the decorated panel
	// disagree and the menu jumps.
	const menuRule = /html\[data-rdsh-workspace-picking\] \[role="menu"\]\[data-menu-material\],\s*\[data-rdsh-workspace-menu\] \{([^}]*)\}/.exec(phone);
	assert.ok(menuRule, "the picker menu has no pre-tag geometry rule");
	const menuBody = menuRule[1];
	assert.match(menuBody, /--rdsh-workspace-search-block: 44\.5px;/, "the reserved band has no single size");
	assert.match(menuBody, /padding-top: calc\(4px \+ var\(--rdsh-workspace-search-block\)\) !important;/, "the reserved band is not part of the menu box");
	assert.match(menuBody, /max-height: min\(70vh, 520px\) !important;/, "the pre-tag menu is not height-bounded");
	assert.match(menuBody, /overflow: hidden !important;/, "the pre-tag menu does not clip");

	// The list cap is part of the same pre-tag contract; without it a long
	// picker shrinks when the viewport is tagged.
	const viewportRule = /html\[data-rdsh-workspace-picking\] \[role="menu"\]\[data-menu-material\] > div\[aria-hidden="true"\] \+ \[role="presentation"\],\s*\[data-rdsh-workspace-menu\] \[data-rdsh-workspace-viewport\] \{([^}]*)\}/.exec(phone);
	assert.ok(viewportRule, "the list viewport has no pre-tag cap");
	assert.match(viewportRule[1], /max-height: min\(40vh, 320px\) !important;/, "the pre-tag list is not capped");
	assert.match(viewportRule[1], /overflow-y: auto !important;/, "the pre-tag list is not the scroller");

	// The row is absolutely positioned inside that band, so inserting it adds
	// neither height nor width to the box upstream measured. A width here
	// would re-place the panel horizontally on decoration.
	const rowRule = /\.rdsh-mux-workspace-search \{([^}]*)\}/.exec(phone);
	assert.ok(rowRule, "the search row has no style");
	const rowBody = rowRule[1];
	assert.match(rowBody, /position: absolute; top: 4px; left: 4px; right: 4px;/, "the search row still takes flow space");
	assert.match(rowBody, /height: var\(--rdsh-workspace-search-block, 44\.5px\);/, "the row does not fill exactly the reserved band");
	assert.doesNotMatch(rowBody, /(?:^|[;\s])width:/, "the search row changes the menu width");
	assert.match(phone, /\.rdsh-mux-workspace-search input \{[^}]*width: 100%; min-width: 0;/, "the input's intrinsic width can widen the menu");
	assert.match(phone, /\.rdsh-mux-workspace-search input \{[^}]*font-size: 16px;/, "the search field can trigger iOS zoom");

	assert.match(phone, /\[data-rdsh-workspace-menu\] \[data-rdsh-workspace-hidden\] \{ display: none !important; \}/, "filtered rows are still visible");
	assert.match(phone, /\.rdsh-mux-workspace-empty \{[^}]*font-size: 13px;/, "the no-match row has no style");

	const rules = cssRules(phone);
	assert.ok(rules.some((entry) => entry.head.includes("[data-rdsh-workspace-menu]")), "the tagged menu geometry is missing from the mobile sheet");
	assert.ok(rules.some((entry) => entry.head.includes("[data-rdsh-workspace-menu] [data-rdsh-workspace-viewport]")), "the tagged viewport rules are missing from the mobile sheet");
	for (const head of [".rdsh-mux-workspace-search", ".rdsh-mux-workspace-empty"]) {
		assert.ok(rules.some((entry) => entry.head === head), `${head} is missing from the mobile sheet`);
	}
	const device = CLIENT.slice(CLIENT.indexOf("const CSS_DEVICE"), CLIENT.indexOf("const CSS_PHONE"));
	assert.doesNotMatch(device, /data-rdsh-workspace-picking/, "the pre-tag reservation leaked into the device sheet");
});
