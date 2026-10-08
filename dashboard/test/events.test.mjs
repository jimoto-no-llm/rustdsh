import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { EventsHub, isPublicAddress, validateCallback } from "../webhooks.mjs";
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { startDashboard } from "../server.mjs";
import { identity } from "../state.mjs";
import net from "node:net";

test("callback addresses block private destinations, IP mappings, and credential URLs", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.100.100.100",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  const publicLookup = async () => [{ address: "1.1.1.1", family: 4 }];
  await validateCallback("https://receiver.example/events", publicLookup);
  await assert.rejects(
    () =>
      validateCallback("https://receiver.example/events", async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    /public/,
  );
  await assert.rejects(
    () =>
      validateCallback(
        "https://user:pass@receiver.example/events",
        publicLookup,
      ),
    /credentials/,
  );
  await assert.rejects(
    () => validateCallback("http://receiver.example/events", publicLookup),
    /HTTPS/,
  );
});
test("webhooks verify, persist, deduplicate subscriptions, retain event ids, and stop on 410", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-events-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = { id: "test-project", directory },
    state = { revision: 0, changes: [] },
    deliveries = [];
  const secret = "whsec_" + randomBytes(32).toString("base64");
  let fail = false,
    gone = false;
  const post = async (url, headers, body) => {
    const event = new Webhook(secret).verify(body, headers);
    deliveries.push({ headers, event });
    if (event.type === "verification")
      return {
        status: 200,
        body: JSON.stringify({ challenge: event.challenge }),
      };
    return { status: gone ? 410 : fail ? 503 : 204, body: "" };
  };
  let hub = await EventsHub.open(project, () => state, post);
  const subscription = {
    name: "dashboard.answer.created",
    arguments: { project_id: project.id },
    delivery: {
      mode: "webhook",
      url: "https://receiver.example/events",
      secret,
    },
    ttlMs: 60000,
  };
  const first = await hub.subscribe(subscription),
    second = await hub.subscribe(subscription);
  assert.equal(first.id, second.id);
  assert.equal(hub.status().active, 1);
  assert.equal(
    deliveries.filter((item) => item.event.type === "verification").length,
    1,
  );
  state.revision = 1;
  state.changes.push({
    eventId: "evt_test_1",
    name: subscription.name,
    timestamp: new Date().toISOString(),
    data: {
      project_id: project.id,
      revision: 1,
      entity_id: "Q1",
      summary: "A test reply",
    },
    cursor: null,
  });
  fail = true;
  await hub.flush();
  assert.equal(hub.diagnostics().callback.reason, "http_5xx");
  assert.ok(hub.diagnostics().callback.last_failure);
  assert.equal(hub.diagnostics().verification.state, "observed");
  assert.equal(hub.subscriptions[0].last_revision, 0);
  hub = await EventsHub.open(project, () => state, post);
  hub.subscriptions[0].next_attempt = 0;
  fail = false;
  await hub.flush();
  assert.equal(hub.diagnostics().callback.state, "observed");
  assert.ok(hub.diagnostics().callback.last_success);
  assert.ok(hub.diagnostics().callback.last_failure);
  assert.equal(hub.subscriptions[0].last_revision, 1);
  assert.equal(
    deliveries.at(-1).headers["webhook-id"],
    deliveries.at(-2).headers["webhook-id"],
  );
  state.revision = 2;
  state.changes.push({
    ...state.changes[0],
    eventId: "evt_test_2",
    data: { ...state.changes[0].data, revision: 2 },
  });
  gone = true;
  await hub.flush();
  assert.equal(hub.status().active, 0);
  assert.equal(hub.diagnostics().subscriptions.expired, 1);
  assert.equal(hub.diagnostics().callback.reason, "http_4xx");
  await hub.unsubscribe(subscription);
  await hub.unsubscribe(subscription);
  assert.equal(hub.subscriptions.length, 0);
  await assert.rejects(
    () =>
      hub.subscribe({ ...subscription, arguments: { project_id: "other" } }),
    /unauthorized/,
  );
  const bad = await EventsHub.open(
    project,
    () => state,
    async () => ({ status: 200, body: '{"challenge":"wrong"}' }),
  );
  await assert.rejects(
    () => bad.subscribe(subscription),
    (error) => error.code === -32015,
  );
  assert.equal(bad.subscriptions.length, 0);
  assert.equal(bad.diagnostics().verification.reason, "challenge_failed");
  assert.equal(
    (await EventsHub.open(project, () => state, post)).diagnostics()
      .verification.state,
    "failed",
  );
  await hub.subscribe(subscription);
  await hub.revoke();
  assert.equal(hub.status().active, 0);
});
test("MCP 2.0 discovers events and serves the same tools on an authenticated endpoint", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-mcp2-test-")),
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(directory, "state");
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previous) process.env.RDSH_DASHBOARD_HOME = previous;
    else delete process.env.RDSH_DASHBOARD_HOME;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const project = await identity(directory),
    secret = "whsec_" + randomBytes(32).toString("base64"),
    delivered = [];
  const webhookPost = async (url, headers, body) => {
    const event = new Webhook(secret).verify(body, headers);
    if (event.type === "verification")
      return {
        status: 200,
        body: JSON.stringify({
          challenge: url.includes("bad") ? "incorrect" : event.challenge,
        }),
      };
    delivered.push(event);
    return { status: 204, body: "" };
  };
  dashboard = await startDashboard({
    project,
    port,
    tailscale: false,
    webhookPost,
  });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  async function request(method, params = {}, errorCode = null) {
    const _meta = {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_INFO_META_KEY]: { name: "mcp2-test", version: "1.0.0" },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const response = await fetch(dashboard.localUrl + "mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + runtime.mcp_token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(params.name ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    if (errorCode !== null) {
      assert.equal(result.error?.code, errorCode, JSON.stringify(result));
      return result.error;
    }
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result.result;
  }
  const discovery = await request("server/discover");
  assert.ok(discovery.supportedVersions.includes("2026-07-28"));
  assert.deepEqual(discovery.capabilities.events, {});
  assert.equal((await request("events/list")).events.length, 5);
  assert.equal((await request("tools/list")).tools.length, 6);
  const diagnostics = async () =>
    (
      await fetch(dashboard.localUrl + "api/diagnostics", {
        headers: { authorization: "Bearer " + runtime.token },
      })
    ).json();
  const discovered = await diagnostics();
  for (const stage of ["discovery", "tools", "events"])
    assert.equal(discovered.dot[stage].state, "observed", stage);
  assert.equal(discovered.dot.response.state, "unconfirmed");
  assert.equal(discovered.end_to_end.state, "unconfirmed");
  const result = await request("tools/call", {
    name: "dashboard_upsert_task",
    arguments: { id: "T1", title: "MCP 2 test", status: "todo" },
  });
  assert.equal(result.resultType, "complete");
  assert.equal(dashboard.store.value.tasks.length, 1);
  const subscription = {
    name: "dashboard.answer.created",
    arguments: { project_id: project.id },
    delivery: {
      mode: "webhook",
      url: "https://receiver.example/events",
      secret,
    },
    ttlMs: 60000,
  };
  assert.ok((await request("events/subscribe", subscription)).id);
  const failure = await request(
    "events/subscribe",
    {
      ...subscription,
      delivery: {
        ...subscription.delivery,
        url: "https://receiver.example/bad",
      },
    },
    -32015,
  );
  assert.equal(failure.data.reason, "challenge_failed");
  assert.equal(
    (await diagnostics()).dot.verification.reason,
    "challenge_failed",
  );
  await request(
    "events/subscribe",
    { ...subscription, arguments: { project_id: "other-project" } },
    -32602,
  );
  await request("tools/call", {
    name: "dashboard_ask_question",
    arguments: { id: "Q1", question: "Reply through the dashboard" },
  });
  await dashboard.mutate("answer", { id: "Q1", answer: "Ready" });
  // Flush is serialized with the automatic mutation-triggered delivery.
  await new Promise((resolve) => setImmediate(resolve));
  await dashboard.close();
  // Read persisted observations after the serialized signed delivery has completed.
  const persistedHub = await EventsHub.open(
    project,
    () => dashboard.store.value,
    webhookPost,
  );
  const eventsDiagnostic = persistedHub.diagnostics();
  assert.equal(eventsDiagnostic.callback.state, "observed");
  assert.equal(eventsDiagnostic.subscriptions.active, 1);
  const copy = JSON.stringify(eventsDiagnostic);
  for (const sensitive of [
    secret,
    "receiver.example",
    runtime.token,
    runtime.mcp_token,
  ])
    assert.ok(!copy.includes(sensitive));
  dashboard = null;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data.entity_id, "Q1");
  assert.equal(delivered[0].data.summary, "Ready");
  dashboard = await startDashboard({
    project,
    port,
    tailscale: false,
    webhookPost,
  });
  runtime.mcp_token = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  ).mcp_token;
  await request("events/unsubscribe", subscription);
  await request("events/unsubscribe", subscription);
});
