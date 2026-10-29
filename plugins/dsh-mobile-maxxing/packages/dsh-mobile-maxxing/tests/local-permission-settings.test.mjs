import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const START = "    const LOCAL_PERMISSION_KEY";
const END = "\n    // ---------------------------------------------------------------------\n    // Per-device theme";
const start = source.indexOf(START);
const end = source.indexOf(END, start);
assert(start > 0 && end > start, "the per-device permission block is missing or moved");
const block = source.slice(start, end);

/** VM-created objects carry another realm's prototypes; compare their data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness({ stored = null, command = async () => ({ ok: true, value: { matched: true } }), catalog = null } = {}) {
  const values = new Map();
  if (stored !== null) values.set("rdsh-mobile-ux:local-permission", stored);
  const emitted = [];
  const warnings = [];
  const commands = [];
  const sandbox = {
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    emit: (patch) => emitted.push(patch),
    t: (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`),
    console: { warn: (...args) => warnings.push(args) },
  };
  const remote = {
    permissionPresets: {
      catalog: async () =>
        catalog === null
          ? { ok: false, error: { code: "unavailable", message: "no catalog" } }
          : { ok: true, value: catalog },
    },
  };
  const sessions = {
    using: async (sessionId, options, operation) => {
      commands.push({ sessionId, source: options.source });
      return operation({
        binding: { session: { command: (text) => { commands.push({ text }); return command(text); } } },
      });
    },
  };
  const blocks = {
    calls: [],
    current: new Map(),
    storeFor(sessionId) {
      return { getSnapshot: () => blocks.current.get(sessionId) };
    },
    set(sessionId, block) {
      blocks.calls.push({ sessionId, block: block === undefined ? null : { ...block } });
      if (block === undefined) blocks.current.delete(sessionId);
      else blocks.current.set(sessionId, block);
    },
  };
  const api = vm.runInNewContext(
    `(() => {${block}\nreturn { readLocalPermission, writeLocalPermission, applyLocalPermissionToSession, installLocalPermissionDefault, loadPermissionCatalog }; })()`,
    sandbox,
  );
  return { api, values, emitted, warnings, commands, sandbox, remote, sessions, blocks };
}

test("an unset choice never touches a new session", async () => {
  const h = harness();
  assert.equal(h.api.readLocalPermission(), null);
  await h.api.applyLocalPermissionToSession(h.sessions, "s1");
  assert.deepEqual(h.commands, []);
});

test("the chosen preset is applied with the session's own command", async () => {
  const h = harness({ stored: "workspace-write" });
  await h.api.applyLocalPermissionToSession(h.sessions, "s1");
  assert.deepEqual(h.commands[0], { sessionId: "s1", source: "mobilePermissionDefault" });
  assert.deepEqual(h.commands[1], { text: "/permission workspace-write" });
});

test("a missing preset id is skipped rather than sent blank", async () => {
  const h = harness({ stored: "read-only" });
  await h.api.applyLocalPermissionToSession(h.sessions, "");
  assert.deepEqual(h.commands, []);
});

test("follow-the-shared-default clears the stored key", () => {
  const h = harness({ stored: "read-only" });
  h.api.writeLocalPermission("");
  assert.equal(h.values.has("rdsh-mobile-ux:local-permission"), false);
  assert.deepEqual(plain(h.emitted.at(-1)), { localPermission: null });
  h.api.writeLocalPermission("auto");
  assert.equal(h.values.get("rdsh-mobile-ux:local-permission"), "auto");
  assert.deepEqual(plain(h.emitted.at(-1)), { localPermission: "auto" });
});

test("a refused or missing command is reported, not thrown", async () => {
  const refused = harness({ stored: "read-only", command: async () => ({ ok: false, error: { code: "denied", message: "nope" } }) });
  await refused.api.applyLocalPermissionToSession(refused.sessions, "s1");
  assert.equal(refused.warnings.length, 1);
  assert.match(refused.emitted.at(-1).permissionError, /applyFailed/);

  const unmatched = harness({ stored: "read-only", command: async () => ({ ok: true, value: { matched: false } }) });
  await unmatched.api.applyLocalPermissionToSession(unmatched.sessions, "s1");
  assert.match(unmatched.emitted.at(-1).permissionError, /applyFailed/);
});

test("the wrapper keeps the caller's beforeOpen and is restored on dispose", async () => {
  const h = harness({ stored: "read-only" });
  const disposers = [];
  const scope = { effect: (fn) => disposers.push(fn()) };
  const calls = [];
  class Workspace {
    openWorkspaceSession(workspaceId, beforeOpen, reuse) {
      calls.push({ workspaceId, reuse });
      beforeOpen?.("new-session");
      return "result";
    }
  }
  const workspace = new Workspace();
  h.api.installLocalPermissionDefault(scope, workspace, h.sessions);
  const seen = [];
  const returned = workspace.openWorkspaceSession("w1", (id) => seen.push(id), { agentPreset: "x" });
  assert.equal(returned, "result");
  assert.deepEqual(seen, ["new-session"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.commands.at(-1), { text: "/permission read-only" });

  // A second install must not stack another wrapper.
  h.api.installLocalPermissionDefault(scope, workspace, h.sessions);
  workspace.openWorkspaceSession("w1", undefined, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.commands.filter((entry) => entry.text !== undefined).length, 2);

  disposers[0]();
  assert.equal(Object.hasOwn(workspace, "openWorkspaceSession"), false);
});

test("a new session's composer stays inert until the preset is applied", async () => {
  let settle;
  const h = harness({
    stored: "read-only",
    command: () => new Promise((resolve) => { settle = resolve; }),
  });
  class Workspace {
    openWorkspaceSession(_workspaceId, beforeOpen) {
      beforeOpen?.("s1");
      return "opened";
    }
  }
  const workspace = new Workspace();
  h.api.installLocalPermissionDefault({ effect: () => () => {} }, workspace, h.sessions, h.blocks);
  assert.equal(workspace.openWorkspaceSession("w1"), "opened", "the open result is preserved");
  assert.deepEqual(plain(h.blocks.calls[0]), {
    sessionId: "s1",
    block: { reason: "localPermission.applying" },
  }, "the composer was not blocked before the command");
  assert.equal(h.blocks.current.has("s1"), true);

  settle({ ok: true, value: { matched: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.blocks.current.has("s1"), false, "the block outlived the command");
  assert.deepEqual(plain(h.blocks.calls.at(-1)), { sessionId: "s1", block: null });
  assert.deepEqual(h.commands.at(-1), { text: "/permission read-only" });
});

test("a failed preset still releases the composer block", async () => {
  const h = harness({
    stored: "workspace-write",
    command: async () => ({ ok: false, error: { code: "denied", message: "nope" } }),
  });
  class Workspace {
    openWorkspaceSession(_workspaceId, beforeOpen) {
      beforeOpen?.("s2");
    }
  }
  const workspace = new Workspace();
  h.api.installLocalPermissionDefault({ effect: () => () => {} }, workspace, h.sessions, h.blocks);
  workspace.openWorkspaceSession("w1");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.blocks.current.has("s2"), false, "a refusal left the composer blocked");
  assert.deepEqual(plain(h.blocks.calls.at(-1)), { sessionId: "s2", block: null });
  assert.match(h.emitted.at(-1).permissionError, /applyFailed/);
});

test("a block another plugin already raised is restored, not cleared", async () => {
  let settle;
  const h = harness({
    stored: "read-only",
    command: () => new Promise((resolve) => { settle = resolve; }),
  });
  const other = { reason: "another plugin" };
  h.blocks.current.set("s5", other);
  class Workspace {
    openWorkspaceSession(_workspaceId, beforeOpen) {
      beforeOpen?.("s5");
    }
  }
  const workspace = new Workspace();
  h.api.installLocalPermissionDefault({ effect: () => () => {} }, workspace, h.sessions, h.blocks);
  workspace.openWorkspaceSession("w1");
  assert.notEqual(h.blocks.current.get("s5"), other, "our gate did not replace the old block");
  settle({ ok: true, value: { matched: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.blocks.current.get("s5"), other, "the previous block was not restored");
});

test("a newer block raised while the command runs is left alone", async () => {
  let settle;
  const h = harness({
    stored: "read-only",
    command: () => new Promise((resolve) => { settle = resolve; }),
  });
  class Workspace {
    openWorkspaceSession(_workspaceId, beforeOpen) {
      beforeOpen?.("s6");
    }
  }
  const workspace = new Workspace();
  h.api.installLocalPermissionDefault({ effect: () => () => {} }, workspace, h.sessions, h.blocks);
  workspace.openWorkspaceSession("w1");
  const newer = { reason: "newer owner" };
  h.blocks.current.set("s6", newer);
  settle({ ok: true, value: { matched: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.blocks.current.get("s6"), newer, "release cleared a newer owner's block");
});

test("no preset or no block registry keeps the unblocked path", async () => {
  const noPreset = harness();
  class Workspace {
    openWorkspaceSession(_workspaceId, beforeOpen) {
      beforeOpen?.("s3");
    }
  }
  const noPresetWorkspace = new Workspace();
  noPreset.api.installLocalPermissionDefault({ effect: () => () => {} }, noPresetWorkspace, noPreset.sessions, noPreset.blocks);
  noPresetWorkspace.openWorkspaceSession("w1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(noPreset.blocks.calls, [], "a follow-the-default choice raised a block");

  const noBlocks = harness({ stored: "read-only" });
  const noBlocksWorkspace = new Workspace();
  noBlocks.api.installLocalPermissionDefault({ effect: () => () => {} }, noBlocksWorkspace, noBlocks.sessions, null);
  noBlocksWorkspace.openWorkspaceSession("w1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(noBlocks.commands.at(-1), { text: "/permission read-only" }, "the command was skipped");
});

test("an open callback that throws releases the block it raised", () => {
  const h = harness({ stored: "read-only" });
  class Workspace {
    openWorkspaceSession(_workspaceId, beforeOpen) {
      beforeOpen?.("s4");
    }
  }
  const workspace = new Workspace();
  h.api.installLocalPermissionDefault({ effect: () => () => {} }, workspace, h.sessions, h.blocks);
  assert.throws(
    () => workspace.openWorkspaceSession("w1", () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(h.blocks.current.has("s4"), false, "a refused open left the composer blocked");
  assert.deepEqual(h.commands, [], "a refused open still sent the permission command");
});

test("the catalog feeds the card and a failed read is reported", async () => {
  const ok = harness({
    catalog: {
      options: [{ value: "read-only", name: "read-only" }],
      defaultOptions: [{ value: "read-only", name: "read-only" }],
      defaultPreset: "read-only",
    },
  });
  await ok.api.loadPermissionCatalog(ok.remote);
  assert.deepEqual(plain(ok.emitted.at(-1)), {
    permissionOptions: [{ value: "read-only", name: "read-only", description: "" }],
    permissionSharedDefault: "read-only",
    permissionError: "",
  });

  const failed = harness();
  await failed.api.loadPermissionCatalog(failed.remote);
  assert.match(failed.emitted.at(-1).permissionError, /unavailableDetail/);
});

test("the mobile plugin wires the public composer-block face (#65)", () => {
  assert.match(source, /ctx\.inject\(\["uiWorkspace", "sessions", "conversation"\]/, "the conversation service is not injected");
  assert.match(source, /scope\.conversation\?\.blocks \?\? null/, "the block registry is not passed");
  assert.match(block, /const block = \{ reason: t\("localPermission\.applying"\) \};/);
  assert.match(block, /blocks\.set\(sessionId, block\)/);
  assert.match(block, /if \(current === block\) blocks\.set\(sessionId, previous\)/,
    "release does not restore the previous block");
  assert.match(block, /\.finally\(release\)/, "the block is not released when the command settles");
});

test("the block never writes host settings", () => {
  assert.doesNotMatch(block, /remote\.settings/);
  assert.doesNotMatch(block, /\.mutate\(/);
  assert.doesNotMatch(block, /configForms/);
  assert.doesNotMatch(block, /setTranscriptView|setPerformanceUsage|setBusyEnter/);
});
