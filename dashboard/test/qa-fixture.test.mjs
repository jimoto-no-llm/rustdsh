// HTTP-level checks for the fault fixture; these are not browser QA results.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { startQaFixture } from "../qa/fixture.mjs";

function request(fixture, route, body, extraHeaders = {}) {
  const key = new URL(fixture.browserUrl).hash.slice("#key=".length);
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, fixture.url), {
      method: body === undefined ? "GET" : "POST",
      agent: false,
      headers: Object.fromEntries(Object.entries({
        "x-rdsh-browser-token": key,
        origin: new URL(fixture.url).origin,
        "content-type": "application/json",
        ...extraHeaders,
      }).filter(([, value]) => value !== null)),
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("HTTP test timed out")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function live(fixture) {
  const key = new URL(fixture.browserUrl).hash.slice("#key=".length);
  let text = "", ready, closed;
  const connected = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const req = http.get(new URL(`api/live?key=${key}`, fixture.url), { agent: false }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; ready.resolve(); });
    res.on("error", () => {});
    res.on("close", closed);
  });
  req.on("error", (error) => { ready.reject(error); closed(); });
  await connected;
  return { text: () => text, disconnected, close: () => req.destroy() };
}
async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Condition was not observed within 3 seconds");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("QA fixture serves real assets/state/SSE and holds answers without forwarding", { timeout: 10000 }, async (t) => {
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  const fixture = await startQaFixture();
  t.after(() => fixture.close());
  assert.equal(process.env.RDSH_DASHBOARD_HOME, previousHome);
  assert.match((await request(fixture, "/")).text, /未回答の質問/);
  assert.match((await request(fixture, "app.mjs")).text, /new EventSource/);
  // Project browser module imports carry no custom token header.
  // The module is public code; project state remains protected.
  const asset = await request(fixture, "answer-recovery.mjs", undefined, { "x-rdsh-browser-token": null });
  assert.equal(asset.status, 200);
  assert.match(asset.text, /export function createQuestionRecovery/);
  assert.equal((await request(fixture, "api/state", undefined, { "x-rdsh-browser-token": null })).status, 401);
  const localConfig = JSON.parse((await request(fixture, "api/config")).text);
  assert.equal(localConfig.share.state, "disabled");
  assert.equal(localConfig.share.url, null);
  assert.equal((await request(fixture, "api/qr.svg")).status, 409);
  assert.equal((await request(fixture, "api/state", undefined, { origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await request(fixture, "api/state", undefined, { host: "untrusted.invalid" })).status, 403);
  const stream = await live(fixture);
  t.after(stream.close);
  await fixture.command("log");
  await eventually(() => stream.text().includes("event: changed"));
  await fixture.command("hold");
  let settled = false;
  const answer = request(fixture, "api/update/answer", { id: "Q-double", answer: "held test" })
    .finally(() => { settled = true; });
  await eventually(async () => (await fixture.command("status")).held);
  const held = await fixture.command("status");
  assert.equal(settled, false);
  assert.equal(held.answer_post_attempts, 1);
  assert.equal(held.answer_post_forwarded, 0);
  assert.equal(held.backend_commits, 0);
  await fixture.command("release");
  assert.equal((await answer).status, 200);
  const status = await fixture.command("status");
  assert.equal(status.backend_commits, 1);
  assert.equal(status.question_count, 5);
  assert.equal(status.pending_count, 4);
  assert.equal(status.answer_post_forwarded, 1);
  const persisted = JSON.parse(await fs.readFile(fixture.resultFile, "utf8"));
  assert.equal(persisted.feedback_count, 1);
  await fixture.close();
  assert.equal(JSON.parse(await fs.readFile(fixture.stateFile, "utf8")).feedback.length, 1);
  assert.equal(JSON.parse(await fs.readFile(fixture.resultFile, "utf8")).stopped, true);
});

test("drop-before never reaches the backend and closes SSE until resume", { timeout: 10000 }, async (t) => {
  const fixture = await startQaFixture();
  t.after(() => fixture.close());
  const stream = await live(fixture);
  t.after(stream.close);
  await fixture.command("drop-before");
  await assert.rejects(request(fixture, "api/update/answer", { id: "Q-before", answer: "not saved" }));
  await stream.disconnected;
  await assert.rejects(request(fixture, "api/state"));
  const offline = await fixture.command("status");
  assert.equal(offline.online, false);
  assert.equal(offline.answer_post_attempts, 1);
  assert.equal(offline.answer_post_forwarded, 0);
  assert.equal(offline.backend_commits, 0);
  assert.doesNotMatch(stream.text(), /event: changed/);
  await fixture.command("resume");
  const resumed = await live(fixture);
  t.after(resumed.close);
  const answer = await request(fixture, "api/update/answer", { id: "Q-before", answer: "retry saved" });
  assert.equal(answer.status, 200);
  await eventually(() => resumed.text().includes("event: changed"));
  const status = await fixture.command("status");
  assert.equal(status.answer_post_attempts, 2);
  assert.equal(status.answer_post_forwarded, 1);
  assert.equal(status.backend_commits, 1);
});

test("drop-after commits exactly once without exposing the response or SSE", { timeout: 10000 }, async (t) => {
  const fixture = await startQaFixture();
  t.after(() => fixture.close());
  const stream = await live(fixture);
  t.after(stream.close);
  await fixture.command("drop-after");
  await assert.rejects(request(fixture, "api/update/answer", { id: "Q-after", answer: "saved response lost" }));
  await stream.disconnected;
  const offline = await fixture.command("status");
  assert.equal(offline.online, false);
  assert.equal(offline.answer_post_attempts, 1);
  assert.equal(offline.answer_post_forwarded, 1);
  assert.equal(offline.backend_commits, 1);
  assert.doesNotMatch(stream.text(), /event: changed/);
  await assert.rejects(request(fixture, "api/state"));
  await fixture.command("resume");
  const state = JSON.parse((await request(fixture, "api/state")).text);
  assert.equal(state.questions.find((q) => q.id === "Q-after").answer, "saved response lost");
  assert.equal(state.feedback.length, 1);
  const duplicate = await request(fixture, "api/update/answer", { id: "Q-after", answer: "duplicate" });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.text, /already answered/);
  const status = await fixture.command("status");
  assert.equal(status.answer_post_attempts, 2);
  assert.equal(status.answer_post_forwarded, 2);
  assert.equal(status.backend_commits, 1);
});

test("offline answer retries remain attributed and reconcile with the request total", { timeout: 10000 }, async (t) => {
  const fixture = await startQaFixture();
  t.after(() => fixture.close());
  await fixture.command("drop-before");
  const answer = { id: "Q-before", answer: "transport retry" };
  await assert.rejects(request(fixture, "api/update/answer", answer));
  await assert.rejects(request(fixture, "api/update/answer", answer));
  let status = await fixture.command("status");
  assert.equal(status.questions.find((q) => q.id === "Q-before").answer_post_attempts, 2);
  assert.equal(status.answer_post_attempts, 2);
  assert.equal(status.answer_post_unattributed, 0);
  await assert.rejects(request(fixture, "api/update/answer", { id: "unknown", answer: "unknown ID" }));
  await assert.rejects(request(fixture, "api/update/answer", { ...answer, answer: "x".repeat(131073) }));
  status = await fixture.command("status");
  assert.equal(status.answer_post_attempts, 4);
  assert.equal(status.answer_post_unattributed, 2);
  assert.equal(status.answer_post_attempts,
    status.questions.reduce((total, q) => total + q.answer_post_attempts, 0) + status.answer_post_unattributed);
  assert.equal(status.answer_post_forwarded, 0);
  assert.equal(status.backend_commits, 0);
  await fixture.command("resume");
  assert.equal((await request(fixture, "api/update/answer", answer)).status, 200);
  status = await fixture.command("status");
  assert.equal(status.questions.find((q) => q.id === "Q-before").answer_post_attempts, 3);
  assert.equal(status.answer_post_attempts, 5);
  assert.equal(status.answer_post_unattributed, 2);
  assert.equal(status.answer_post_forwarded, 1);
  assert.equal(status.backend_commits, 1);
});

test("CLI stop exits even when the controlling stdin remains open", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../qa/fixture.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.resume();
  t.after(() => {
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
  });
  await eventually(() => output.includes('"commands"'));
  child.stdin.write("stop\n");
  await eventually(() => output.includes('"stopped": true'));
  // Do not end the input pipe: a terminal stays open after a command as well.
  await eventually(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
});

test("opt-in Tailscale fixture accepts only its verified Serve host and origin", async (t) => {
  let sharedPort;
  const fixture = await startQaFixture({ tailscale: true, shareRoute: async port => {
    sharedPort = port;
    return { state: "ready", url: `https://qa.tail-example.ts.net:${port}/` };
  } });
  t.after(() => fixture.close());
  const expectedRemote = new URL(`https://qa.tail-example.ts.net:${new URL(fixture.url).port}/`);
  assert.equal((await request(fixture, "/", undefined, { host: expectedRemote.host, origin: expectedRemote.origin })).status, 200);
  assert.equal(sharedPort, Number(new URL(fixture.url).port));
  const remote = new URL(fixture.tailscaleBrowserUrl);
  assert.equal(remote.protocol, "https:");
  assert.equal(remote.hash === new URL(fixture.browserUrl).hash, true, "The public URL must preserve the browser credential");
  const headers = { host: remote.host, origin: remote.origin };
  assert.equal((await request(fixture, "/", undefined, headers)).status, 200);
  assert.equal((await request(fixture, "api/state", undefined, headers)).status, 200);
  assert.equal((await request(fixture, "api/state", undefined, { ...headers, origin: "https://other.ts.net" })).status, 403);
  assert.equal((await request(fixture, "api/state", undefined, { ...headers, host: "other.ts.net" })).status, 403);
  assert.equal((await request(fixture, "api/state", undefined, { ...headers, "x-rdsh-browser-token": "wrong" })).status, 401);
  await fixture.command("drop-after");
  await assert.rejects(request(fixture, "api/update/answer", { id: "Q-after", answer: "private route" }, headers));
  assert.equal((await fixture.command("status")).feedback_count, 1);
  await fixture.command("resume");
  const state = JSON.parse((await request(fixture, "api/state", undefined, headers)).text);
  assert.equal(state.questions.find(q => q.id === "Q-after").answer, "private route");
});

test("Tailscale fixture publishes the verified proxy route through config, QR and refresh", async (t) => {
  let shareCalls = 0;
  const fixture = await startQaFixture({ tailscale: true, shareRoute: async port => {
    shareCalls++;
    return { state: "ready", url: `https://qa.tail-example.ts.net:${port}/`, message: "Verified private QA route" };
  } });
  t.after(() => fixture.close());
  const remote = new URL(fixture.tailscaleBrowserUrl);
  const headers = { host: remote.host, origin: remote.origin };
  const configResponse = await request(fixture, "api/config", undefined, headers);
  assert.equal(configResponse.status, 200);
  const config = JSON.parse(configResponse.text);
  assert.equal(config.share.state, "ready");
  assert.equal(config.share.url, remote.origin + "/");
  assert.equal(config.share.message, "Verified private QA route");
  assert.equal(config.mcp_url, remote.origin + "/mcp");
  const qr = await request(fixture, "api/qr.svg", undefined, headers);
  assert.equal(qr.status, 200);
  const expectedSvg = await QRCode.toString(fixture.tailscaleBrowserUrl,
    { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 280 });
  assert.equal(qr.text === expectedSvg, true, "QR must encode the authenticated public proxy URL using the existing renderer");
  for (const route of ["api/config", "api/qr.svg"])
    assert.equal((await request(fixture, route, undefined, { ...headers, "x-rdsh-browser-token": null })).status, 401);
  assert.equal((await request(fixture, "api/share/refresh", {}, { ...headers, "x-rdsh-browser-token": null })).status, 401);
  const refreshed = await request(fixture, "api/share/refresh", {}, headers);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(JSON.parse(refreshed.text), config.share);
  assert.deepEqual(JSON.parse((await request(fixture, "api/config", undefined, headers)).text).share, config.share);
  assert.equal((await request(fixture, "api/qr.svg", undefined, headers)).text === expectedSvg, true, "Refresh must keep the same authenticated QR route");
  assert.equal(shareCalls, 1, "Backend refresh must not publish a separate backend port");
});

test("Tailscale fixture fails closed when route setup is not verified", async () => {
  await assert.rejects(startQaFixture({ tailscale: true, shareRoute: async () => ({ state: "login_required", url: null }) }), /Tailscale Serve/);
  await assert.rejects(startQaFixture({ tailscale: true, shareRoute: async () => ({ state: "ready", url: "https://untrusted.invalid/" }) }), /Tailscale Serve/);
  await assert.rejects(startQaFixture({ port: 80 }), /port/i);
});
