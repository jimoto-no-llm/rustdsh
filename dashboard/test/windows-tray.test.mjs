import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { startWindowsTray } from "../windows-tray.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

function fixture(close) {
  const server = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
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

test("an unready tray retains its original 15-second startup deadline and owns only its helper", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const slow = fixture(async () => {
    calls++;
  });
  let ready = false;
  slow.pending.then(() => {
    ready = true;
  });
  t.mock.timers.tick(14999);
  await tick();
  assert.equal(ready, false);
  assert.equal(slow.child.killed, undefined);
  slow.child.stdout.write("ready\n");
  const tray = await slow.pending;
  tray.dispose();

  const lost = fixture(async () => {
    calls++;
  });
  const rejected = assert.rejects(lost.pending, /did not become ready/);
  t.mock.timers.tick(14999);
  await tick();
  assert.equal(lost.child.killed, undefined);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(lost.child.killed, true);
  assert.equal(lost.server.listenerCount("close"), 0);
  assert.equal(calls, 0);
});

test("tray diagnostics bound stderr and keep its contents out of observations", async () => {
  const f = fixture(async () => {});
  f.child.stdout.write(
    "phase:powershell-start:7.5.2\nphase:forms-loaded\nphase:drawing-loaded\n",
  );
  f.child.stdout.write("phase:untrusted:DUMMY_PHASE_SECRET\n");
  f.child.stderr.write("DUMMY_STDERR_SECRET".repeat(2000));
  f.child.stdout.write("ready\n");
  const tray = await f.pending;
  const report = tray.diagnostics();
  assert.equal(report.powershell, "7.5.2");
  assert.deepEqual(report.phases.map((entry) => entry.phase), [
    "spawn-requested",
    "powershell-start",
    "forms-loaded",
    "drawing-loaded",
    "ready",
  ]);
  assert.equal(report.stderr.bytes, 16384);
  assert.equal(report.stderr.truncated, true);
  assert.match(report.stderr.sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(report), /DUMMY_|untrusted/);
  report.phases.length = 0;
  assert.ok(tray.diagnostics().phases.some((entry) => entry.phase === "ready"));
  tray.dispose();
});

async function stopFixtureHelper(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return true;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
  child.kill();
  await exited;
  return child.exitCode !== null || child.signalCode !== null;
}

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
  async (t) => {
    const started = performance.now();
    const phases = [];
    const stderrHash = createHash("sha256");
    let stderrBytes = 0,
      hashedBytes = 0,
      stderrTruncated = false,
      pendingLine = "";
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
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.length;
      const remaining = 16384 - hashedBytes;
      if (remaining > 0) {
        stderrHash.update(bytes.subarray(0, remaining));
        hashedBytes += Math.min(bytes.length, remaining);
      }
      if (bytes.length > remaining) stderrTruncated = true;
      pendingLine += bytes.toString("utf8");
      if (pendingLine.length > 512 && !pendingLine.includes("\n"))
        pendingLine = pendingLine.slice(-512);
      let newline;
      while ((newline = pendingLine.indexOf("\n")) >= 0) {
        const line = pendingLine.slice(0, newline).replace(/\r$/, "");
        pendingLine = pendingLine.slice(newline + 1);
        if (
          /^RDSH_TRAY_TEST phase=[a-z-]+ elapsed_ms=\d+(?: powershell=[0-9A-Za-z.-]{1,32})?$/.test(
            line,
          ) &&
          phases.length < 16
        ) {
          phases.push(line);
          t.diagnostic(line);
        }
      }
    });
    t.after(async () => {
      const cleanupExitObserved = await stopFixtureHelper(child);
      t.diagnostic(
        JSON.stringify({
          tray_native_test: {
            node: process.version,
            elapsed_ms: Math.round(performance.now() - started),
            exit_code: child.exitCode,
            signal: child.signalCode,
            cleanup_exit_observed: cleanupExitObserved,
            phases,
            stderr: {
              bytes: stderrBytes,
              sha256: stderrHash.digest("hex"),
              truncated: stderrTruncated,
            },
          },
        }),
      );
    });
    const [code] = await once(child, "close", { signal: t.signal });
    assert.equal(code, 0);
  },
);

test(
  "native Windows creates a real NotifyIcon and disposes it on server close",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  async (t) => {
    const server = new EventEmitter();
    let helper;
    t.after(() => stopFixtureHelper(helper));
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
    const exit = once(helper, "exit", { signal: t.signal });
    server.emit("close");
    tray.dispose();
    const [code] = await exit;
    assert.equal(code, 0);
    t.diagnostic(JSON.stringify({ tray_startup: tray.diagnostics() }));
  },
);

test(
  "native Windows timeout reports phases and observes its exact helper's exit",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let helper, started;
    const phase = new Promise((resolve) => {
      started = resolve;
    });
    t.after(() => stopFixtureHelper(helper));
    const pending = startWindowsTray({
      dashboard: { server: new EventEmitter(), close: async () => {} },
      open: () => assert.fail("failed fixture must never open a browser"),
      spawnProcess: (command, args, options) => {
        const parameters = [...args];
        parameters[parameters.length - 1] = fileURLToPath(
          new URL("./fixtures/windows-tray-timeout.ps1", import.meta.url),
        );
        helper = spawn(command, parameters, options);
        helper.stderr.once("data", started);
        return helper;
      },
    });
    let failure;
    const rejected = assert.rejects(pending, (error) => {
      failure = error;
      return /did not become ready/.test(error.message);
    });
    await phase;
    t.mock.timers.tick(15000);
    await rejected;
    assert.equal(failure.trayDiagnostics.cleanup.exit_observed, true);
    assert.ok(
      failure.trayDiagnostics.phases.some(
        (entry) => entry.phase === "ready-timeout",
      ),
    );
    assert.notEqual(failure.trayDiagnostics.helper_exit, null);
    assert.doesNotMatch(
      JSON.stringify(failure.trayDiagnostics),
      /DUMMY_TRAY_STDERR_SECRET/,
    );
    t.diagnostic(JSON.stringify({ tray_timeout: failure.trayDiagnostics }));
  },
);
