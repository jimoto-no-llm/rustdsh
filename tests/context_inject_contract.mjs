// Verifies `rdsh context inject` against the real DSH hook codec.
//
// The shell regression checks the JSON shape by hand; this test decodes the
// same stdout with @deepseek-ai/dsh-hook-protocol, the package the DSH
// Claude Code / Codex bridges actually use. A local run skips (exit 0) when
// that package is not installed; CI sets RDSH_HOOK_CODEC_REQUIRED=1, where a
// missing or mistyped DSH_HOOK_PROTOCOL fails the run instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const DEFAULT_PROTOCOL =
  "~/.local/opt/dsh-original/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-hook-protocol/lib/index.js";

function protocolPath() {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.DSH_HOOK_PROTOCOL,
    DEFAULT_PROTOCOL.replace(/^~/, home),
    join(home, ".local/opt/dsh/node_modules/@deepseek-ai/dsh-hook-protocol/lib/index.js"),
  ];
  return candidates.find((path) => path && existsSync(path));
}

// CI passes RDSH_HOOK_CODEC_REQUIRED=1 so that a missing or mistyped
// DSH_HOOK_PROTOCOL fails this file instead of skipping the contract.
function hookCodecRequired() {
  const value = process.env.RDSH_HOOK_CODEC_REQUIRED;
  return value !== undefined && value !== "" && value !== "0";
}

const protocol = protocolPath();
if (!protocol && hookCodecRequired()) {
  throw new Error(
    "RDSH_HOOK_CODEC_REQUIRED is set but the hook protocol package was not found" +
      ` (DSH_HOOK_PROTOCOL=${process.env.DSH_HOOK_PROTOCOL ?? "<unset>"})`,
  );
}
const mod = protocol ? await import(pathToFileURL(resolve(protocol)).href) : undefined;

test("inject output decodes as a UserPromptSubmit context hook", { skip: !mod && "hook protocol package not installed" }, () => {
  // Resolve before spawning: the run below uses the sandbox as its cwd, so a
  // relative BIN would fail with ENOENT.
  const bin = resolve(process.env.BIN ?? "./target/debug/rdsh");
  const sandbox = mkdtempSync(join(tmpdir(), "rdsh-inject-codec-"));
  try {
    const home = join(sandbox, "dsh");
    const work = join(sandbox, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "engine.rs"), "pub fn engine_score(i: &str) -> usize { i.len() }\n");
    const settings = (context, enabled = true) =>
      writeFileSync(
        join(home, "rdsh.json"),
        JSON.stringify(
          enabled ? { beta: { context_engine: true }, context } : { context },
        ),
      );
    const run = (args, payload) =>
      spawnSync(bin, ["context", "inject", ...args], {
        cwd: work,
        input: payload,
        encoding: "utf8",
        env: { ...process.env, DSH_HOME: home, HOME: sandbox },
      });

    const payload = JSON.stringify({
      prompt: "engine_score を直して",
      hook_event_name: "UserPromptSubmit",
      cwd: work,
      session_id: "codec-test",
    });

    // The engine is opt-in: silence, exit 0, no decoded context.
    settings({}, false);
    const off = run([], payload);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout.trim(), "");
    assert.equal(mod.parseHookOutput(0, off.stdout, "", "UserPromptSubmit").additionalContext, undefined);

    // Enabled: the codec turns stdout into model-visible context.
    settings({ goal: "APIの互換性を必ず保つ", include_git_diff: false, enable_retriever: false }, true);
    const on = run([], payload);
    assert.equal(on.status, 0, on.stderr);
    const decoded = mod.parseHookOutput(0, on.stdout, "", "UserPromptSubmit");
    assert.equal(decoded.hookEventName, "UserPromptSubmit");
    assert.match(decoded.additionalContext, /APIの互換性を必ず保つ/);

    // Diagnostics must not change what the model sees.
    const diagnostic = run(["--json"], payload);
    const withJson = mod.parseHookOutput(0, diagnostic.stdout, "", "UserPromptSubmit");
    assert.equal(withJson.additionalContext, decoded.additionalContext);
    assert.ok(JSON.parse(diagnostic.stdout).rdsh, "diagnostics object missing");

    // A garbage payload is not a failure and carries no context.
    const garbage = run([], "not json at all");
    assert.equal(garbage.status, 0, garbage.stderr);
    assert.equal(garbage.stdout.trim(), "");

    // The SessionStart alias is the same contract with the other event name.
    const started = run(["--event", "session-start"], payload);
    assert.equal(
      mod.parseHookOutput(0, started.stdout, "", "SessionStart").hookEventName,
      "SessionStart",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
