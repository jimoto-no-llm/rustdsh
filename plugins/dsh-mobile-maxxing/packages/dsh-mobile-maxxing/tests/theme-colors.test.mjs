/**
 * Every colour the client paints must come from an upstream theme token.
 *
 * DSH swaps palettes with `body[data-ds-dark-theme]` (light = attribute absent)
 * and exposes the palette as `--dsw-alias-*` custom properties on `body`. A raw
 * hex here is therefore a dark-theme assumption baked into a shared stylesheet:
 * it looks right on dark and becomes unreadable on light. `var(--token, #hex)`
 * is fine — the fallback only paints if ui-theme is missing.
 *
 * Exceptions are the photo surfaces (lightbox, crop overlay): they sit on top of
 * a photograph and are deliberately dark in both palettes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Rules allowed to carry raw colour literals, with the reason. */
const DARK_BY_DESIGN = [
	{ match: /\[data-rdsh-lightbox\]/, reason: "sits on a photo" },
	{ match: /\.rdsh-crop-/, reason: "crop UI sits on a photo" },
	{ match: /\[data-rdsh-crop-button\]/, reason: "crop UI sits on a photo" },
	// The drawer dim is the reference mask, fixed at rgba(0,0,0,.35). It is a
	// scrim over the app, not text or chrome whose contrast depends on the
	// palette.
	{ match: /\.rdsh-mux-backdrop$/, reason: "drawer scrim is a fixed mask" },
];

/**
 * #58: the Variant B session rows used to be an exact copy of DSH-PWA
 * mobile-ux, fixed dark palette and all, which kept the whole session list
 * black under the light theme. Every surface and accent in that block now
 * names a palette token; these are the declarations that pin it.
 */
const OUTLINE_TOKENS = [
	"--rdsh-ring-fill: var(--dsw-alias-bg-layer-2",
	"--rdsh-ring-fill: var(--dsw-alias-bg-layer-3",
	"--rdsh-ring-fill: var(--dsw-alias-interactive-bg-hover-solid",
	"background: var(--dsw-alias-bg-layer-1",
	"box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2",
	"background: var(--dsw-alias-interactive-bg-hover-solid",
	"color-mix(in srgb, var(--dsw-alias-link",
	"color-mix(in srgb, var(--dsw-alias-state-warn-primary",
];

/** Properties that must name a token, not a literal. */
const COLOUR_PROPERTY = /^(?:color|background|background-color|border|border-(?:top|right|bottom|left)|border-color|border-top-color|outline-color|accent-color|-webkit-text-fill-color|fill|stroke)$/;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

/** Pull every `const CSS = \`...\`;` template out of the client bundle. */
function cssBlocks(source) {
	const blocks = [];
	const marker = "const CSS = `";
	let from = 0;
	for (;;) {
		const start = source.indexOf(marker, from);
		if (start === -1) break;
		const open = start + marker.length;
		let index = open;
		while (index < source.length) {
			if (source[index] === "\\") {
				index += 2;
				continue;
			}
			if (source[index] === "`") break;
			index += 1;
		}
		blocks.push({ text: source.slice(open, index), offset: open });
		from = index + 1;
	}
	return blocks;
}

/** Drop `/* ... *\/` comments, keeping line numbering intact. */
function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** True when the character at `at` sits inside a `var(...)` fallback slot. */
function insideVar(text, at) {
	let depth = 0;
	for (let index = at; index >= 0; index -= 1) {
		const character = text[index];
		if (character === ")") depth += 1;
		else if (character === "(") {
			if (depth === 0) {
				const name = text.slice(Math.max(0, index - 12), index);
				return /var\(\s*--[\w-]+\s*$/.test(name);
			}
			depth -= 1;
		}
	}
	return false;
}

/** Walk the block and yield { selector, property, value, line }. */
function declarations(text, offset) {
	const clean = stripComments(text);
	const lines = clean.split("\n");
	const found = [];
	let selector = "";
	let buffer = "";
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		let rest = line;
		for (;;) {
			const open = rest.indexOf("{");
			const close = rest.indexOf("}");
			if (open === -1 && close === -1) {
				buffer += rest;
				break;
			}
			if (open !== -1 && (close === -1 || open < close)) {
				selector = `${buffer}${rest.slice(0, open)}`.trim().replace(/\s+/g, " ");
				buffer = "";
				rest = rest.slice(open + 1);
				continue;
			}
			// `}` closes the current rule: its body is `buffer` plus what came before.
			const body = `${buffer}${rest.slice(0, close)}`;
			const properties = body.split(";");
			for (const property of properties) {
				const colon = property.indexOf(":");
				if (colon === -1) continue;
				found.push({
					selector,
					property: property.slice(0, colon).trim(),
					value: property.slice(colon + 1).trim(),
					line: index,
				});
			}
			buffer = "";
			selector = "";
			rest = rest.slice(close + 1);
			if (rest.trim() === "") break;
		}
	}
	return { found, lines, offset };
}

function violations() {
	const bad = [];
	for (const block of cssBlocks(CLIENT)) {
		const { found } = declarations(block.text, block.offset);
		for (const declaration of found) {
			// Custom properties that carry a colour (e.g. --rdsh-ring-fill) count too.
			if (declaration.property.startsWith("--")) {
				if (!/fill|color|bg|background|stroke|border/.test(declaration.property)) continue;
			} else if (!COLOUR_PROPERTY.test(declaration.property)) continue;
			if (DARK_BY_DESIGN.some((entry) => entry.match.test(declaration.selector))) continue;
			if (!LITERAL.test(declaration.value.replace(/var\([^)]*\)/g, "VAR"))) continue;
			bad.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} }`);
		}
	}
	return bad;
}

/** The Variant B block: its ring rows and idle open row, up to the title sheen. */
function outlineBlock() {
	const start = CLIENT.indexOf('html[data-rdsh-anim="outline"] [data-rdsh-ring-row] {');
	const end = CLIENT.indexOf("/* The open session's title carries its running state", start);
	assert.ok(start !== -1 && end > start, "Variant B ring block is present");
	return CLIENT.slice(start, end);
}

test("no shared stylesheet paints a raw colour", () => {
	const bad = violations();
	assert.deepEqual(bad, [], `raw colours in a theme-aware stylesheet:\n${bad.join("\n")}`);
});

test("the session list follows the palette in both themes", () => {
	const outline = outlineBlock();
	for (const declaration of OUTLINE_TOKENS) {
		assert.ok(outline.includes(declaration), `Variant B block lost a palette token: ${declaration}`);
	}
	// #58: a literal outside a var() fallback is what kept the light theme's
	// session list black, ring gradients included. The fallbacks are the old
	// dark values, which only paint when ui-theme is missing.
	const bare = outline.replace(/var\([^)]*\)/g, "VAR");
	assert.equal(LITERAL.test(bare), false, `Variant B block still paints a raw colour: ${bare.match(LITERAL)?.[0]}`);
});

test("the detector catches a literal it should", () => {
	// Guard the guard: a rule with a raw background must be reported.
	const sample = ".x { background: #2a2a2e; color: var(--dsw-alias-label-primary, #f9fafb); }";
	assert.match(sample, LITERAL);
});
