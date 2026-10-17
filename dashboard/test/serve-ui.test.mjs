import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The native `rdsh serve` shell (src/ui.html) is embedded verbatim by
// src/serve.rs. These checks keep its role header and its first paint honest:
// the page must say what it is and must not present empty data cards.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = name => readFile(join(root, name), "utf8");

function catalogRows(source) {
  const start = source.indexOf("for (const [key, ja, en, zh] of [");
  const end = source.indexOf("]) { (RDSH_UI_CATALOG[key]", start);
  assert.ok(start > 0 && end > start, "the inline catalog block is present");
  const row = /\["((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\]/g;
  const rows = [];
  let match;
  while ((match = row.exec(source.slice(start, end)))) {
    rows.push({ key: match[1], ja: match[2], en: match[3], zh: match[4] });
  }
  return rows;
}

const variables = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test("the serve header states the monitor role in en, ja and zh", async () => {
  const rows = catalogRows(await read("src/ui.html"));
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length, "catalog keys are unique");
  const catalog = new Map(rows.map(row => [row.key, row]));
  for (const key of [
    "app.role",
    "app.subtitle",
    "overview.heading",
    "overview.help",
    "awaiting",
    "connection.waiting",
    "connection.connected",
  ]) {
    assert.ok(catalog.has(key), `${key} is localizable`);
  }
  assert.equal(catalog.get("app.role").en, "Audit & Performance Monitor for DeepSeek Harness");
  for (const locale of ["ja", "zh"]) {
    assert.ok(catalog.get("app.role")[locale].length > 0, `app.role has ${locale}`);
    assert.notEqual(catalog.get("app.role")[locale], catalog.get("app.role").en, `app.role translates ${locale}`);
  }
});

test("every dashboard catalog row keeps its placeholders across locales", async () => {
  for (const row of catalogRows(await read("src/ui.html"))) {
    assert.equal(typeof row.en, "string", row.key);
    assert.deepEqual(variables(row.ja), variables(row.en), row.key);
    assert.deepEqual(variables(row.zh), variables(row.en), row.key);
  }
});

test("the header names the monitor role while the page title stays the chat-style title", async () => {
  const source = await read("src/ui.html");
  assert.match(source, /<title id="ui-page-title">rdsh dashboard<\/title>/);
  assert.match(source, /"ui-title":"app\.role"/);
  assert.match(source, /"ui-page-title":"page\.title"/);
  assert.match(source, /id="ui-subtitle"/);
  assert.match(source, /not the upstream dsh web chat interface/);
});

test("the first paint shows the role, an overview and the build version without a fetch", async () => {
  const source = await read("src/ui.html");
  assert.match(source, /id="ui-overview-heading"/);
  assert.match(source, /id="ui-overview-help"/);
  assert.match(source, /id="connect-state"/);
  assert.match(source, /<span id="ver">rdsh __RDSH_VERSION__<\/span>/);
  assert.match(source, /"doctor":"awaiting"/);
  assert.match(source, /"sess":"awaiting"/);
  assert.match(source, /"sk":"awaiting"/);
  assert.doesNotMatch(source, /未取得/, "no card is left looking broken before connecting");
  const serve = await read("src/serve.rs");
  assert.match(serve, /__RDSH_VERSION__/);
  assert.match(serve, /env!\("CARGO_PKG_VERSION"\)/);
});

test("a successful connection renders diagnostics and sessions in parallel", async () => {
  const source = await read("src/ui.html");
  assert.match(source, /Promise\.all\(\[jget\("\/api\/version"\), doctor\(\), sessions\(\), skills\(\)\]\)/);
  assert.match(source, /setConnectState\("connection\.connected"/);
});
