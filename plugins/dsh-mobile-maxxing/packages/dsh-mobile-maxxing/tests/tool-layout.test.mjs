import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");

test("mobile tool summaries start below the status icon", () => {
  assert.ok(client.includes('[data-chat-flow-kind="assistant-step"] [class*="_root"]:has([class*="_leading"]) { flex-wrap: wrap; }'));
  assert.ok(client.includes('[data-chat-flow-kind="assistant-step"] [class$="_summary"]'));
  assert.ok(client.includes("flex: 1 0 100%; min-width: 0;"));
  assert.ok(client.includes("white-space: normal; overflow-wrap: break-word; word-break: normal;"));
});

test("mobile bash commands and output wrap within the terminal card", () => {
  assert.ok(client.includes('[data-chat-flow-kind] [data-terminal] [class*="_promptLine"] { flex-wrap: wrap; }'));
  assert.ok(client.includes('[data-chat-flow-kind] [data-terminal] [data-command-text]'));
  assert.ok(client.includes("flex: 1 0 100%; min-width: 0; overflow-x: hidden;"));
  assert.ok(client.includes("white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;"));
  assert.ok(client.includes('[data-chat-flow-kind] [data-terminal] [class*="_output"] [class*="_line"]'));
  assert.ok(client.includes("white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;"));
});
