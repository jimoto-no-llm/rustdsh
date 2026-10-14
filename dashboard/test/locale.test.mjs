import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const originalDocument = globalThis.document;

test("locale catalog keeps dynamic chrome complete and preserves received text", async (t) => {
  t.after(() => {
    globalThis.document = originalDocument;
  });
  globalThis.document = {
    documentElement: { dataset: { rdshLocale: "zh-CN" } },
    getElementById() {
      return null;
    },
  };

  const { catalog, entries, formatDateTime, locale, text } = await import(
    `../locale.mjs?locale-test=${Date.now()}`
  );

  assert.equal(locale, "zh-CN");
  assert.equal(text("connection.connected"), "已连接 · 仅限此项目");
  assert.equal(text("diagnostics.working"), "正在检查连接的每个阶段…");
  assert.match(formatDateTime("2026-10-14T01:02:03Z"), /2026/);
  assert.equal(text("user value: 日本語で42"), "user value: 日本語で42");

  const keys = Object.keys(catalog.en).sort();
  assert.equal(new Set(entries.map(row => row[0])).size, entries.length, "catalog keys are unique");
  const variables = value => [...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
  for (const [key,ja,en,zh] of entries) {
    for (const value of [ja,en,zh]) assert.equal(typeof value,"string",key);
    assert.deepEqual(variables(ja),variables(en),key);
    assert.deepEqual(variables(zh),variables(en),key);
  }
  assert.equal(text("budget.source", {source:"未取得",baseline:"{basis}",basis:"日本語 原文"}),"使用 未取得 判断。启动前费用 {basis}：日本語 原文");
  for (const name of ["ja", "zh-CN"]) assert.deepEqual(Object.keys(catalog[name]).sort(), keys);
});

test("native dashboard uses explicit localization targets", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(here, "..", "..", "src", "ui.html"), "utf8");
  assert.doesNotMatch(source, /createTreeWalker/);
  assert.match(source, /ui-connect-heading/);
  assert.match(source, /RDSH_UI_CATALOG/);
});

test("localized dashboard renderers import the shared catalog", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["answer-applications-ui.mjs", "budget-ui.mjs", "cost-ledger-ui.mjs", "human-annotations-ui.mjs"]) {
    const source = await readFile(join(here, "..", name), "utf8");
    assert.match(source, /from "\.\/locale\.mjs"/, name);
    assert.match(source, /text\(/, name);
  }
});
