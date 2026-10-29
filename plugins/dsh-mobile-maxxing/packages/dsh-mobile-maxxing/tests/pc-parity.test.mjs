/**
 * Static checks for the device-mode / desktop split.
 *
 * The contract is the host bootstrap value `__RDSH_DEVICE_MODE__`, consumed
 * by client.js. A narrow desktop window stays desktop; a wide phone/tablet
 * stays mobile. Width is geometry only, and the mobile stylesheet is enabled
 * by mode rather than by a max-width wrapper. These checks pin the decision
 * points and add a few negative controls against the old width rule.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const HOST = readFileSync(new URL("../notify/host.js", import.meta.url), "utf8");

/** One top-level helper, from its declaration to its closing brace. */
function functionBody(name) {
	const start = CLIENT.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	const close = CLIENT.indexOf("\n    }\n", start);
	return CLIENT.slice(start, close === -1 ? undefined : close);
}

/** The lines of one `const NAME = [ ... ];` array literal. */
function arrayLiteral(name) {
	const start = CLIENT.indexOf(`const ${name} = [`);
	assert.notEqual(start, -1, `${name} exists`);
	const end = CLIENT.indexOf("];", start);
	return CLIENT.slice(start, end === -1 ? undefined : end);
}


test("the retired device-turn checkbox stays out of mobile settings", () => {
	assert.doesNotMatch(functionBody("MobileSection"), /mux\.notify\.deviceTurns|writeNotifyDeviceTurns/);
});

test("the update action has a labelled, touch-sized control", () => {
	const body = functionBody("UpdateSettingsSection");
	assert.match(body, /className: "rdsh-update-launch"/);
	assert.match(body, /t\("pwa.action.check"\)/);
	assert.match(CLIENT, /\.rdsh-update-launch \{[^}]*min-height: 48px/);
});

test("the update dialog keeps its actions reachable on short screens", () => {
	assert.match(CLIENT, /\.rdsh-update-dialog \{[^}]*max-height: 100%; overflow-y: auto;/);
});

test("hiding follows the device mode, not the window width", () => {
	const body = functionBody("applyHideList");
	assert.match(body, /const hideOnThisDevice = !disabled && phone\(\);/, "the hide decision ignores the mode");
	assert.match(body, /if \(hideOnThisDevice && shouldHide\(label, labels\)\)/, "buttons are hidden without asking the mode");
	assert.doesNotMatch(body, /hidden\.add\(/, "the deleted hidden-label report is back");
	assert.doesNotMatch(body, /tab\.pwa|tab\.input/, "the removed tab merge is back");
	assert.doesNotMatch(body, /!disabled && narrow\(\)/, "the hide list is width-gated again");
});

test("the hide-settings attribute follows the mobile mode", () => {
	assert.match(CLIENT, /const onPhone = phone\(\);/, "decorateFast does not ask the device");
	assert.match(
		CLIENT,
		/document\.documentElement\.toggleAttribute\("data-rdsh-hide-settings", onPhone && !hideListDisabled\);/,
		"the settings-hiding attribute is not mode-gated",
	);
	assert.match(CLIENT, /html\[data-rdsh-hide-settings\] \[data-rdsh-setting-hidden\]/);
});

test("label rewrites and the plus hijack follow phone()", () => {
	assert.match(functionBody("phone"), /return DEVICE_MODE === "mobile";/, "phone() is not the bootstrapped mode");
	const sidebar = functionBody("decorateSidebarSettingsRow");
	assert.match(sidebar, /if \(!phone\(\)\) \{/, "the sidebar Settings row is not mode-gated");
	assert.match(sidebar, /removeAttribute\("data-rdsh-more-row"\)/, "leaving the mobile mode leaves the account row hidden");
	const composer = functionBody("decorateComposer");
	assert.match(composer, /if \(!phone\(\)\) \{/, "the composer decoration is not mode-gated");
	assert.match(composer, /clearComposerHooks\(\)/, "leaving the mobile mode does not restore the stock composer");
	assert.match(functionBody("onMouseDownCapture"), /if \(!phone\(\)\) return;/, "the mousedown guard is not mode-gated");
	assert.match(functionBody("onClickCapture"), /addButtonOf\(target\) !== null && phone\(\)/, "the + hijack is not mode-gated");
});

test("the hide list no longer guesses native open-in-app labels", () => {
	const defaults = arrayLiteral("HIDE_DEFAULT");
	for (const label of [
		"More actions",
		"Feedback",
		"Sign in",
		"Keyboard shortcuts",
		"Desktop notifications",
		"Show coding view",
		"Built-in plugins",
	]) {
		assert.equal(defaults.includes(`"${label}"`), true, `${label} is missing from the hide list`);
	}
	assert.match(defaults, /"Open configuration file"/, "the merged-build addition was dropped");
	// #33: the native split button is matched structurally, not by its visible
	// wording (the host names the app itself, and the prominent half has no
	// aria-label). A label entry would also risk hiding a browser preview
	// control that happens to use the same text.
	for (const label of ["Open in Files", "More ways to open", "Open in Text Editor", "Open in editor", "Open in Explorer", "Reveal in Finder"]) {
		assert.equal(defaults.includes(`"${label}"`), false, `${label} still relies on the label list`);
	}
	assert.match(CLIENT, /const OPEN_TARGET_SELECTOR = "\[data-open-target\]";/, "the structural open-target selector is missing");
});


test("the mobile tab inlines the other sections by mode, not by width", () => {
	const body = functionBody("MobileSection");
	assert.match(body, /const onPhone = s\.phone === true;/, "the section still keys off the device");
	assert.match(body, /h\(InputSection\)/, "InputSection is not available in mobile mode");
	assert.match(
		body,
		/typeof globalThis\.__RDSH_PWA_SETTINGS_SECTION__ === "function"/,
		"the PWA section is not inlined in mobile mode",
	);
	assert.doesNotMatch(body, /s\.narrow && onPhone/, "the inline decision is still width-gated");
	// One Settings tab: the separate App/Input registrations are gone, and the
	// single mobile-ux row keeps the label key.
	const registrations = [...CLIENT.matchAll(/name: "settings\.section",\s*\n\s*id: "([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(registrations, ["mobile-ux", "mobile-update"], "the mobile and update tabs must be registered");
	assert.doesNotMatch(CLIENT, /id: "pwa",/, "the App tab is back");
	assert.doesNotMatch(CLIENT, /id: "mobile-ux-input",/, "the Input tab is back");
});

test("the mobile-only settings cards follow the device mode", () => {
	const body = functionBody("MobileSection");
	assert.match(body, /onPhone \? h\(LocalLanguageSection\) : null/, "language must remain mobile-only");
	assert.doesNotMatch(body, /mux\.section\.plusNote/, "the unrelated attachment explanation is back");
	// The hidden-controls and diagnostics cards were removed by the user.
	assert.doesNotMatch(body, /t\("mux\.hidden\.title"\)/, "the removed hidden-controls card is back");
	assert.doesNotMatch(body, /mux\.diag\./, "the removed diagnostics cards are back");
});

test("a desktop is a hard no-op, opt-ins included", () => {
	// The user's contract is "a PC is not changed at all": the only desktop
	// path is the early no-op return, so no part, slot, style, listener or
	// storage read happens and a saved opt-in cannot wake anything.
	const gate = 'if (DEVICE_MODE !== "mobile") return { apply() {} };';
	const at = CLIENT.indexOf(gate);
	assert.notEqual(at, -1, "the desktop no-op gate is missing");
	assert.ok(
		CLIENT.indexOf("const DEVICE_MODE = readDeviceMode();") < at,
		"the gate runs before the mode is resolved",
	);
	// Nothing that builds or touches a page may appear before the gate.
	for (const call of ['require("react")', "document.createElement", "document.head", "document.addEventListener", "localStorage.getItem", "fetch("]) {
		const first = CLIENT.indexOf(call);
		assert.ok(first === -1 || first > at, `${call} runs before the desktop gate`);
	}
	// The host default and any previously saved opt-in stay unchanged; only
	// the retired settings control is gone.
	assert.match(HOST, /onlyMobileTurns: true/, "the host default must stay mobile-only");
	assert.match(functionBody("readNotifyDeviceTurns"), /NOTIFY_DEVICE_TURNS_KEY/);
});

test("the bootstrap is the only mode source and width never selects it", () => {
	// Client consumes the canonical string. It must not rebuild the decision
	// from UA, touch points, pointer media or the window width.
	assert.match(CLIENT, /globalThis\.__RDSH_DEVICE_MODE__/, "the canonical bootstrap global is not read");
	assert.match(CLIENT, /data-rdsh-device-mode/, "the canonical HTML attribute is not used");
	assert.doesNotMatch(CLIENT, /userAgentData|pointer:\s*coarse|hover:\s*none/, "client re-classifies the device");
	assert.doesNotMatch(CLIENT, /if \(!narrow\(\)\)[\s\S]{0,80}clearPhoneHooks/, "a width crossing still tears the mobile surface down");
	assert.match(CLIENT, /const applyWidthBoundary = \(\) => \{\s*\n\s*emit\(\{ narrow: narrow\(\) \}\);/, "syncWidth does not stay geometry-only");
});

test("the mobile stylesheet is enabled by mode, not by a max-width wrapper", () => {
	assert.doesNotMatch(CLIENT, /phoneStyles\s*=/, "the max-width wrapper still exists");
	assert.doesNotMatch(CLIENT, /@media \(max-width: 767px\)/, "a hand-written 767px feature query exists");
	assert.match(CLIENT, /setAttribute\("data-rdsh-mux-style", "phone"\)/, "the mobile stylesheet is not a separate mode-scoped style");
	assert.match(CLIENT, /if \(phone\(\)\) \{\s*\n\s*phoneStyle = document\.createElement\("style"\)/, "the mobile stylesheet is not mode-gated");
	// The PWA install/toast geometry follows the same attribute.
	assert.match(CLIENT, /html\[data-rdsh-device-mode="mobile"\] \.dsh-mobile-maxxing-toasts/, "the PWA mobile CSS is not mode-scoped");
	// A genuine small-viewport sizing tweak may remain.
	assert.match(CLIENT, /@media \(max-width: 380px\)/, "the existing small-phone sizing rule was lost");
	// The install card follows the device, so a wide tablet still offers it.
	assert.match(CLIENT, /if \(state\.mode !== "mobile"\) return false;/, "the install card is not mobile-mode gated");
	assert.match(CLIENT, /mode: DEVICE_MODE,/, "the PWA store does not expose the bootstrapped mode");
});

/** One `const NAME = \`...\`;` stylesheet block, with escapes respected. */
function cssBlock(name) {
	const marker = `const ${name} = \``;
	const start = CLIENT.indexOf(marker);
	if (start === -1) return null;
	const open = start + marker.length;
	let index = open;
	while (index < CLIENT.length) {
		if (CLIENT[index] === "\\") {
			index += 2;
			continue;
		}
		if (CLIENT[index] === "`") break;
		index += 1;
	}
	return CLIENT.slice(open, index);
}

/** Brace-aware rules: prelude, ancestors, and the exact slice. */
function cssRules(css) {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	const stack = [];
	let buffer = "";
	for (let index = 0; index < clean.length; index += 1) {
		const character = clean[index];
		if (character === "{") {
			const prelude = buffer.trim();
			const record = { prelude, parents: stack.map((entry) => entry.prelude), start: index - buffer.length + buffer.lastIndexOf(prelude), close: null };
			rules.push(record);
			stack.push(record);
			buffer = "";
		} else if (character === "}") {
			const record = stack.pop();
			if (record !== undefined) record.close = index;
			buffer = "";
		} else {
			buffer += character;
		}
	}
	return { css: clean, rules };
}

test("preview feature rules live in the mobile stylesheet, never the device sheet", () => {
	const device = cssBlock("CSS_DEVICE");
	const phone = cssBlock("CSS_PHONE");
	assert.ok(device !== null && phone !== null, "the split stylesheets are missing");
	const isOpenTarget = (rule) => rule.prelude.split(",").some((part) => part.trim() === "[data-open-target]");
	const isDiffWrap = (rule) => rule.prelude.includes("[data-review-wrap]")
		&& rule.prelude.includes("[data-diff-line]")
		&& rule.prelude.includes("[data-diff-code]");

	const parsedPhone = cssRules(phone);
	const phoneRules = parsedPhone.rules.filter((rule) => rule.close !== null);
	const openRules = phoneRules.filter(isOpenTarget);
	const wrapRules = phoneRules.filter(isDiffWrap);
	assert.ok(openRules.length > 0, "the native open-target hide rule is missing from CSS_PHONE");
	assert.ok(wrapRules.length > 0, "the guarded diff wrap rule is missing from CSS_PHONE");

	// The exact leak predicate used by the positive assertion. The negative
	// control must trip this, not merely prove that the moved text parses.
	const leaks = (css) => cssRules(css).rules
		.filter((rule) => rule.close !== null)
		.some((rule) => isOpenTarget(rule) || isDiffWrap(rule));
	assert.equal(leaks(device), false, "a mobile feature rule leaked into CSS_DEVICE");

	const openRuleText = parsedPhone.css.slice(openRules[0].start, openRules[0].close + 1);
	const wrapRuleText = parsedPhone.css.slice(wrapRules[0].start, wrapRules[0].close + 1);
	assert.equal(leaks(`${device}\n${openRuleText}`), true, "the negative control did not trip the leak predicate for open-target");
	assert.equal(leaks(`${device}\n${wrapRuleText}`), true, "the negative control did not trip the leak predicate for diff-wrap");
});

test("the route detail's back affordance lives in the mobile stylesheet only", () => {
	const device = cssBlock("CSS_DEVICE");
	const phone = cssBlock("CSS_PHONE");
	assert.ok(device !== null && phone !== null, "the split stylesheets are missing");
	// #61 / #62: the drawer button steps aside on a route detail, the
	// Automation route keeps its scroll area below the button, the task detail
	// keeps the same inset for the replacement, and that replacement is a
	// mobile-only node.
	assert.match(
		phone,
		/html:has\(\[data-rdsh-route-detail\]\) \.rdsh-mux-fab \{ display: none !important; \}/,
		"the drawer button is not retired on a route detail",
	);
	assert.match(
		phone,
		/\[data-rdsh-route-detail="back"\] \{ padding-top: 56px !important; \}/,
		"the task detail has no top inset for the back button",
	);
	assert.match(
		phone,
		/\[data-testid="task-manager-page"\] \{ box-sizing: border-box; padding-top: 56px !important; \}/,
		"the Automation route keeps no clearance below the drawer button",
	);
	assert.ok(phone.includes('[data-testid="task-manager-page"][data-rdsh-route-detail="back"] { padding-top: 0 !important; }'), "the detail still wastes the back button row");
	assert.ok(phone.includes('[data-testid="task-manager-page"][data-rdsh-route-detail="back"] [class*="_detailTabsBar"] {\n    min-height: 48px; height: auto; padding-left: 64px;'), "the detail tabs do not clear the back button");
	assert.match(phone, /\.rdsh-mux-route-back\[data-visible\] \{ display: flex; \}/, "the back button has no visible state");
	// #59: the button sits in the drawer button's corner, so a landscape notch
	// must move it exactly like the FAB.
	assert.match(
		phone,
		/\.rdsh-mux-route-back \{[^}]*left: calc\(env\(safe-area-inset-left, 0px\) \+ 8px\); top: calc\(env\(safe-area-inset-top, 0px\) \+ 8px\);/,
		"the back button still uses the fixed 8px gutter",
	);
	assert.doesNotMatch(device, /data-rdsh-route-detail|rdsh-mux-route-back/, "a route back rule leaked into the device sheet");

	// The node is built in the same mobile-only branch as the drawer button.
	assert.match(
		CLIENT,
		/if \(phone\(\)\) \{\s*installDrawer\(\);[\s\S]{0,400}?installRouteBack\(\);/,
		"the back button is not installed beside the drawer button",
	);
});

test("preview hides native open targets structurally and keeps the hide list conservative", () => {
	assert.match(CLIENT, /const OPEN_TARGET_SELECTOR = "\[data-open-target\]";/, "the structural open-target selector is missing");
	const defaults = arrayLiteral("HIDE_DEFAULT");
	for (const label of ["Open in Files", "More ways to open", "Open in Text Editor", "Open in editor", "Open in Explorer", "Reveal in Finder"]) {
		assert.equal(defaults.includes(`"${label}"`), false, `${label} still relies on the label list`);
	}
	// The wrap rule must stay gated on upstream's own wrap state so an explicit
	// OFF is not overridden by CSS.
	assert.match(CLIENT, /\[data-review-wrap\] \[data-diff-line\][\s\S]{0,400}overflow-wrap: anywhere/, "diff wrapping is not gated on the wrap state");
});
