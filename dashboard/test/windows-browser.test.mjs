import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openUrl } from "../browser.mjs";

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  let request = "";
  child.stdin.on("data", (data) => {
    request += data;
  });
  let unreferenced = false;
  child.unref = () => {
    unreferenced = true;
  };
  const calls = [],
    errors = [];
  const options = {
    platform: "win32",
    resolvePowerShell: () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    directory: "C:\\state & 日本語",
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
    report: (message) => errors.push(message),
  };
  return {
    child,
    calls,
    errors,
    options,
    request: () => JSON.parse(request),
    unreferenced: () => unreferenced,
  };
}

test("Windows browser helper receives the private URL over stdin, with literal argument boundaries", () => {
  const f = fixture();
  const url =
    "http://127.0.0.1:38081/?value=%27%20%26%20%24#key=secret-fixture";
  openUrl(url, f.options);
  assert.equal(f.calls.length, 1);
  const [executable, args, options] = f.calls[0];
  assert.equal(executable, f.options.resolvePowerShell());
  assert.equal(
    args.at(-1),
    fileURLToPath(new URL("../open-windows-browser.ps1", import.meta.url)),
  );
  assert.ok(
    !args.some((arg) => arg.includes(url) || arg.includes("secret-fixture")),
  );
  assert.deepEqual(f.request(), { url, stateDirectory: f.options.directory });
  assert.deepEqual(options.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(options.windowsHide, true);
  assert.equal(f.unreferenced(), true);
  f.child.emit("exit", 0);
  assert.deepEqual(f.errors, []);
});

test("browser launch failures are handled without exposing the URL or native exception", () => {
  for (const failure of ["spawn", "error", "exit"]) {
    const f = fixture();
    if (failure === "spawn")
      f.options.spawnProcess = () => {
        throw new Error("secret-fixture");
      };
    openUrl("http://127.0.0.1/#key=secret-fixture", f.options);
    if (failure === "error") f.child.emit("error", new Error("secret-fixture"));
    if (failure === "exit") f.child.emit("exit", 1);
    assert.equal(f.errors.length, 1);
    assert.doesNotMatch(f.errors[0], /secret-fixture/);
  }
  const f = fixture();
  openUrl("http://127.0.0.1/#key=secret-fixture", f.options);
  f.child.emit("error", new Error("secret-fixture"));
  f.child.emit("exit", 1);
  assert.equal(
    f.errors.length,
    1,
    "one failed launch should produce one diagnostic",
  );
});

test("Windows without PowerShell 7 retains built-in default URL activation", () => {
  const f = fixture();
  f.options.resolvePowerShell = () => {
    throw new Error("pwsh unavailable");
  };
  const url = "http://127.0.0.1:38081/#key=fixture-only";
  openUrl(url, f.options);
  const [executable, args, options] = f.calls[0];
  assert.match(executable, /[\\/]System32[\\/]rundll32\.exe$/);
  assert.deepEqual(args, ["url.dll,FileProtocolHandler", url]);
  assert.equal(options.stdio, "ignore");
  assert.equal(f.unreferenced(), true);
  assert.deepEqual(f.errors, []);
});

test("non-Windows open retains the printable URL and starts no helper", () => {
  const printed = [];
  openUrl("http://127.0.0.1:38081/", {
    platform: "linux",
    print: (url) => printed.push(url),
    spawnProcess: () => assert.fail("must not spawn a Windows helper"),
  });
  assert.deepEqual(printed, ["http://127.0.0.1:38081/"]);
});

test(
  "native Windows association routing and branded desktop/Start menu shortcuts",
  {
    skip: process.platform !== "win32",
    timeout: 30000,
  },
  () => {
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-browser-native.ps1", import.meta.url)),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 25000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /Windows default-browser routing and RDSH shortcuts verified/,
    );
  },
);
