/**
 * #97 guard: never find a control by an English aria-label again.
 *
 * The ja locale makes upstream render its labels from the dictionary, so a
 * selector such as `[aria-label="Session hierarchy"]` matches in en and
 * silently matches nothing in ja. That is how the effort display, the title
 * popover and the session-row menu disappeared at once. The fix is structural
 * (`data-slot`, a CSS-module class suffix, an upstream data attribute) or a
 * PROBES vocabulary; this test fails when a new English-only literal sneaks
 * back in.
 *
 * The allowlist below is deliberate and short. Every entry needs a reason and
 * must sit beside a structural path that wins first, so a shell without
 * aria-label cannot lose the hook.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** An `aria-label` attribute selector with a literal value. */
const SELECTOR = /aria-label\s*([*^]?=)\s*"([^"]*)"/g;
/** A literal made of ASCII letters, spaces and punctuation only (no `${…}`). */
const ENGLISH = /^[A-Za-z][A-Za-z .:_-]*$/;

/**
 * English literals that may stay, with the reason each one is safe.
 *
 * Each must be a fallback that a structural lookup tries first, or a test
 * fixture. Never add an entry to silence this test without one of those.
 */
const ALLOWED = [
	// 旧シェル用フォールバック: slot / triggerEffort の構造判定が先に一致する
	{ literal: "Select model", line: "modelTrigger()" },
	// 旧シェル用フォールバック: [data-sidebar-right-toggle] が先に一致する
	{ literal: "Collapse right sidebar", line: "right-panel close glyph" },
];

function lineOf(source, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (source[cursor] === "\n") line += 1;
	}
	return line;
}

/** Every English-only aria-label selector in the bundle. */
function englishSelectors(source) {
	const found = [];
	for (const match of source.matchAll(SELECTOR)) {
		const literal = match[2];
		if (!ENGLISH.test(literal)) continue;
		found.push({ literal, operator: match[1], line: lineOf(source, match.index) });
	}
	return found;
}

const FOUND = englishSelectors(CLIENT);

test("#97 client.js は英語だけの aria-label セレクタを持たない", () => {
	const allowed = new Set(ALLOWED.map((entry) => entry.literal));
	const offenders = FOUND.filter((entry) => !allowed.has(entry.literal));
	assert.deepEqual(
		offenders,
		[],
		`英語リテラルの aria-label セレクタが ${offenders.length} 件あります:\n`
			+ offenders.map((entry) => `  client.js:${entry.line}  [aria-label${entry.operator}"${entry.literal}"]`).join("\n")
			+ "\n構造（data-slot / [class*=\"...\"] の接尾辞 / upstream の data 属性）か PROBES の語彙（ariaLabelSelector）に置き換えてください。"
			+ "英語のまま残す場合は、構造が先に効くことを確かめて ALLOWED に理由つきで追加してください。",
	);
});

test("#97 許可リストは実際に存在するセレクタだけを載せる", () => {
	const found = new Set(FOUND.map((entry) => entry.literal));
	for (const entry of ALLOWED) {
		assert.ok(
			found.has(entry.literal),
			`許可リストの「${entry.literal}」（${entry.line}）は client.js に無くなっています。項目を削除してください。`,
		);
	}
});

test("#97 ガード自体が英語リテラルを検出する", () => {
	// A synthetic line proves the check is not vacuous even if client.js is empty.
	const sample = 'document.querySelector(\'nav[aria-label="Session hierarchy"]\');';
	const found = englishSelectors(sample);
	assert.deepEqual(found.map((entry) => entry.literal), ["Session hierarchy"]);
});
