import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore, publicState } from "../state.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";
import { ReplyConsumer } from "../reply-consumer.mjs";
import { startDashboard } from "../server.mjs";
import { feedbackSince } from "../mcp.mjs";
import { EventsHub } from "../webhooks.mjs";
import { Webhook } from "standardwebhooks";
import { replyPrompt } from "../answer-applications.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const options = { timeout: 180000 };
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function setup(t, webhook = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-reply-test-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local"),
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
    RDSH_ADAPTER_FIXTURE_MODE: "reply_effect",
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
    RDSH_ADAPTER_FIXTURE_REPLY_COUNTER: path.join(root, "effects.txt"),
    PROVIDER_API_KEY: "fixture-secret-must-not-be-saved",
  };
  const ledger = await SessionLedger.open(project),
    attachedRuns = [],
    servers = [],
    deliveries = [];
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const webhookPost = async (_url, headers, body) => {
    const event = new Webhook(secret).verify(body, headers);
    deliveries.push(event);
    return event.type === "verification"
      ? { status: 200, body: JSON.stringify({ challenge: event.challenge }) }
      : { status: 204, body: "" };
  };
  if (webhook) {
    const store = await ProjectStore.open(project),
      hub = await EventsHub.open(project, () => store.value, webhookPost);
    await hub.subscribe({
      name: "dashboard.answer.created",
      arguments: { project_id: project.id },
      delivery: {
        mode: "webhook",
        url: "https://receiver.example/replies",
        secret,
      },
      ttlMs: 600000,
    });
  }
  let server, runtime;
  const start = async () => {
    server = await startDashboard({
      project,
      port: await freePort(),
      tailscale: false,
      ...(webhook ? { webhookPost } : {}),
    });
    servers.push(server);
    runtime = JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
    return server;
  };
  await start();
  t.after(async () => {
    for (const attached of attachedRuns) await attached.adapter.stop();
    for (const owned of servers) await owned.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-reply-test-"));
    await fs.rm(root, { recursive: true });
  });
  const post = async (route, body, credential = "human", origin) => {
    const headers =
      credential === "human"
        ? { "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5) }
        : credential === "admin"
          ? { authorization: `Bearer ${runtime.token}` }
          : credential === "mcp"
            ? { authorization: `Bearer ${runtime.mcp_token}` }
            : credential;
    return fetch(server.localUrl + "api/" + route, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
  };
  const attach = async (mode = "reply_effect", runId = null) => {
    const attached = await attachRecordedSession({
      ledger,
      run_id: runId,
      command: [process.execPath, fixture],
      env: { ...env, RDSH_ADAPTER_FIXTURE_MODE: mode },
      task_id: "T1",
      requestTimeout: 10000,
      stopTimeout: 5000,
    });
    attachedRuns.push(attached);
    return attached;
  };
  const ask = async (id, client, extra = {}) => {
    const decision = {
      kind: "consultation",
      consumer_id: client.consumer.consumer_id,
      target: {
        task_id: "T1",
        run_id: client.consumer.run_id,
        session_id: client.consumer.session_id,
        revision: "input-v1",
      },
      ...extra,
    };
    assert.equal(
      (
        await post(
          "update/question",
          { id, question: "次の修正をどう進めますか？", decision },
          "mcp",
        )
      ).status,
      200,
    );
    return decision;
  };
  const answer = async (
    id,
    replyText = "まず対象のテストを修正してください",
  ) => {
    const card = server.store.value.question_contracts.cards[id];
    const response = await post("update/answer", {
      id,
      answer: replyText,
      expected_revision: card.revision,
      contract_fingerprint: card.fingerprint,
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    return server.store.value.feedback.at(-1);
  };
  return {
    project,
    root,
    env,
    ledger,
    attach,
    ask,
    answer,
    post,
    start,
    deliveries,
    get server() {
      return server;
    },
    get runtime() {
      return runtime;
    },
    client: (attached, fetchImpl) =>
      ReplyConsumer.open({ project, attached, fetchImpl }),
    state: async () =>
      (
        await fetch(server.localUrl + "api/state", {
          headers: { authorization: `Bearer ${runtime.mcp_token}` },
        })
      ).json(),
    effects: async () => {
      try {
        return (
          await fs.readFile(env.RDSH_ADAPTER_FIXTURE_REPLY_COUNTER, "utf8")
        )
          .trim()
          .split("\n").length;
      } catch (e) {
        if (e.code === "ENOENT") return 0;
        throw e;
      }
    },
    trace: async () =>
      (await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse),
  };
}
const command = (state, message) =>
  state.answer_applications.commands[message.reply_command_id];
const begin = () => ({
  attempt_id: "attempt_" + randomUUID(),
  native_command_id: "cmd_" + randomUUID(),
});

test(
  "late cursors and simultaneous callers cannot bypass earlier or uncertain inputs to the same native target",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach(),
      client = await f.client(attached);
    for (const id of ["Q1", "Q2"]) {
      await f.ask(id, client);
      await f.answer(
        id,
        id === "Q1"
          ? "先にテストを確認してください"
          : "その後で修正してください",
      );
    }
    const messages = (await client.read(0)).messages;
    const later = await client.apply(messages[1]);
    assert.equal(later.phase, "queued");
    assert.equal(later.waiting_for, messages[0].reply_command_id);
    assert.equal(later.result_reason, "earlier_input_pending");
    assert.equal(await f.effects(), 0);
    assert.equal((await client.apply(messages[0])).phase, "succeeded");
    assert.equal((await client.apply(messages[1])).phase, "succeeded");
    assert.equal(await f.effects(), 2);
    assert.equal((await client.apply(messages[1])).phase, "succeeded");
    assert.equal(
      await f.effects(),
      2,
      "A duplicate late apply never sends twice",
    );
    const decision = await f.ask("Q3", client);
    await f.answer("Q3");
    await f.ask("Q4", client);
    await f.answer("Q4");
    const pending = (await client.read(messages[1].sequence)).messages,
      attempt = begin();
    await client.ack(pending[0].reply_command_id, "read");
    assert.equal(
      (await client.ack(pending[0].reply_command_id, "begin", attempt)).claimed,
      true,
    );
    let blocked = await client.apply(pending[1]);
    assert.equal(blocked.phase, "queued");
    assert.equal(blocked.result_reason, "target_input_active");
    await client.ack(pending[0].reply_command_id, "unknown", {
      attempt_id: attempt.attempt_id,
    });
    assert.equal(
      (
        await f.post(
          "update/question",
          {
            id: "Q3",
            action: "revise",
            expected_revision: 1,
            question: "条件を変更したので確認してください",
            decision: {
              ...decision,
              target: { ...decision.target, revision: "input-v2" },
            },
          },
          "mcp",
        )
      ).status,
      200,
    );
    blocked = await client.apply(pending[1]);
    assert.equal(blocked.phase, "queued");
    assert.equal(blocked.result_reason, "earlier_result_unknown");
    const output = await client.poll();
    assert.equal(output.blocked, true);
    assert.equal(
      await f.effects(),
      2,
      "A revised question cannot authorize bypassing an uncertain native effect",
    );
  },
);

test(
  "saved, webhook delivered, cursor GET, target read, begin and correlated ACP result stay separate",
  options,
  async (t) => {
    const f = await setup(t, true),
      attached = await f.attach(),
      client = await f.client(attached);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1"),
      original = structuredClone(saved);
    for (
      let i = 0;
      i < 40 && !command(await f.state(), saved).delivery.length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    let state = await f.state();
    assert.equal(command(state, saved).phase, "saved");
    assert.equal(command(state, saved).delivery[0].status, "delivered");
    const revision = state.revision;
    assert.equal(
      (await client.read(0)).messages[0].reply_command_id,
      saved.reply_command_id,
    );
    assert.equal(
      feedbackSince(f.server.store.value, 0).messages[0].reply_command_id,
      saved.reply_command_id,
    );
    assert.equal((await f.state()).revision, revision);
    assert.equal(command(await f.state(), saved).read_at, null);
    await client.ack(saved.reply_command_id, "read");
    assert.equal(command(await f.state(), saved).phase, "read");
    const claim = begin();
    assert.equal(
      (await client.ack(saved.reply_command_id, "begin", claim)).claimed,
      true,
    );
    state = await f.state();
    assert.equal(command(state, saved).phase, "started");
    assert.equal(await f.effects(), 0);
    await attached.adapter.send(
      attached.record.cli_session_id,
      replyPrompt(saved, client.consumer),
      { command_id: claim.native_command_id },
    );
    assert.equal(
      (await client.ack(saved.reply_command_id, "reconcile")).command.phase,
      "succeeded",
    );
    assert.equal(await f.effects(), 1);
    assert.deepEqual(f.server.store.value.feedback[0], original);
    const reopened = await ProjectStore.open(f.project);
    assert.equal(
      command(publicState(reopened.value), saved).phase,
      "succeeded",
    );
    const bytes = await fs.readFile(
      path.join(f.project.directory, "state.json"),
      "utf8",
    );
    assert.ok(
      !bytes.includes(client.token) &&
        !bytes.includes("fixture-secret-must-not-be-saved"),
    );
  },
);

test(
  "an invalidated input may reconcile its already-issued native result without replaying or changing the new question",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach(),
      client = await f.client(attached);
    const decision = await f.ask("Q1", client);
    await f.answer("Q1");
    await f.ask("Q2", client);
    await f.answer("Q2");
    const messages = (await client.read(0)).messages,
      attempt = begin();
    await client.ack(messages[0].reply_command_id, "read");
    assert.equal(
      (await client.ack(messages[0].reply_command_id, "begin", attempt))
        .claimed,
      true,
    );
    await attached.adapter.send(
      client.consumer.session_id,
      replyPrompt(messages[0], client.consumer),
      { command_id: attempt.native_command_id },
    );
    await client.ack(messages[0].reply_command_id, "unknown", {
      attempt_id: attempt.attempt_id,
    });
    assert.equal(
      (
        await f.post(
          "update/question",
          {
            id: "Q1",
            action: "revise",
            expected_revision: 1,
            question: "変更した対象を再確認してください",
            decision: {
              ...decision,
              target: { ...decision.target, revision: "input-v2" },
            },
          },
          "mcp",
        )
      ).status,
      200,
    );
    const current = (await client.read(0)).messages;
    assert.equal(current[0].contract_validity, "invalidated");
    const reconciliation = await client.apply(current[0]);
    assert.equal(reconciliation.phase, "invalidated");
    assert.equal(command(await f.state(), messages[0]).phase, "succeeded");
    assert.equal(
      f.server.store.value.questions.find((q) => q.id === "Q1").answer,
      null,
    );
    assert.equal((await client.apply(current[1])).phase, "succeeded");
    assert.equal(await f.effects(), 2);
    assert.equal(
      (await f.trace()).filter((event) => event.method === "session/prompt")
        .length,
      2,
    );
  },
);

test(
  "concurrent readers, old cursor rereads and duplicate begin IDs cannot repeat a native effect",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach(),
      client = await f.client(attached);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1"),
      message = (await client.read(0)).messages[0];
    const results = await Promise.all([
      client.apply(message),
      client.apply(message),
    ]);
    assert.ok(results.some((result) => result.phase === "succeeded"));
    assert.equal(await f.effects(), 1);
    const oldCursor = (await client.read(0)).messages[0];
    assert.equal((await client.apply(oldCursor)).phase, "succeeded");
    const stored = command(await f.state(), saved);
    assert.equal(
      (
        await client.ack(saved.reply_command_id, "begin", {
          attempt_id: stored.attempt_id,
          native_command_id: stored.native_command_id,
        })
      ).claimed,
      false,
    );
    assert.equal(await f.effects(), 1);
    assert.equal(
      (await f.trace()).filter((event) => event.method === "session/prompt")
        .length,
      1,
    );
    const tracePrompt = (await f.trace()).find(
      (event) => event.method === "session/prompt",
    ).params.prompt[0].text;
    const sent = JSON.parse(tracePrompt.slice(tracePrompt.indexOf("\n") + 1));
    assert.deepEqual(sent.decision, saved.decision);
    assert.equal(sent.contract_fingerprint, saved.contract_fingerprint);
    assert.equal(sent.execution_authorized, false);
  },
);

test(
  "stopped consumer retains its answer; explicit same-session resume rotates credentials and applies once",
  options,
  async (t) => {
    const f = await setup(t),
      first = await f.attach(),
      originalClient = await f.client(first);
    await f.ask("Q1", originalClient);
    const saved = await f.answer("Q1");
    await first.adapter.stop();
    assert.equal(
      (await originalClient.read(0)).messages[0].answer,
      saved.answer,
    );
    await assert.rejects(
      originalClient.ack(saved.reply_command_id, "read"),
      /unavailable/,
    );
    assert.equal(command(await f.state(), saved).display_phase, "unapplied");
    const resumed = await f.attach("reply_effect", first.record.run_id),
      client = await f.client(resumed);
    assert.equal(
      client.consumer.consumer_id,
      originalClient.consumer.consumer_id,
    );
    assert.equal(client.consumer.session_id, first.record.cli_session_id);
    await assert.rejects(
      originalClient.ack(saved.reply_command_id, "read"),
      (error) => error.status === 401,
    );
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "succeeded",
    );
    await resumed.adapter.stop();
    const again = await f.attach("reply_effect", first.record.run_id),
      againClient = await f.client(again);
    assert.equal(
      (await againClient.apply((await againClient.read(0)).messages[0])).phase,
      "succeeded",
    );
    assert.equal(await f.effects(), 1);
    assert.deepEqual(
      (await f.trace())
        .filter((event) => event.method === "session/resume")
        .map((event) => event.params.sessionId),
      [first.record.cli_session_id, first.record.cli_session_id],
    );
  },
);

test(
  "effect followed by native result loss stays unknown after explicit reconnect and never replays",
  options,
  async (t) => {
    const f = await setup(t),
      first = await f.attach("reply_effect_lost"),
      client = await f.client(first);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "unknown",
    );
    assert.equal(await f.effects(), 1);
    await first.adapter.stop();
    assert.equal(command(await f.state(), saved).display_phase, "unknown");
    const resumed = await f.attach("reply_effect", first.record.run_id),
      resumedClient = await f.client(resumed);
    const result = await resumedClient.apply(
      (await resumedClient.read(0)).messages[0],
    );
    assert.equal(result.phase, "unknown");
    assert.equal(await f.effects(), 1);
    assert.equal(
      (await f.trace()).filter((event) => event.method === "session/prompt")
        .length,
      1,
    );
  },
);

test(
  "dashboard restart and missing application ack reconcile an existing native result without another send",
  options,
  async (t) => {
    const f = await setup(t),
      first = await f.attach();
    const client = await f.client(first, async (url, init) => {
      if (url.endsWith("/ack") && JSON.parse(init.body).phase === "reconcile")
        throw new Error("fixture result ack lost before delivery");
      return fetch(url, init);
    });
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "unknown",
    );
    assert.equal(command(await f.state(), saved).phase, "started");
    assert.equal(await f.effects(), 1);
    await first.adapter.stop();
    await f.server.close();
    await f.start();
    await assert.rejects(client.ack(saved.reply_command_id, "reconcile"));
    const resumed = await f.attach("reply_effect", first.record.run_id),
      resumedClient = await f.client(resumed);
    assert.equal(
      (await resumedClient.apply((await resumedClient.read(0)).messages[0]))
        .phase,
      "succeeded",
    );
    assert.equal(await f.effects(), 1);
    const history = await resumed.history.read();
    assert.equal(
      [...history.commands.values()].filter((item) => item.operation === "send")
        .length,
      1,
    );
  },
);

test(
  "lost begin response commits a claim but performs zero sends and remains blocked on reread",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach();
    const client = await f.client(attached, async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith("/ack") && JSON.parse(init.body).phase === "begin")
        throw new Error("fixture begin response lost after commit");
      return response;
    });
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "unknown",
    );
    assert.equal(command(await f.state(), saved).phase, "unknown");
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "unknown",
    );
    assert.equal(await f.effects(), 0);
  },
);

test(
  "wrong consumer/run, forged success, project MCP/admin/browser and ended-session acks fail closed",
  options,
  async (t) => {
    const f = await setup(t),
      first = await f.attach(),
      second = await f.attach();
    const client = await f.client(first),
      wrong = await f.client(second);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    assert.notEqual(client.consumer.run_id, wrong.consumer.run_id);
    assert.equal((await wrong.read(0)).messages.length, 0);
    await assert.rejects(
      wrong.ack(saved.reply_command_id, "read"),
      /different consumer/,
    );
    assert.equal(
      (
        await f.post(
          "replies/ack",
          {
            consumer_id: wrong.consumer.consumer_id,
            command_id: saved.reply_command_id,
            phase: "read",
          },
          { "x-rdsh-consumer-token": client.token },
        )
      ).status,
      401,
    );
    for (const credential of ["human", "admin", "mcp"])
      assert.ok(
        [401, 403].includes(
          (
            await f.post(
              "replies/ack",
              {
                consumer_id: client.consumer.consumer_id,
                command_id: saved.reply_command_id,
                phase: "read",
              },
              credential,
            )
          ).status,
        ),
      );
    for (const credential of ["human", "mcp"])
      assert.ok(
        [401, 403].includes(
          (
            await f.post(
              "replies/register",
              {
                run_id: first.record.run_id,
                session_id: first.record.cli_session_id,
                owner_id: first.history.owner_id,
              },
              credential,
            )
          ).status,
        ),
      );
    assert.equal(
      (
        await f.post(
          "replies/register",
          {
            run_id: first.record.run_id,
            session_id: first.record.cli_session_id,
            owner_id: second.history.owner_id,
          },
          "admin",
        )
      ).status,
      409,
    );
    const before = await fs.readFile(
      path.join(f.project.directory, "state.json"),
    );
    await assert.rejects(
      client.ack(saved.reply_command_id, "succeeded"),
      /Unknown acknowledgement/,
    );
    await assert.rejects(
      client.ack(saved.reply_command_id, "read", {
        execution_authorized: true,
      }),
      /Unknown answer/,
    );
    assert.equal(
      (await f.post("update/application", { phase: "succeeded" }, "admin"))
        .status,
      404,
    );
    assert.equal(
      (
        await f.post(
          "replies/ack",
          {
            consumer_id: client.consumer.consumer_id,
            command_id: saved.reply_command_id,
            phase: "read",
          },
          { "x-rdsh-consumer-token": client.token },
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.deepEqual(
      await fs.readFile(path.join(f.project.directory, "state.json")),
      before,
    );
    assert.equal(command(await f.state(), saved).phase, "saved");
    assert.equal(await f.effects(), 0);
  },
);

test(
  "revision changes, cancellation and expiry retain original replies but forbid current application",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach(),
      client = await f.client(attached);
    const decision = await f.ask("Q1", client),
      saved = await f.answer("Q1");
    assert.equal(
      (
        await f.post(
          "update/question",
          {
            id: "Q1",
            question: "改訂した入力",
            action: "revise",
            expected_revision: 1,
            decision: {
              ...decision,
              target: { ...decision.target, revision: "input-v2" },
            },
          },
          "mcp",
        )
      ).status,
      200,
    );
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "invalidated",
    );
    assert.equal(
      (
        await f.post(
          "update/question",
          {
            id: "Q1",
            question: saved.question,
            action: "revise",
            expected_revision: 2,
            decision,
          },
          "mcp",
        )
      ).status,
      200,
    );
    assert.equal(
      f.server.store.value.question_contracts.cards.Q1.fingerprint,
      saved.contract_fingerprint,
    );
    const restored = await f.answer("Q1", "最新版の判断だけを対象へ渡す");
    const restoredMessages = (await client.read(0)).messages;
    assert.equal(
      (
        await client.apply(
          restoredMessages.find((item) => item.sequence === saved.sequence),
        )
      ).phase,
      "invalidated",
    );
    assert.equal(
      (
        await client.apply(
          restoredMessages.find((item) => item.sequence === restored.sequence),
        )
      ).phase,
      "succeeded",
    );
    await f.ask("Q2", client);
    await f.answer("Q2");
    assert.equal(
      (
        await f.post("decision/cancel", {
          id: "Q2",
          expected_revision: 1,
          cancel_reason: "対象を取り消しました",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await client.apply(
          (await client.read(0)).messages.find(
            (item) => item.question_id === "Q2",
          ),
        )
      ).phase,
      "invalidated",
    );
    await f.ask("Q3", client, {
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    await f.answer("Q3");
    const future = Date.now() + 120000;
    t.mock.method(Date, "now", () => future);
    assert.equal(
      (
        await client.apply(
          (await client.read(0)).messages.find(
            (item) => item.question_id === "Q3",
          ),
        )
      ).phase,
      "invalidated",
    );
    t.mock.restoreAll();
    assert.equal(command(await f.state(), saved).display_phase, "invalidated");
    assert.equal(await f.effects(), 1);
    assert.deepEqual(f.server.store.value.feedback[0], saved);
    const nativeInputs = (await f.trace()).filter(
      (event) => event.method === "session/prompt",
    );
    assert.equal(nativeInputs.length, 1);
    assert.ok(
      nativeInputs[0].params.prompt[0].text.includes('"contract_revision":3'),
    );
  },
);

test(
  "a correlated native refusal is shown as failed input processing, never successful application",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach("reply_refusal"),
      client = await f.client(attached);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    assert.equal(
      (await client.apply((await client.read(0)).messages[0])).phase,
      "failed",
    );
    assert.equal(
      command(await f.state(), saved).result_reason,
      "native_prompt_refused",
    );
    assert.equal(await f.effects(), 1);
  },
);

test(
  "an acknowledged native command with different input cannot confirm application of the saved answer",
  options,
  async (t) => {
    const f = await setup(t),
      attached = await f.attach(),
      client = await f.client(attached);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    await client.ack(saved.reply_command_id, "read");
    const claim = begin();
    await client.ack(saved.reply_command_id, "begin", claim);
    await attached.adapter.send(
      attached.record.cli_session_id,
      "a different input",
      { command_id: claim.native_command_id },
    );
    assert.equal(
      (await client.ack(saved.reply_command_id, "reconcile")).command.phase,
      "started",
    );
    await attached.adapter.stop();
    assert.equal(command(await f.state(), saved).display_phase, "unknown");
    assert.equal(await f.effects(), 1);
  },
);

test("unknown/corrupt application schemas preserve the original file and legacy unbound questions stay compatible", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-reply-schema-"));
  t.after(() => fs.rm(root, { recursive: true }));
  const project = { id: "fixture", name: "fixture", root, directory: root };
  const store = await ProjectStore.open(project);
  await store.mutate("question", { id: "legacy", question: "相談" });
  await store.mutate("answer", { id: "legacy", answer: "返答" });
  assert.equal(store.value.answer_applications, undefined);
  assert.equal(store.value.feedback[0].reply_command_id, undefined);
  const record = {
    run_id: "run_" + randomUUID(),
    cli_session_id: "fixture-native",
    task_id: "T1",
  };
  const consumer = await store.mutateReply("register", record);
  await store.mutate("question", {
    id: "typed",
    question: "対象へ返答",
    decision: {
      kind: "consultation",
      consumer_id: consumer.consumer_id,
      target: {
        run_id: record.run_id,
        session_id: record.cli_session_id,
        revision: "v1",
      },
    },
  });
  const card = store.value.question_contracts.cards.typed;
  await store.mutate("answer", {
    id: "typed",
    answer: "返答",
    expected_revision: 1,
    contract_fingerprint: card.fingerprint,
  });
  const valid = structuredClone(store.value),
    file = path.join(root, "state.json");
  for (const variant of [
    "schema",
    "binding",
    "command",
    "missing",
    "timestamp",
    "registry",
    "input",
  ]) {
    const next = structuredClone(valid),
      item = Object.values(next.answer_applications.commands)[0];
    if (variant === "schema") next.answer_applications.schema = 2;
    if (variant === "binding") item.session_id = "another-native-session";
    if (variant === "command") item.phase = "succeeded";
    if (variant === "missing") next.answer_applications.commands = {};
    if (variant === "timestamp") item.saved_at = "invalid";
    if (variant === "registry") delete next.answer_applications;
    if (variant === "input") item.input_hash = "0".repeat(64);
    const bytes = JSON.stringify(next);
    await fs.writeFile(file, bytes);
    await assert.rejects(ProjectStore.open(project));
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
});

test(
  "public CLI once resumes the exact session, applies once, and inspection never launches another prompt",
  options,
  async (t) => {
    const f = await setup(t),
      first = await f.attach(),
      client = await f.client(first);
    await f.ask("Q1", client);
    const saved = await f.answer("Q1");
    await first.adapter.stop();
    const args = [
      cli,
      "reply-consumer",
      "once",
      "--project",
      f.project.root,
      "--run-id",
      first.record.run_id,
      "--executable",
      process.execPath,
      "--entrypoint",
      fixture,
    ];
    for (let i = 0; i < 2; i++) {
      const output = await exec(process.execPath, args, {
        env: f.env,
        windowsHide: true,
        timeout: 60000,
      });
      assert.ok(output.stdout.includes('"phase":"succeeded"'));
      assert.ok(!output.stdout.includes(client.token));
    }
    assert.equal(await f.effects(), 1);
    const output = await exec(
      process.execPath,
      [
        cli,
        "reply-consumer",
        "inspect",
        "--project",
        f.project.root,
        "--command-id",
        saved.reply_command_id,
      ],
      { env: f.env, windowsHide: true, timeout: 15000 },
    );
    const inspected = JSON.parse(output.stdout);
    assert.equal(inspected.mode, "read_only");
    assert.equal(inspected.commands.length, 1);
    assert.equal(inspected.commands[0].phase, "succeeded");
    await assert.rejects(
      exec(
        process.execPath,
        [
          cli,
          "reply-consumer",
          "once",
          "--project",
          f.project.root,
          "--run-id",
          first.record.run_id,
          "--entrypoint",
          fixture,
        ],
        { env: f.env, windowsHide: true, timeout: 15000 },
      ),
      (error) =>
        error.stderr.includes("entrypoint requires the original executable"),
    );
    assert.equal(
      (await f.trace()).filter((event) => event.method === "session/prompt")
        .length,
      1,
    );
  },
);
