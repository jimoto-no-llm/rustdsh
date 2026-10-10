// The real Project server/UI with synthetic data and a loopback fault proxy.
// Optional Tailscale Serve access requires an explicit opt-in and a verified route.
// This does not exercise Harness, DSHagentloop, or installed launcher startup.
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { identity, writeJson } from "../state.mjs";
import { startDashboard } from "../server.mjs";
import { enableShare } from "../tailscale.mjs";

const questions = [
  ["Q-sse", "入力中の回答を維持したまま、log による更新を確認してください。"],
  ["Q-double", "hold 中の連打と Enter 操作で回答が重複しないことを確認してください。"],
  ["Q-before", "drop-before による保存前の通信断と再送を確認してください。"],
  ["Q-after", "drop-after による保存後の応答消失と再接続を確認してください。"],
  ["Q-navigation", "キーボード・狭い画面・ページ内移動を確認してください。"],
];
const help = {
  help: "Show commands.",
  log: "Append a synthetic progress event through the real server (SSE update).",
  hold: "Hold the next answer POST before forwarding; subsequent POSTs remain observable.",
  release: "Forward the held answer POST and return its real response.",
  "drop-before": "Drop the next answer POST before forwarding; disconnect until resume.",
  "drop-after": "Disconnect SSE first; forward the next answer POST, then discard its response. Stay offline until resume.",
  resume: "Restore the proxy connection and cancel an unused fault.",
  status: "Show and persist counts, pending questions, and answer POST evidence (no credentials).",
  stop: "Close only this fixture's servers; retain fixture files.",
};

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// directory is an optional parent directory. Every run gets a fresh child;
// neither existing projects nor an existing QA run can be overwritten.
export async function startQaFixture({ directory = os.tmpdir(), port = 0, tailscale = false, shareRoute = enableShare } = {}) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error("Invalid fixture port");
  if (typeof tailscale !== "boolean") throw new Error("Invalid Tailscale option");
  await fs.mkdir(path.resolve(directory), { recursive: true });
  const runDirectory = await fs.mkdtemp(path.join(path.resolve(directory), "rdsh-qa-"));
  const stateHome = path.join(runDirectory, "dashboard-home");
  const projectRoot = path.join(runDirectory, "issue-52-synthetic-project");
  await fs.mkdir(projectRoot);
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  let project;
  try {
    process.env.RDSH_DASHBOARD_HOME = stateHome;
    project = await identity(projectRoot);
  } finally {
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
  }
  const dashboard = await startDashboard({ project, port: await freePort(), tailscale: false });
  const backend = new URL(dashboard.localUrl);
  const resultFile = path.join(runDirectory, "result.json");
  const sockets = new Set();
  const counts = new Map(questions.map(([id]) => [id, { attempts: 0, forwarded: 0 }]));
  let online = true, nextFault = null, held = null, attempts = 0, forwarded = 0;
  let logs = 0, closePromise, url, droppingResponse = false;
  let tailscaleUrl = null;
  const allowedHosts = new Set(), allowedOrigins = new Set();
  let resultQueue = Promise.resolve();

  function snapshot() {
    const state = dashboard.store.value;
    return {
      updated_at: new Date().toISOString(),
      scope: tailscaleUrl
        ? "synthetic Project server/UI with verified Tailscale Serve; proxy-induced faults; not Harness, DSHagentloop, or CLI startup"
        : "synthetic Project server/UI; not Harness, DSHagentloop, Tailscale, or CLI startup",
      online, next_fault: nextFault, held: Boolean(held), stopped: Boolean(closePromise),
      revision: state.revision, question_count: state.questions.length,
      pending_count: state.questions.filter((q) => q.answer === null).length,
      feedback_count: state.feedback.length,
      answer_post_attempts: attempts, answer_post_forwarded: forwarded,
      // Unknown IDs, invalid/oversized/aborted bodies, and bodies still being
      // received cannot yet be attributed to one of the synthetic questions.
      answer_post_unattributed: attempts - [...counts.values()].reduce((sum, count) => sum + count.attempts, 0),
      backend_commits: state.feedback.length,
      log_events: logs,
      questions: state.questions.map((q) => ({
        id: q.id, answered: q.answer !== null,
        feedback_count: state.feedback.filter((item) => item.question_id === q.id).length,
        answer_post_attempts: counts.get(q.id)?.attempts || 0,
        answer_post_forwarded: counts.get(q.id)?.forwarded || 0,
      })),
    };
  }
  function record() {
    const value = snapshot();
    resultQueue = resultQueue.catch(() => {}).then(() => writeJson(resultFile, value));
    return resultQueue.then(() => value);
  }
  function disconnect(except) {
    online = false;
    for (const socket of sockets) if (socket !== except) socket.destroy();
  }
  function forward(req, res, body, { discard = false, questionId } = {}) {
    if (body !== undefined) {
      forwarded++;
      if (counts.has(questionId)) counts.get(questionId).forwarded++;
    }
    return new Promise((resolve) => {
      const headers = { ...req.headers, host: backend.host };
      if (headers.origin) headers.origin = backend.origin;
      const incoming = new URL(req.url, url);
      const upstream = http.request(backend, {
        path: incoming.pathname + incoming.search,
        method: req.method, headers, agent: false,
      }, (response) => {
        // For drop-after, consume the complete real response before dropping
        // the browser socket. No response bytes or SSE can reveal the commit.
        if (discard) response.resume();
        else {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        }
        response.once("end", () => {
          if (discard) res.destroy();
          resolve();
        });
        response.once("error", () => { res.destroy(); resolve(); });
      });
      upstream.once("error", () => { res.destroy(); resolve(); });
      res.once("close", () => {
        if (!res.writableEnded && !discard) upstream.destroy();
      });
      if (body === undefined) req.pipe(upstream);
      else upstream.end(body);
    });
  }
  const proxy = http.createServer(async (req, res) => {
    // Preserve the backend's Host/Origin protections before rewriting them
    // for this fixed loopback target. There is no HTTP control endpoint.
    if (!allowedHosts.has(req.headers.host) ||
        (req.headers.origin && !allowedOrigins.has(req.headers.origin))) {
      res.writeHead(403);
      res.end("Untrusted host or origin");
      return;
    }
    let incoming;
    try { incoming = new URL(req.url, url); } catch {
      res.writeHead(400); res.end("Invalid URL"); return;
    }
    const isAnswer = req.method === "POST" && incoming.pathname === "/api/update/answer";
    if (isAnswer) attempts++;
    const receivedOffline = !online;
    if (!isAnswer) {
      if (receivedOffline) res.destroy();
      else await forward(req, res);
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 131072) {
          if (receivedOffline || !online) res.destroy();
          else { res.writeHead(413); res.end(); }
          await record();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let questionId;
      try { questionId = JSON.parse(body.toString("utf8")).id; } catch {}
      if (counts.has(questionId)) counts.get(questionId).attempts++;
      // A browser may transparently retry a failed POST. Read its bounded
      // body for attribution even while offline, but never forward it.
      if (receivedOffline || !online) {
        res.destroy();
        await record();
        return;
      }
      const fault = nextFault;
      nextFault = null;
      if (fault === "hold") {
        held = { req, res, body, questionId };
        res.once("close", () => { if (held?.res === res) held = null; });
      } else if (fault === "drop-before") {
        disconnect();
      } else if (fault === "drop-after") {
        droppingResponse = true;
        disconnect(req.socket);
        try { await forward(req, res, body, { discard: true, questionId }); }
        finally { droppingResponse = false; }
      } else {
        await forward(req, res, body, { questionId });
      }
      await record();
    } catch {
      res.destroy();
    }
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      disconnect();
      held = null;
      nextFault = null;
      await new Promise((resolve) => proxy.close(resolve));
      await dashboard.close();
      await record();
    })();
    return closePromise;
  }
  async function command(name) {
    if (!Object.hasOwn(help, name)) throw new Error("Unknown command; use help");
    if (name === "help") return help;
    if (name === "stop") { await close(); return snapshot(); }
    if (closePromise) throw new Error("Fixture is stopped");
    if (["hold", "drop-before", "drop-after"].includes(name)) {
      if (!online || held || nextFault) throw new Error("Release/resume the current fault first");
      nextFault = name;
    } else if (name === "release") {
      if (!held) throw new Error("No answer POST is held");
      const pending = held;
      held = null;
      await forward(pending.req, pending.res, pending.body, { questionId: pending.questionId });
    } else if (name === "resume") {
      if (held) throw new Error("Use release for the held answer POST");
      if (droppingResponse) throw new Error("Wait for the dropped answer POST to finish");
      online = true;
      nextFault = null;
    } else if (name === "log") {
      await dashboard.mutate("event", {
        type: "progress", title: `Synthetic QA log ${++logs}`,
        detail: "Local fixture event for checking drafts and focus during SSE refresh.",
      });
    }
    return record();
  }
  try {
    for (const [id, question] of questions) {
      await dashboard.mutate("question", {
        id, question, urgency: "normal", default_action: "試験用。外部の操作は実行しません。",
      });
    }
    await dashboard.mutate("task", { id: "QA-52", title: "ブラウザー操作の手動確認（synthetic）", status: "doing" });
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${proxy.address().port}/`;
    allowedHosts.add(new URL(url).host);
    allowedOrigins.add(new URL(url).origin);
    if (tailscale) {
      const share = await shareRoute(proxy.address().port);
      let external;
      try { external = new URL(share?.url); } catch {}
      if (share?.state !== "ready" || !external || external.protocol !== "https:" ||
          !/^[a-z0-9.-]+\.ts\.net$/i.test(external.hostname) ||
          external.username || external.password || external.search || external.hash ||
          external.pathname !== "/" || Number(external.port || 443) !== proxy.address().port)
        throw new Error("Tailscale Serve route was not verified; no external origin is accepted");
      tailscaleUrl = external.href;
      // getShare() returns the backend's live share object. Reuse its existing
      // config/QR/refresh handlers while keeping the fault proxy as the only
      // published route; the backend itself remains tailscale:false.
      Object.assign(dashboard.getShare(), {
        state: "ready", url: tailscaleUrl,
        message: share.message || "Tailscale経由の試験用接続です。QRコードで同じ画面を開けます。",
      });
      allowedHosts.add(external.host);
      allowedOrigins.add(external.origin);
    }
    await record();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    directory: runDirectory, stateHome, projectRoot, resultFile,
    stateFile: path.join(project.directory, "state.json"),
    url, browserUrl: url + new URL(dashboard.browserUrl).hash, command, close,
    tailscaleBrowserUrl: tailscaleUrl ? tailscaleUrl + new URL(dashboard.browserUrl).hash : null,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: "string" }, port: { type: "string" },
    tailscale: { type: "boolean", default: false }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node dashboard/qa/fixture.mjs [--directory <parent-directory>] [--port <port>] [--tailscale]");
    return;
  }
  const fixture = await startQaFixture({ directory: values.directory, port: values.port === undefined ? 0 : Number(values.port), tailscale: values.tailscale });
  // Only this synthetic browser key is printed. Never print runtime.json,
  // request headers, backend administrator tokens, or full request URLs.
  console.log(JSON.stringify({
    browser_url: fixture.browserUrl, directory: fixture.directory,
    tailscale_browser_url: fixture.tailscaleBrowserUrl,
    state_file: fixture.stateFile, result_file: fixture.resultFile,
    commands: Object.keys(help),
  }, null, 2));
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = () => { input.close(); void fixture.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for await (const line of input) {
      const name = line.trim();
      if (!name) continue;
      try {
        console.log(JSON.stringify(await fixture.command(name), null, 2));
        if (name === "stop") break;
      } catch (error) { console.error(error.message); }
    }
  } finally {
    input.close();
    process.stdin.pause();
    await fixture.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
