/**
 * #79: a device-local, terminal-only dark surface.
 *
 * Static contract checks for the parts a stub browser cannot see: the
 * preference is off and local by default, the mobile stylesheet stays scoped
 * to the terminal body, and the setting never reaches a shared writer or a
 * custom xterm mount. Runtime boot/persistence/teardown behaviour lives in
 * client-load.test.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const COPY = readFileSync(new URL("../lib/copy.js", import.meta.url), "utf8");

function block(start, end) {
	const at = CLIENT.indexOf(start);
	assert.notEqual(at, -1, `${start} exists`);
	const close = CLIENT.indexOf(end, at);
	assert.notEqual(close, -1, `${end} follows ${start}`);
	return CLIENT.slice(at, close);
}

/** WCAG relative luminance of an sRGB hex color. */
function luminance(hex) {
	const [r, g, b] = [1, 3, 5].map((index) => {
		const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
	const a = luminance(foreground);
	const b = luminance(background);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("terminal-dark copy exists in both shipped packs (#79)", () => {
	const keys = ["localDisplay.terminalDark", "localDisplay.terminalDark.note"];
	const en = COPY.slice(COPY.indexOf("en: {"), COPY.indexOf("ja: {"));
	const ja = COPY.slice(COPY.indexOf("ja: {"));
	for (const key of keys) {
		const pattern = new RegExp(`"${key.replaceAll(".", "\\.")}":\\s*"`);
		assert.match(en, pattern, `${key} missing from en`);
		assert.match(ja, pattern, `${key} missing from ja`);
	}
});

test("the choice is off by default, local-only and never a shared write (#79)", () => {
	assert.match(CLIENT, /const TERMINAL_DARK_KEY = "rdsh-mobile-ux:terminal-dark";/);
	assert.match(CLIENT, /terminalDark: readTerminalDark\(\),/, "the store does not start from the saved choice");

	const read = block("function readTerminalDark()", "function applyTerminalDark()");
	assert.match(read, /localStorage\.getItem\(TERMINAL_DARK_KEY\)/);
	assert.doesNotMatch(read, /setItem|removeItem|theme\.setTheme|ctx\.settings/);

	const write = block("function writeTerminalDark(value)", "function attachTerminalDark(ctx)");
	assert.match(write, /localStorage\.setItem\(TERMINAL_DARK_KEY, "1"\)/);
	assert.match(write, /localStorage\.removeItem\(TERMINAL_DARK_KEY\)/);
	assert.doesNotMatch(write, /ctx\.settings|configForms|api\.remote|theme\.setTheme|setTheme\(|setFontSize\(|fetch\(/,
		"the terminal-dark choice reached a shared/Host writer");
});

test("the mobile stylesheet scopes dark background/foreground to the terminal (#79)", () => {
	const css = block("  /* #79: a terminal-only dark surface.", "  /* Edit summary:");
	assert.match(css, /html\[data-rdsh-terminal-dark\] \[data-sidebar-terminal\] > div:has\(> \.xterm\)/,
		"the screen wrapper upstream measures is not scoped");
	assert.match(css, /html\[data-rdsh-terminal-dark\] \[data-sidebar-terminal\] \.xterm \{/,
		"the xterm mount is not scoped");
	assert.match(css, /background-color: var\(--dsw-static-neutral-bluish-950, #151517\) !important;/);
	assert.match(css, /color: var\(--dsw-static-neutral-bluish-50, #f9fafb\) !important;/);
	assert.doesNotMatch(css, /xterm-fg-|xterm-bg-|--terminal-/, "the rule replaced xterm's ANSI palette");
	assert.doesNotMatch(css, /(?:^|\n)\s*(?:html|body|:root)\s*\{/, "a global dark rule was introduced");
	assert.doesNotMatch(css, /body\s*\[data-rdsh-terminal-dark\]/, "the marker is applied to the whole page");
});

test("the dark terminal keeps default text readable and leaves ANSI to xterm (#79)", () => {
	// The text pair is DSH's dark palette base/foreground. xterm's own ANSI
	// entries stay untouched; upstream sets minimumContrastRatio: 4.5, so its
	// DOM renderer raises any indexed color that would fall below that against
	// this background. No second (fixed) ANSI palette is introduced here.
	assert.ok(contrast("#f9fafb", "#151517") >= 7,
		"the terminal foreground/background pair does not even reach WCAG AAA");
	const css = block("  /* #79: a terminal-only dark surface.", "  /* Edit summary:");
	assert.doesNotMatch(css, /xterm-fg-|xterm-bg-|--terminal-/, "an ANSI override slipped into the scoped rule");
});

test("the Mobile display card owns the terminal-dark checkbox (#79)", () => {
	const ui = block("function LocalDisplaySettingsSection() {", "function LiveSpeed(");
	assert.match(ui, /checked: s\.terminalDark === true/);
	assert.match(ui, /writeTerminalDark\(event\.target\.checked\)/);
	assert.match(ui, /t\("localDisplay\.terminalDark"\)/);
	assert.match(CLIENT, /"data-rdsh-terminal-dark",\n    \];/, "the dispose hook is not in PHONE_HOOKS");
});

test("the terminal is repainted through the existing theme/change path, not a new mount (#79)", () => {
	const attach = block("function attachTerminalDark(ctx) {", "    // ---------------------------------------------------------------------\n    // Device-local display: font sizes and UI language.");
	assert.match(attach, /service\.getTheme\(\)/);
	assert.match(attach, /service\.snapshot = next/);
	assert.match(attach, /ctx\.emit\("theme\/change", next\)/);
	assert.doesNotMatch(attach, /revision\s*\+\s*1000/, "the repaint fabricated a revision upstream row stores would adopt");
	assert.doesNotMatch(attach, /new\s+Terminal|new\s+xterm|\.open\(|createElement\("div"\)|appendChild/,
		"a custom terminal mount or direct xterm handle was introduced");
});
