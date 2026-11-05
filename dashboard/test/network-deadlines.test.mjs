import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventsHub, publicWebhookPost } from "../webhooks.mjs";
import { executeSandboxedOperation } from "../worker-sandbox.mjs";

const addresses = [{ address: "93.184.216.34", family: 4 }];
const turn = () => new Promise(setImmediate);

function observe(promise) {
  const result = {};
  result.settled = promise.then(
    (value) => { result.value = value; },
    (error) => { result.error = error; },
  );
  return result;
}

function transport(t) {
  const started = Promise.withResolvers();
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { "content-type": "text/plain" };
  const request = new EventEmitter();
  const fixture = { request, response, started: started.promise, destroyed: false, body: "" };
  request.setTimeout = () => request;
  request.write = (body) => { fixture.body += body; };
  request.destroy = (error) => {
    if (fixture.destroyed) return;
    fixture.destroyed = true;
    request.emit("error", error || new Error("test_cleanup"));
  };
  fixture.create = (options, callback) => {
    fixture.options = options;
    options.signal?.addEventListener("abort", () => request.destroy(options.signal.reason), { once: true });
    request.end = (body) => {
      if (body) request.write(body);
      callback(response);
      started.resolve();
    };
    return request;
  };
  t.after(() => request.destroy());
  return fixture;
}

async function worker(t, networkOptions) {
  const repository = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-network-deadline-")));
  t.after(() => fs.rm(repository, { recursive: true, force: true }));
  return observe(executeSandboxedOperation({
    repository,
    contract: {
      repository,
      worker_roles: ["implementation"],
      operation_policy: { network_origins: ["https://allowed.example"] },
    },
    workerRole: "implementation",
    input: {
      schema: "rdsh.operation.v1",
      tool_name: "network.request",
      tool_input: { cwd: repository, url: "https://allowed.example/operation", method: "POST", body: "send once" },
    },
    capability: { supported: true },
    networkOptions,
  }));
}

test("callback DNS has a total deadline and late resolution cannot send a request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resolution = Promise.withResolvers();
  t.mock.method(dns, "lookup", () => resolution.promise);
  let requests = 0;
  t.mock.method(https, "request", () => { requests++; throw new Error("unexpected_request"); });
  const result = observe(publicWebhookPost("https://receiver.example/events", {}, "{}"));
  try {
    t.mock.timers.tick(9999);
    await turn();
    assert.equal(result.error, undefined);
    t.mock.timers.tick(1);
    await turn();
    assert.equal(result.error?.message, "Callback timeout");
  } finally {
    resolution.resolve(addresses);
    await result.settled;
    await turn();
  }
  assert.equal(requests, 0);
});

test("callback response activity cannot extend the deadline consumed by DNS", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resolution = Promise.withResolvers();
  t.mock.method(dns, "lookup", () => resolution.promise);
  const connection = transport(t);
  t.mock.method(https, "request", (_url, options, callback) => connection.create(options, callback));
  const result = observe(publicWebhookPost("https://receiver.example/events", {}, "{}"));
  t.mock.timers.tick(4000);
  resolution.resolve(addresses);
  await connection.started;
  for (let second = 0; second < 5; second++) {
    t.mock.timers.tick(1000);
    connection.response.emit("data", Buffer.from("x"));
    await turn();
    assert.equal(result.error, undefined);
  }
  t.mock.timers.tick(1000);
  await turn();
  assert.equal(result.error?.message, "Callback timeout");
  assert.equal(connection.destroyed, true);
});

test("successful callbacks retain address pinning and cancel their deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(dns, "lookup", async () => addresses);
  const connection = transport(t);
  t.mock.method(https, "request", (url, options, callback) => {
    assert.equal(url.hostname, "receiver.example");
    return connection.create(options, callback);
  });
  const result = observe(publicWebhookPost("https://receiver.example/events", {}, "{}"));
  await connection.started;
  connection.options.lookup("receiver.example", { all: true }, (error, selected) => {
    assert.equal(error, null);
    assert.deepEqual(selected, addresses);
  });
  connection.response.emit("data", Buffer.from("accepted"));
  connection.response.emit("end");
  await result.settled;
  assert.deepEqual(result.value, { status: 200, body: "accepted" });
  t.mock.timers.tick(10000);
  assert.equal(connection.destroyed, false);
  assert.equal(connection.options.signal.aborted, false);
});

test("a callback DNS timeout releases queued subscription revocation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-callback-deadline-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers();
  const resolution = Promise.withResolvers();
  t.mock.method(dns, "lookup", () => { entered.resolve(); return resolution.promise; });
  t.mock.method(https, "request", () => { throw new Error("unexpected_request"); });
  const hub = new EventsHub({ id: "project", directory }, () => ({ revision: 0 }));
  const result = observe(hub.subscribe({
    name: "dashboard.answer.created",
    arguments: { project_id: "project" },
    delivery: { mode: "webhook", url: "https://receiver.example/events", secret: "whsec_" + Buffer.alloc(32, 1).toString("base64") },
  }));
  await entered.promise;
  const revoke = hub.revoke();
  try {
    t.mock.timers.tick(10000);
    await turn();
    assert.equal(hub.diagnostics().verification.reason, "timeout");
  } finally {
    resolution.resolve(addresses);
    await result.settled;
    await revoke;
  }
  assert.equal(result.error?.data.reason, "timeout");
  assert.equal(hub.status().active, 0);
});

test("worker DNS timeout reports not_started and suppresses late requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers();
  const resolution = Promise.withResolvers();
  let requests = 0;
  const result = await worker(t, {
    resolve: () => { entered.resolve(); return resolution.promise; },
    request: () => { requests++; throw new Error("unexpected_request"); },
  });
  await entered.promise;
  try {
    t.mock.timers.tick(10000);
    await turn();
    assert.deepEqual(result.value, { execution: "not_started", reason: "network_request_timed_out" });
  } finally {
    resolution.resolve(addresses);
    await result.settled;
    await turn();
  }
  assert.equal(requests, 0);
});

test("worker response activity cannot prevent cancellation or claim no execution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connection = transport(t);
  const result = await worker(t, { resolve: async () => addresses, request: connection.create });
  await connection.started;
  assert.equal(connection.body, "send once");
  for (let second = 0; second < 9; second++) {
    t.mock.timers.tick(1000);
    connection.response.emit("data", Buffer.from("x"));
    await turn();
    assert.equal(result.value, undefined);
  }
  t.mock.timers.tick(1000);
  await turn();
  assert.deepEqual(result.value, { execution: "unknown", reason: "network_request_timed_out" });
  assert.equal(connection.destroyed, true);
});

test("successful worker requests cancel their deadline without changing the result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connection = transport(t);
  const result = await worker(t, { resolve: async () => addresses, request: connection.create });
  await connection.started;
  connection.response.emit("data", Buffer.from("approved response"));
  connection.response.emit("end");
  await result.settled;
  assert.deepEqual(result.value, {
    execution: "completed", status: 200, content_type: "text/plain", body: "approved response",
  });
  t.mock.timers.tick(10000);
  assert.equal(connection.destroyed, false);
  assert.equal(connection.options.signal.aborted, false);
});
