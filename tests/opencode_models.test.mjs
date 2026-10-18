import test from "node:test";
import assert from "node:assert/strict";
import { buildProviders, parseModels } from "../scripts/opencode-models.mjs";
import { replaceManagedBlock, replaceRef } from "../scripts/sync-opencode-models.mjs";

const model = (id = "test-free", npm = "@ai-sdk/openai-compatible") => ({
  id, name: 'A model with {braces} and "quotes"', providerID: "opencode",
  api: { id, npm, url: "https://opencode.ai/zen/v1" },
  cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 },
  capabilities: { toolcall: true, input: { text: true, image: true }, interleaved: false },
});

test("parses multiple verbose records with quoted braces and rejects truncation", () => {
  const text = `opencode/test-free\n${JSON.stringify(model(), null, 2)}\nopencode/second\n${JSON.stringify(model("second"))}\n`;
  assert.deepEqual(parseModels(text).map(m => m.id), ["test-free", "second"]);
  assert.throws(() => parseModels(text.slice(0, -5)), /Incomplete/);
  assert.throws(() => parseModels("not a model listing"), /Incomplete/);
});

test("splits protocols so responses models never use chat completions", () => {
  const routes = buildProviders([model(), model("responses", "@ai-sdk/openai"), model("claude", "@ai-sdk/anthropic")], true);
  assert.equal(routes["rdsh-opencode-zen"].api, "openai-completions");
  assert.equal(routes["rdsh-opencode-zen-responses"].api, "openai-responses");
  assert.equal(routes["rdsh-opencode-zen-anthropic"].api, "anthropic-messages");
  assert.deepEqual(routes["rdsh-opencode-zen"].models[0].input, ["text", "image"]);
});

test("refuses OpenCode-only public access and includes models with real auth", () => {
  const paid = { ...model("paid"), cost: { input: 1, output: 2 } };
  assert.throws(() => buildProviders([model(), paid], false), /requires an API key/);
  assert.equal(buildProviders([model(), paid], true)["rdsh-opencode-zen"].models.length, 2);
});

test("rejects endpoints that could exfiltrate the runtime credential", () => {
  for (const url of ["https://evil.example/zen/v1", "http://opencode.ai/zen/v1", "https://opencode.ai/zen/v1?key=secret", "https://user:secret@opencode.ai/zen/v1"]) {
    assert.throws(() => buildProviders([{ ...model(), api: { ...model().api, url } }], true), /Unexpected/);
  }
});

test("rejects invalid capacities and duplicate wire model IDs", () => {
  assert.throws(() => buildProviders([{ ...model(), limit: { context: 0, output: 10 } }], true), /capabilities/);
  assert.throws(() => buildProviders([model(), model()], true), /Duplicate/);
});

test("preserves reasoning-content compatibility without invented effort levels", () => {
  const m = model();
  m.capabilities.interleaved = { field: "reasoning_content" };
  const item = buildProviders([m], true)["rdsh-opencode-zen"].models[0];
  assert.equal(item.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(item.reasoningEfforts, false);
});

test("resync replaces only its own block and retains unrelated settings bytes", () => {
  const original = "# custom comment\n- id: custom\n  disabled: false\n\n";
  const first = replaceManagedBlock(original, { id: "llm-pi-ai", config: { providers: {} } });
  assert.ok(first.startsWith(original));
  assert.equal(replaceManagedBlock(first, { id: "llm-pi-ai", config: { providers: {} } }), first);
  assert.throws(() => replaceManagedBlock("# BEGIN RDSH OPENCODE MODELS\n", {}), /Malformed/);
});

test("credential update retains other records and quotes reference values", () => {
  const prefix = "version: 1\nrecords:\n  llm-pi-ai/other:\n    kind: api-key\n    key: unchanged\n";
  const original = prefix + "refs:\n  OTHER_KEY: existing\n  RDSH_OPENCODE_ZEN_API_KEY: |\n    old\nextra: preserved\n";
  const next = replaceRef(original, 'test:"escaped"');
  assert.ok(next.startsWith(prefix));
  assert.ok(next.includes("  OTHER_KEY: existing\n"));
  assert.ok(next.includes('RDSH_OPENCODE_ZEN_API_KEY: "test:\\"escaped\\""'));
  assert.ok(next.endsWith("extra: preserved\n"));
  assert.ok(!next.includes("    old"));
  assert.throws(() => replaceRef("version: 1\nrefs: {}\n", "public"), /Unsupported/);
});
