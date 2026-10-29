/**
 * Device-mode decision: the classifier table and the inline bootstrap.
 *
 * One shared index document reaches every browser, so the mode is decided in
 * the document itself. These tests pin three things: the classifier's table
 * (including the cases width-based detection used to get wrong), that the
 * emitted script is one safe self-contained copy of that same function, and
 * that the same bytes decide differently in different browsers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { MANIFEST_FILE, MODE_ATTRIBUTE, MODE_GLOBAL, classifyDevice, earlyModeScript } from "../lib/device-mode.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_LEGACY = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
/** iPadOS 13+ asks for the desktop site by default: byte-identical to a Mac. */
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
/** A tablet UA keeps "Android" and drops "Mobile". */
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CROS = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** A navigator-shaped fixture; every field is optional on purpose. */
const nav = (fields) => ({ maxTouchPoints: 0, ...fields });

const CASES = [
	["android phone", nav({ userAgent: ANDROID_PHONE, platform: "Linux armv8l", maxTouchPoints: 5 }), "mobile"],
	["android tablet", nav({ userAgent: ANDROID_TABLET, platform: "Linux armv8l", maxTouchPoints: 5 }), "mobile"],
	["android phone in landscape", nav({ userAgent: ANDROID_PHONE, platform: "Linux armv8l", maxTouchPoints: 5 }), "mobile"],
	["iphone", nav({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }), "mobile"],
	["ipod", nav({ userAgent: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1", platform: "iPod", maxTouchPoints: 5 }), "mobile"],
	["ipad legacy ua", nav({ userAgent: IPAD_LEGACY, platform: "iPad", maxTouchPoints: 5 }), "mobile"],
	["ipad desktop ua + touch", nav({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 5 }), "mobile"],
	["ipad desktop ua without touch", nav({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 0 }), "desktop"],
	// A desktop-site UA on an Apple device still carries the platform string
	// sometimes; that is a positive device signal on its own.
	["iphone desktop-site ua", nav({ userAgent: MAC, platform: "iPhone", maxTouchPoints: 0 }), "mobile"],
	["ipad desktop-site ua", nav({ userAgent: MAC, platform: "iPad", maxTouchPoints: 0 }), "mobile"],
	["mac", nav({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 }), "desktop"],
	["windows touch laptop", nav({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 10 }), "desktop"],
	["windows mouse", nav({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 0 }), "desktop"],
	["linux touch laptop", nav({ userAgent: LINUX, platform: "Linux x86_64", maxTouchPoints: 10 }), "desktop"],
	// The touch-only guess is deliberately not taken: with no Android token and
	// no Android hint, a touch Linux machine is still a PC.
	["linux touch without any android signal", nav({ userAgent: LINUX, platform: "Linux x86_64", maxTouchPoints: 10, userAgentData: { mobile: false, platform: "Linux" } }), "desktop"],
	["chromeos", nav({ userAgent: CROS, platform: "Linux x86_64", maxTouchPoints: 0 }), "desktop"],
	// Each client hint branch is exercised alone, on a UA that would otherwise
	// be a desktop, so removing one branch cannot be masked by the other.
	["ua-ch mobile flag only", nav({ userAgent: LINUX, platform: "", userAgentData: { mobile: true, platform: "Linux" } }), "mobile"],
	["ua-ch android platform hint only", nav({ userAgent: LINUX, platform: "", userAgentData: { mobile: false, platform: "Android" } }), "mobile"],
	["ua-ch both hints", nav({ userAgent: LINUX, platform: "", userAgentData: { mobile: true, platform: "Android" } }), "mobile"],
	["ua-ch android reduced ua", nav({ userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", platform: "Linux armv8l", userAgentData: { mobile: true, platform: "Android" } }), "mobile"],
	["ua-ch mobile:false is not a desktop signal", nav({ userAgent: ANDROID_TABLET, userAgentData: { mobile: false, platform: "Android" } }), "mobile"],
	["ua-ch windows stays desktop", nav({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 10, userAgentData: { mobile: false, platform: "Windows" } }), "desktop"],
	["unknown agent", nav({ userAgent: "curl/8.5.0", platform: "" }), "desktop"],
	["empty agent", nav({ userAgent: "", platform: "" }), "desktop"],
];

test("the classifier table covers phones, tablets, PCs and the mac-like ipad", () => {
	for (const [label, fixture, expected] of CASES) {
		assert.equal(classifyDevice(fixture), expected, label);
	}
});

test("missing, null or coerced navigator fields fail closed", () => {
	// A throwing getter is not covered here on purpose: this function is called
	// by the inline script, whose catch turns that into "desktop" (pinned in
	// "the inline script fails closed when the document or the globals
	// misbehave"). Wrapping every read would only hide a broken navigator.
	for (const value of [undefined, null, 42, "navigator", [], {}]) {
		assert.equal(classifyDevice(value), "desktop", `classifyDevice(${String(value)})`);
	}
	// Coerced values are ignored rather than trusted: a spoofed or broken field
	// must not select the phone surface.
	assert.equal(classifyDevice({ userAgent: 42, platform: null, maxTouchPoints: "5" }), "desktop");
	assert.equal(classifyDevice({ userAgent: WINDOWS, platform: "MacIntel", maxTouchPoints: "5" }), "desktop",
		"a string touch count is not a number");
});

test("width, pointer kind and orientation are never consulted", () => {
	const source = classifyDevice.toString();
	for (const forbidden of ["innerWidth", "outerWidth", "matchMedia", "clientWidth", "screen", "coarse", "hover", "orientation"]) {
		assert.ok(!source.includes(forbidden), `the classifier must not read ${forbidden}`);
	}
	// The same fixture answers the same regardless of any window shape: there
	// is no window-shaped input at all.
	assert.equal(classifyDevice(nav({ userAgent: ANDROID_PHONE })), "mobile");
	assert.equal(classifyDevice(nav({ userAgent: WINDOWS })), "desktop");
});

/** The script's code, with the element wrapper removed. */
function scriptBody(script) {
	assert.match(script, /^<script>[\s\S]*<\/script>$/,
		"one script element");
	return script.slice("<script>".length, -"</script>".length);
}

/** A root element that records what the script writes on it. */
function rootElement({ write = "ok" } = {}) {
	const attributes = new Map();
	return {
		attributes,
		setAttribute(name, value) {
			if (write === "throw") throw new Error("blocked");
			attributes.set(name, String(value));
		},
	};
}

/** A fake document: head records appended nodes, createElement records attrs. */
function fakeDocument({ root = rootElement(), head = "element", createElement = "ok" } = {}) {
	const appended = [];
	return {
		document: {
			documentElement: root,
			head: head === "element" ? { appendChild: (node) => appended.push(node) } : null,
			createElement(tag) {
				if (createElement === "throw") throw new Error("blocked");
				const attributes = new Map();
				return { tag, attributes, setAttribute: (name, value) => attributes.set(name, String(value)) };
			},
		},
		appended,
	};
}

/**
 * Run the emitted script against a fake browser.
 *
 * @param {string} script - the element text.
 * @param {object} [options] - navigator, document behaviour.
 * @returns {{attributes: Map<string, string>, global: unknown, appended: object[]}} what it did.
 */
function boot(script, { navigator: browserNavigator = nav({ userAgent: ANDROID_PHONE }), root, head, createElement } = {}) {
	const { document, appended } = fakeDocument({ root, head, createElement });
	const sandbox = { navigator: browserNavigator, document };
	runInNewContext(scriptBody(script), sandbox, { filename: "early-mode.js" });
	return {
		attributes: document.documentElement === null ? new Map() : document.documentElement.attributes,
		global: sandbox[MODE_GLOBAL],
		appended,
	};
}

/** The meta/link names a mobile boot adds, in order. */
const MOBILE_HEAD = [
	["meta", "name", "mobile-web-app-capable"],
	["meta", "name", "apple-mobile-web-app-status-bar-style"],
	["meta", "name", "format-detection"],
	["link", "rel", "apple-touch-icon"],
	["link", "rel", "manifest"],
];

/** Assert the four home-screen nodes, in order, with their values. */
function assertMobileHead(result, label) {
	assert.equal(result.appended.length, MOBILE_HEAD.length, `${label}: node count`);
	MOBILE_HEAD.forEach(([tag, key, expected], index) => {
		const node = result.appended[index];
		assert.equal(node.tag, tag, `${label}: node ${index} tag`);
		assert.equal(node.attributes.get(key), expected, `${label}: node ${index} ${key}`);
	});
	assert.equal(result.appended[0].attributes.get("content"), "yes");
	assert.equal(result.appended[1].attributes.get("content"), "default");
	assert.equal(result.appended[2].attributes.get("content"), "telephone=no");
	assert.equal(result.appended[3].attributes.get("href"), "pwa/apple-touch-icon.png");
	assert.equal(result.appended[4].attributes.get("href"), MANIFEST_FILE,
		"the plugin manifest is linked after the icons");
}

test("the inline script is one self-contained copy of the classifier", () => {
	const script = earlyModeScript();
	const body = scriptBody(script);
	assert.ok(body.includes("MacIntel"), "the classifier body is embedded");
	assert.equal((body.match(/function classifyDevice/g) ?? []).length, 1, "exactly one definition");
	assert.equal((body.match(/MacIntel/g) ?? []).length, 1, "no second copy of the heuristic");
	assert.ok(body.includes(MODE_ATTRIBUTE), "the attribute name travels");
	assert.ok(body.includes(`globalThis.${MODE_GLOBAL}=`), "the canonical global is published");
	assert.ok(body.includes("mobile-web-app-capable"), "the home-screen metadata travels");
	// Valid JavaScript on its own: this is what the browser will parse.
	assert.doesNotThrow(() => new Function(body));
	// The configured status bar style is carried as data.
	assert.ok(earlyModeScript("default").includes('"default"'), "the configured style travels");
	assert.ok(!earlyModeScript('"></script><script>alert(1)').includes("alert(1)</script>"),
		"the value cannot close the element it lands in");
});

test("the inline script cannot terminate its own element", () => {
	const script = earlyModeScript();
	assert.equal((script.match(/<script/gi) ?? []).length, 1);
	assert.equal((script.match(/<\/script/gi) ?? []).length, 1);
	assert.ok(script.endsWith("</script>"), "the only closing tag is the element's own");
	const body = scriptBody(script);
	assert.ok(!body.includes("<"), "no raw less-than reaches the script body");
	assert.ok(!body.includes("<!--"), "no comment opener can hide the rest");
	// And the guard that keeps a future edit from breaking the document.
	assert.ok(!/<\/script|<!--/i.test(classifyDevice.toString()), "the classifier source stays inline-safe");
});

test("a desktop browser gets the global and no document write at all", () => {
	const script = earlyModeScript();
	const desktops = [
		["windows touch", nav({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 10 })],
		["windows mouse", nav({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 0 })],
		["mac", nav({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 })],
		["linux touch", nav({ userAgent: LINUX, platform: "Linux x86_64", maxTouchPoints: 10 })],
		["unknown", nav({ userAgent: "curl/8.5.0", platform: "" })],
	];
	for (const [label, fixture] of desktops) {
		const result = boot(script, { navigator: fixture });
		assert.equal(result.global, "desktop", `${label}: global`);
		assert.equal(result.attributes.size, 0, `${label}: the html element is untouched`);
		assert.equal(result.appended.length, 0, `${label}: the head is untouched`);
	}
});

test("a mobile browser gets the home-screen metadata and the mode attribute", () => {
	const script = earlyModeScript();
	const phones = [
		["iphone", nav({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 })],
		["android phone", nav({ userAgent: ANDROID_PHONE, platform: "Linux armv8l", maxTouchPoints: 5 })],
		["android tablet", nav({ userAgent: ANDROID_TABLET, platform: "Linux armv8l", maxTouchPoints: 5 })],
		["ipad desktop ua", nav({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 5 })],
	];
	for (const [label, fixture] of phones) {
		const result = boot(script, { navigator: fixture });
		assert.equal(result.global, "mobile", `${label}: global`);
		assert.equal(result.attributes.get(MODE_ATTRIBUTE), "mobile", `${label}: attribute`);
		assertMobileHead(result, label);
	}
});

test("the same document decides differently in different browsers", () => {
	// One string, two browsers: this is what a shared (and cached) shell does.
	const script = earlyModeScript();
	const phone = boot(script, { navigator: nav({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }) });
	const laptop = boot(script, { navigator: nav({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 10 }) });
	const ipad = boot(script, { navigator: nav({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 5 }) });
	assert.equal(phone.global, "mobile");
	assertMobileHead(phone, "phone");
	assert.equal(laptop.global, "desktop", "a windows touch laptop stays desktop");
	assert.equal(laptop.attributes.size, 0);
	assert.equal(laptop.appended.length, 0);
	assert.equal(ipad.global, "mobile");
	assertMobileHead(ipad, "ipad");
	// Every fixture: the global is the decision, and only a mobile browser is
	// allowed to touch the document.
	for (const [label, fixture, expected] of CASES) {
		const result = boot(script, { navigator: fixture });
		assert.equal(result.global, expected, `${label}: global`);
		if (expected === "mobile") {
			assert.equal(result.attributes.get(MODE_ATTRIBUTE), "mobile", `${label}: attribute`);
			assertMobileHead(result, label);
		} else {
			assert.equal(result.attributes.size, 0, `${label}: no attribute on desktop`);
			assert.equal(result.appended.length, 0, `${label}: no head write on desktop`);
		}
	}
});

test("the inline script fails closed when the document or the globals misbehave", () => {
	// No documentElement: the global still carries the decision, and the head
	// metadata still applies (it does not need the root element).
	const noRoot = boot(earlyModeScript(), { root: null });
	assert.equal(noRoot.global, "mobile");
	assert.equal(noRoot.attributes.size, 0, "no root element to tag");
	assertMobileHead(noRoot, "no documentElement");

	// A blocked attribute write keeps the global and drops the metadata.
	const blockedWrite = boot(earlyModeScript(), { root: rootElement({ write: "throw" }) });
	assert.equal(blockedWrite.global, "mobile");
	assert.equal(blockedWrite.appended.length, 0);

	// A broken createElement likewise: nothing half-applied.
	const blockedCreate = boot(earlyModeScript(), { createElement: "throw" });
	assert.equal(blockedCreate.global, "mobile");
	assert.equal(blockedCreate.appended.length, 0);

	// A throwing navigator falls back to desktop and writes nothing.
	const hostile = boot(earlyModeScript(), {
		navigator: { get userAgent() { throw new Error("blocked"); }, maxTouchPoints: 0 },
	});
	assert.equal(hostile.global, "desktop");
	assert.equal(hostile.attributes.size, 0);
	assert.equal(hostile.appended.length, 0);

	// No navigator at all: upstream layout, never a crash.
	const { document } = fakeDocument();
	const sandbox = { document };
	assert.doesNotThrow(() => runInNewContext(scriptBody(earlyModeScript()), sandbox));
	assert.equal(sandbox[MODE_GLOBAL], "desktop");
	assert.equal(document.documentElement.attributes.size, 0);
});
