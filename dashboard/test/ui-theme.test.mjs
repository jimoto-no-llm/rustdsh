import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const read = (name) =>
  fs.readFile(fileURLToPath(new URL("../" + name, import.meta.url)), "utf8");
const html = await read("ui.html");
const app = await read("app.mjs");

// Both palettes are single-level declaration blocks, so a bounded regex is
// enough and avoids index arithmetic drifting after an edit.
const LIGHT_BLOCK = /:root\s*\{[^}]*\}/;
const DARK_BLOCK = /:root\[data-theme="dark"\]\s*\{[^}]*\}/;
const tokenNames = (pattern) => {
  const match = html.match(pattern);
  assert.ok(match, "missing block: " + pattern);
  return new Set([...match[0].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
};
const light = tokenNames(LIGHT_BLOCK);
const dark = tokenNames(DARK_BLOCK);

test("both palettes define the same tokens", () => {
  assert.ok(light.size >= 40, "light defines " + light.size + " tokens");
  const missingInDark = [...light].filter((token) => !dark.has(token));
  assert.deepEqual(missingInDark, [], "dark is missing: " + missingInDark.join(", "));
  const extraInDark = [...dark].filter((token) => !light.has(token));
  assert.deepEqual(extraInDark, [], "dark-only tokens: " + extraInDark.join(", "));
});

test("every var() the stylesheet uses is defined", () => {
  const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 30, "stylesheet uses " + used.size + " tokens");
  const undefinedTokens = [...used].filter((token) => !light.has(token));
  assert.deepEqual(undefinedTokens, [], "undefined: " + undefinedTokens.join(", "));
});

test("colour literals live only in the two token blocks", () => {
  const withoutTokens = html
    .replace(LIGHT_BLOCK, "")
    .replace(DARK_BLOCK, "")
    .split("</style>")[0];
  const literals = [
    ...new Set(
      (withoutTokens.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((value) =>
        /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value),
      ),
    ),
  ];
  assert.deepEqual(literals, [], "move these into tokens: " + literals.join(", "));
  assert.equal(withoutTokens.includes("rgba("), false, "rgba() belongs to the token blocks");
  assert.equal(withoutTokens.includes("#fff"), false, "use --card or --accent-fg");
});

test("the theme is applied before paint and can be toggled", () => {
  assert.ok(html.includes('id="theme-toggle"'), "toggle button");
  assert.ok(html.includes("rdsh_dashboard_theme"), "boot script storage key");
  assert.ok(html.includes("document.documentElement.dataset.theme = theme"), "boot applies it");
  assert.ok(html.indexOf("dataset.theme") < html.indexOf("<style>"), "boot runs before styles");
  for (const needle of [
    "theme-toggle",
    "rdsh_dashboard_theme",
    "prefers-color-scheme: dark",
    "aria-pressed",
    "setTheme",
  ])
    assert.ok(app.includes(needle), "app.mjs: " + needle);
});

test("dark palette keeps the tone, chart and surface hooks", () => {
  for (const token of [
    "--bg", "--card", "--raised", "--inset",
    "--line", "--line-soft", "--line-strong", "--fg", "--mut", "--ink-soft",
    "--ok-bg", "--warn-bg", "--danger-bg", "--info-bg", "--neutral-bg",
    "--chart-ok", "--chart-warn", "--chart-danger", "--chart-info", "--chart-neutral",
    "--accent", "--accent-hover", "--accent-fg", "--focus", "--selection",
    "--shadow-1", "--scroll-thumb",
  ])
    assert.ok(dark.has(token), token);
});
