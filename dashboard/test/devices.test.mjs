import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { identity } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function jsonResponse(response) {
  return response.json();
}

test("device permissions are scoped, persistent, and revoked connections close", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-device-access-"),
  );
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
    else delete process.env.RDSH_DASHBOARD_HOME;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  const project = await identity(root);
  dashboard = await startDashboard({
    project,
    port: await freePort(),
    tailscale: false,
  });
  const ownerRuntime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const ownerToken = new URL(ownerRuntime.browser_url).hash.slice("#key=".length);
  const ownerHeaders = {
    "x-rdsh-browser-token": ownerToken,
    "content-type": "application/json",
  };
  await dashboard.store.mutate("question", {
    id: "Q1",
    question: "Can this device answer?",
  });

  async function createDevice(name, capabilities = ["read"]) {
    const response = await fetch(dashboard.localUrl + "api/devices", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name, capabilities }),
    });
    assert.equal(response.status, 201);
    return jsonResponse(response);
  }

  const viewer = await createDevice("phone-read-only");
  const responder = await createDevice("phone-reply", ["read", "reply"]);
  const controller = await createDevice("phone-control", ["read", "control"]);
  assert.match(viewer.credential, /^rdsh_dev_[a-f0-9]{64}$/);
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/devices", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ name: "invalid", capabilities: ["control"] }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/instructions/submit", {
        method: "POST",
        headers: {
          "x-rdsh-browser-token": controller.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/update/answer", {
        method: "POST",
        headers: {
          "x-rdsh-browser-token": controller.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "Q1", answer: "not granted" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/managed-stop", {
        method: "POST",
        headers: { ...ownerHeaders, "x-rdsh-browser-token": controller.credential },
        body: "{}",
      })
    ).status,
    403,
  );
  const deviceFile = await fs.readFile(
    path.join(project.directory, "devices.json"),
    "utf8",
  );
  assert.equal(deviceFile.includes(viewer.credential), false);
  assert.match(deviceFile, /"token_hash"/);

  const viewerHeaders = { "x-rdsh-browser-token": viewer.credential };
  const viewState = await fetch(dashboard.localUrl + "api/state", {
    headers: viewerHeaders,
  });
  assert.equal(viewState.status, 200);
  assert.equal((await jsonResponse(viewState)).questions[0].id, "Q1");
  const viewerConfig = await fetch(dashboard.localUrl + "api/config", {
    headers: viewerHeaders,
  });
  assert.deepEqual((await jsonResponse(viewerConfig)).device_access, {
    role: "device",
    device_id: viewer.device.id,
    name: "phone-read-only",
    capabilities: ["read"],
  });
  for (const [route, method, body] of [
    ["update/answer", "POST", { id: "Q1", answer: "no" }],
    ["instructions/submit", "POST", { text: "run this" }],
    ["managed-stop", "POST", {}],
    ["devices", "POST", { name: "escalation", capabilities: ["read"] }],
    ["qr.svg", "GET"],
  ]) {
    const response = await fetch(dashboard.localUrl + "api/" + route, {
      method,
      headers: viewerHeaders,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 403, `${method} ${route}`);
  }

  const stream = await fetch(
    dashboard.localUrl + "api/live?key=" + encodeURIComponent(viewer.credential),
  );
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const connected = await reader.read();
  assert.equal(new TextDecoder().decode(connected.value), ": connected\n\n");

  const responderHeaders = { "x-rdsh-browser-token": responder.credential };
  const answer = await fetch(dashboard.localUrl + "api/update/answer", {
    method: "POST",
    headers: { ...responderHeaders, "content-type": "application/json" },
    body: JSON.stringify({ id: "Q1", answer: "Approved" }),
  });
  assert.equal(answer.status, 200);
  const changed = await reader.read();
  assert.match(new TextDecoder().decode(changed.value), /event: changed/);
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/instructions/submit", {
        method: "POST",
        headers: { ...responderHeaders, "content-type": "application/json" },
        body: JSON.stringify({ text: "not granted" }),
      })
    ).status,
    403,
  );

  const revoked = await fetch(
    dashboard.localUrl + `api/devices/${viewer.device.id}`,
    { method: "DELETE", headers: ownerHeaders },
  );
  assert.equal(revoked.status, 200);
  assert.equal((await jsonResponse(revoked)).device.status, "revoked");
  const disconnected = await reader.read();
  assert.equal(disconnected.done, true);
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/state", {
        headers: viewerHeaders,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/state", {
        headers: responderHeaders,
      })
    ).status,
    200,
  );

  await dashboard.close();
  dashboard = await startDashboard({
    project,
    port: await freePort(),
    tailscale: false,
  });
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/state", {
        headers: responderHeaders,
      })
    ).status,
    200,
  );
  const list = await fetch(dashboard.localUrl + "api/devices", {
    headers: ownerHeaders,
  });
  assert.equal(list.status, 401);
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const newOwnerHeaders = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
  };
  const persisted = await fetch(dashboard.localUrl + "api/devices", {
    headers: newOwnerHeaders,
  });
  const devices = (await jsonResponse(persisted)).devices;
  assert.deepEqual(
    devices.map(({ name, status }) => [name, status]),
    [
      ["phone-read-only", "revoked"],
      ["phone-reply", "active"],
      ["phone-control", "active"],
    ],
  );
  assert.ok(devices.every((device) => !Object.hasOwn(device, "token_hash")));
  assert.ok(devices.every((device) => device.last_used_at));
});
