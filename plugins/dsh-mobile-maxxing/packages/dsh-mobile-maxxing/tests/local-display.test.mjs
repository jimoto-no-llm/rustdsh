/**
 * Device-local display settings: font sizes and UI language.
 *
 * Static contract checks only. The runtime behaviour is covered by the
 * existing desktop-noop recorder (desktop never reaches this code) and by the
 * mobile Settings section tests; this file pins the two new controls to
 * localStorage, the public read APIs, and the absence of shared writers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const COPY = readFileSync(new URL("../lib/copy.js", import.meta.url), "utf8");
const HOST = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function block(start, end) {
	const at = CLIENT.indexOf(start);
	assert.notEqual(at, -1, `${start} exists`);
	const close = CLIENT.indexOf(end, at);
	assert.notEqual(close, -1, `${end} follows ${start}`);
	return CLIENT.slice(at, close);
}

test("local display copy exists in both shipped packs", () => {
	const keys = [
		"localDisplay.resetFonts",
		"localDisplay.title",
		"localDisplay.desc",
		"localDisplay.text",
		"localDisplay.code",
		"localDisplay.terminal",
		"localDisplay.language",
		"localDisplay.language.system",
		"localDisplay.language.note",
		"localDisplay.note",
		"localDisplay.unavailable",
		"localDisplay.reason.themeMissing",
		"localDisplay.reason.themeShape",
		"localDisplay.reason.localeMissing",
		"localDisplay.reason.localeShape",
		"localDisplay.reason.noLocales",
	];
	const en = COPY.slice(COPY.indexOf("en: {"), COPY.indexOf("ja: {"));
	const ja = COPY.slice(COPY.indexOf("ja: {"));
	for (const key of keys) {
		assert.match(en, new RegExp(`"${key.replace(".", "\\.")}":\\s*"`), `${key} missing from en`);
		assert.match(ja, new RegExp(`"${key.replace(".", "\\.")}":\\s*"`), `${key} missing from ja`);
	}
});

test("the Mobile section owns the independent LocalDisplaySettingsSection", () => {
	const body = block("function MobileSection(", "function InputSection(");
	assert.match(body, /onPhone \? h\("details"[\s\S]*h\(LocalDisplaySettingsSection\)/);
	assert.match(body, /onPhone \? h\("details"[\s\S]*h\(InputSection\)/,
		"the existing Input section was displaced");
	assert.match(CLIENT, /function LocalDisplaySettingsSection\(\)/, "the independent component is gone");
	assert.match(CLIENT, /function setLocalDisplayFont\(role, delta\)/);
	assert.match(CLIENT, /function setLocalDisplayLanguage\(id\)/);
});

test("display choices are device-local and use only localStorage", () => {
	const body = block("function readLocalDisplaySettings()", "function clampLocalFont(");
	assert.match(body, /LOCAL_DISPLAY_KEY/);
	assert.match(body, /localStorage\.getItem/);
	assert.match(body, /JSON\.parse/);
	assert.match(CLIENT, /const LOCAL_DISPLAY_KEY = "rdsh-mobile-ux:local-display";/);
	const codeOnly = CLIENT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.doesNotMatch(codeOnly, /ctx\.settings|configForms|api\.remote|dsh-api-remotes/,
		"a shared settings/remote API was introduced");
});

test("font sizes use the published theme variables and exact roles", () => {
	for (const [role, variable] of [
		["text", "--dsh-content-font-size"],
		["code", "--dsh-code-font-size"],
		["terminal", "--dsh-terminal-font-size"],
	]) {
		assert.match(CLIENT, new RegExp(`\\b${role}: \\{ min: \\d+, max: \\d+, default: \\d+, variable: "${variable}" \\}`));
	}
	const body = block("function attachLocalDisplay(ctx) {", "function localeOptions(");
	assert.match(body, /theme\.getTheme\(\)|themeService\?\.getTheme\(\)/);
	assert.match(body, /locale\.getSnapshot\(\)|localeService\?\.getSnapshot\(\)/);
	assert.match(body, /themeService\.snapshot = hostTheme/, "the Host theme is not restored");
	assert.match(body, /localeService\.snapshot = hostLocale/, "the Host locale is not restored");
	assert.doesNotMatch(body, /revision\s*\+\s*1000/, "a projection fabricated a revision upstream row stores would adopt");
	assert.doesNotMatch(body, /themeEpoch|localeEpoch/, "an unused projection epoch survived");
	assert.doesNotMatch(body, /\.setFontSize\(|\.setLocale\(/, "a shared writer is called");
	// A Host active change (authoritative, silent or catalog fallback) must
	// move the restored document language; an unchanged Host keeps the boot one.
	assert.match(body, /restoredDocumentLang/, "the document language restore ignores Host changes");
});

test("catalog publishes ride the public LocaleFace subscription, not locale/change alone (#80)", () => {
	const body = block("function attachLocalDisplay(ctx) {", "function localeOptions(");
	// LocaleRuntime.publish emits locale/change only for an active switch;
	// addLanguage/removeLanguage reach public subscribers only.
	assert.match(body, /localeService\.subscribe\(/, "the language catalog is not subscribed");
	assert.match(body, /LOCAL_DISPLAY_PROJECTION/, "the device projection carries no identity marker");
	assert.match(body, /applyingLocale/, "the local notify can re-enter applyLocale");
	assert.match(body, /localDisplayStoredLanguage/, "the stored device choice is not remembered separately");
	assert.doesNotMatch(body, /removeLanguage\(/, "the mobile package unregisters an external language");
	// A Host switch to the projected language emits no locale/change (`adopt`
	// returns early), so the runtime's durable resolver is read instead. It is
	// read-only and has an explicit fallback for runtimes without it.
	assert.match(body, /typeof localeService\.resolveActive !== "function"/, "the resolver has no shape guard");
	assert.match(body, /localeService\.resolveActive\(\)/, "the Host active is never re-read from the runtime");
	assert.match(body, /refreshHostActive/, "a silent Host switch is not folded into the baseline");
});

test("the locale projection refreshes revision-identity readers without inflating the Host revision (#80)", () => {
	const body = block("function attachLocalDisplay(ctx) {", "function localeOptions(");
	// The renderer's t seat cache, the Settings section ledger and the Plugins
	// ledgers compare getSnapshot().revision by identity: object identity alone
	// leaves their cached English copy. The projection therefore carries a
	// local revision token whose numeric value is the Host revision.
	assert.match(body, /LOCAL_DISPLAY_REVISION/, "the local revision token is not marked");
	assert.match(body, /const localLocaleRevision = \(revision\) => \{/, "the local revision token is missing");
	assert.match(body, /Object\(revision\)/, "the token does not preserve the Host numeric value");
	assert.match(body, /revision: localLocaleRevision\(hostLocale\.revision\)/, "the projection does not carry the token");
	assert.match(body, /Number\(projectedLocale\.revision\) === Number\(hostLocale\.revision\)/,
		"an unchanged projection is not reused");
	assert.match(body, /SHORTCUT\(#80\)/, "the typeof-number compatibility limit is not documented");
	// A numeric bump freezes the shared row stores (#73/#64); never reintroduce it.
	assert.doesNotMatch(body, /revision\s*\+\s*1000/);
	assert.doesNotMatch(body, /revision:\s*hostLocale\.revision\s*[+-]/);
	assert.doesNotMatch(body, /ctx\.emit\("locale\/change"/,
		"a fake Host event would reach the native bridge");
});

test("the mobile package no longer owns a ja language pack (#80)", () => {
	assert.doesNotMatch(COPY, /LOCALE_PACKS/, "the mobile copy module still exports a locale pack");
	assert.doesNotMatch(CLIENT, /addLanguage\(|JA_LOCALE_PACK|__RDSH_PWA_LOCALES__/,
		"the mobile client still registers a ja language");
	assert.doesNotMatch(CLIENT, /register\(namespace, "ja"/, "the mobile client still registers a ja dictionary");
	assert.doesNotMatch(CLIENT, /installJapaneseLocale/, "the mobile ja installer is still present");
	assert.doesNotMatch(HOST, /__RDSH_PWA_LOCALES__|LOCALE_PACKS/,
		"the host still injects a ja pack");
	// dsh-locale-ja is the sole owner; the mobile picker consumes the catalog.
	assert.match(CLIENT, /function localeOptionsFrom\(snapshot\) \{/);
});

test("language options are the locale service's registered list, never a guessed ja", () => {
	const body = block("function localeOptions(localeService) {", "function normalizeCommandContribution(");
	assert.match(body, /localeService\?\.getSnapshot\?\.\(\)/);
	assert.match(body, /snapshot\?\.locales/);
	assert.doesNotMatch(body, /"ja"|'ja'/, "a Japanese locale was invented");
	// The DSH UI follows the local snapshot; plugin copy follows currentLang.
	assert.match(CLIENT, /localDisplayLanguage/, "the copy language hook is missing");
	assert.match(CLIENT, /const local = knownLang\(localDisplayLanguage\);/);
});
