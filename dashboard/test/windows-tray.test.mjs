import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { startWindowsTray } from "../windows-tray.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

function fixture(close) {
  const server = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    child.killed = true;
  };
  const dashboard = {
    server,
    browserUrl: "http://127.0.0.1:38101/#key=dummy",
    close,
  };
  const opened = [];
  let invocation;
  const pending = startWindowsTray({
    dashboard,
    open: (url) => opened.push(url),
    spawnProcess: (...args) => {
      invocation = args;
      return child;
    },
  });
  return { server, child, dashboard, opened, pending, invocation };
}

test("tray passes no URL/credential to PowerShell; Open uses its exact server", async () => {
  const f = fixture(async () => {});
  f.child.stdout.write("ready\n");
  const tray = await f.pending;
  assert.equal(JSON.stringify(f.invocation).includes("dummy"), false);
  assert.equal(f.invocation[2].windowsHide, true);
  assert.equal(f.invocation[2].env.RDSH_TRAY_LABEL, "rdsh-dashboard");
  assert.equal(f.invocation[2].env.OPENAI_API_KEY, undefined);
  assert.equal(f.invocation[2].env.DEEPSEEK_API_KEY, undefined);
  assert.ok(f.invocation[1].includes("-STA"));
  f.child.stdout.write("unknown\nopen\n");
  assert.deepEqual(f.opened, [f.dashboard.browserUrl]);
  tray.dispose();
  assert.equal(f.child.stdin.writableEnded, true);
});

test("tray tooltip identifies its project and bounds Unicode labels", async () => {
  const server = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  let options;
  const pending = startWindowsTray({
    dashboard: { server, close: async () => {} },
    open: () => {},
    label: "rdsh: 日本語\n" + "😀".repeat(80),
    spawnProcess: (_command, _args, settings) => {
      options = settings;
      return child;
    },
  });
  child.stdout.write("ready\n");
  const tray = await pending;
  assert.ok(options.env.RDSH_TRAY_LABEL.length <= 63);
  assert.match(options.env.RDSH_TRAY_LABEL, /^rdsh: 日本語 /);
  assert.doesNotMatch(
    options.env.RDSH_TRAY_LABEL,
    /[\r\n\t]|[\uD800-\uDBFF]$/u,
  );
  tray.dispose();
});

test("Exit closes only its captured dashboard, coalesces clicks, and waits for proof", async () => {
  let calls = 0,
    finish;
  const closing = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(async () => {
    calls++;
    await closing;
    f.server.emit("close");
  });
  f.child.stdout.write("ready\n");
  await f.pending;
  f.child.stdout.write("exit\nexit\n");
  await tick();
  assert.equal(calls, 1);
  assert.equal(f.child.stdin.writableEnded, false);
  finish();
  await tick();
  assert.equal(f.child.stdin.writableEnded, true);
  assert.equal(f.child.killed, undefined);
});

test("unconfirmed stop retains the server/tray and permits Exit retry", async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new Error("ownership_unverified");
    f.server.emit("close");
  });
  let received = "";
  f.child.stdin.on("data", (data) => {
    received += data;
  });
  f.child.stdout.write("ready\n");
  await f.pending;
  f.child.stdout.write("exit\n");
  await tick();
  assert.equal(f.child.stdin.writableEnded, false);
  assert.match(JSON.parse(received).error, /remains available/);
  f.child.stdout.write("exit\n");
  await tick();
  assert.equal(calls, 2);
  assert.equal(f.child.stdin.writableEnded, true);
});

test("external dashboard stop disposes its icon without another stop request", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
  });
  f.child.stdout.write("ready\n");
  await f.pending;
  f.server.emit("close");
  f.child.emit("exit", 0);
  await tick();
  assert.equal(calls, 0);
  assert.equal(f.child.stdin.writableEnded, true);
});

test("failed tray startup cleans only its owned helper", async () => {
  const f = fixture(async () => {});
  f.child.emit("error", new Error("ENOENT"));
  await assert.rejects(f.pending, /unavailable/);
  assert.equal(f.child.killed, true);
  assert.equal(f.server.listenerCount("close"), 0);
});

test("a lost warning pipe cannot leak a rejected stop promise", async () => {
  const f = fixture(async () => {
    throw new Error("unverified");
  });
  f.child.stdout.write("ready\n");
  const tray = await f.pending;
  f.child.stdin.write = () => {
    throw new Error("pipe lost");
  };
  f.child.stdout.write("exit\n");
  await tick();
  assert.equal(f.child.stdin.writableEnded, false);
  tray.dispose();
});

test(
  "native Windows menu emits Open and Exit actions",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  async () => {
    const child = spawn(
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-tray-native.ps1", import.meta.url)),
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  },
);

test(
  "native Windows creates a real NotifyIcon and disposes it on server close",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  async () => {
    const server = new EventEmitter();
    let helper;
    const tray = await startWindowsTray({
      dashboard: {
        server,
        browserUrl: "http://127.0.0.1:38101/#key=dummy",
        close: async () => server.emit("close"),
      },
      open: () => {},
      spawnProcess: (...args) => {
        helper = spawn(...args);
        return helper;
      },
    });
    const exit = once(helper, "exit");
    server.emit("close");
    tray.dispose();
    const [code] = await exit;
    assert.equal(code, 0);
  },
);
