import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cliEntries,
  cliCatalog,
  cliText,
  cliErrorText,
  CliDiagnosticError,
  shareText,
} from "../cli-locale.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "rdsh-cli-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = path.join(root, "settings");
  await mkdir(settings);
  const env = {
    ...process.env,
    DSH_HOME: settings,
    RDSH_DASHBOARD_HOME: path.join(root, "state"),
    RDSH_LANG: "",
    LC_ALL: "C",
    LC_MESSAGES: "",
    LANG: "C",
  };
  const run = async (args, extra = {}) => {
    try {
      return {
        code: 0,
        ...(await exec(process.execPath, [cli, ...args], {
          env: { ...env, ...extra },
          cwd: root,
          timeout: 15000,
        })),
      };
    } catch (error) {
      if (typeof error.code === "number")
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      throw error;
    }
  };
  return { root, settings, env, run };
}

function expected(language, key, values) {
  return `[rdsh-dashboard] ${cliText(language, key, values)}\n`;
}

test("CLI catalog has all three languages, matching placeholders and typed validation origins", async () => {
  assert.equal(
    new Set(cliEntries.map((row) => row[0])).size,
    cliEntries.length,
  );
  const keys = Object.keys(cliCatalog.en).sort();
  for (const language of ["ja", "zh-CN"])
    assert.deepEqual(Object.keys(cliCatalog[language]).sort(), keys);
  const placeholders = (value) =>
    [...value.matchAll(/[{]([a-zA-Z0-9_]+)[}]/g)]
      .map((match) => match[1])
      .sort();
  for (const [key, ja, en, zh] of cliEntries) {
    assert.ok(
      [ja, en, zh].every(
        (value) => typeof value === "string" && value.length > 0,
      ),
      key,
    );
    assert.deepEqual(placeholders(ja), placeholders(en), key);
    assert.deepEqual(placeholders(ja), placeholders(zh), key);
  }
  const source = await readFile(cli, "utf8");
  assert.doesNotMatch(source, /throw new Error\(\s*["'`]/);
  const diagnostics = [
    ...source.matchAll(/new CliDiagnosticError\(\s*"([^"]+)"/g),
  ].map((match) => match[1]);
  assert.equal(new Set(diagnostics).size, 97);
  for (const key of diagnostics)
    for (const language of ["en", "ja", "zh-CN"]) {
      const diagnostic = new CliDiagnosticError(key, {
        detail: "raw 日本語 {id}",
      });
      assert.equal(
        cliErrorText(language, diagnostic),
        cliText(language, key, diagnostic.values),
      );
      assert.equal(diagnostic.message, cliText("en", key, diagnostic.values));
    }
  assert.doesNotMatch(source, /console\.(log|error)\s*=/);
  assert.doesNotMatch(source, /process\.env\.\w+\s*=/);
  for (const language of ["en", "ja", "zh-CN"]) {
    const raw = cliText("en", "error.portRange");
    assert.equal(
      cliErrorText(language, new Error(raw)),
      cliText(language, "error.context", { detail: raw }),
    );
    assert.equal(
      shareText(language, { state: "future_state", message: raw }),
      raw,
    );
    assert.ok(
      shareText(language, {
        state: "setup_required",
        message: "raw 日本語 {id}",
      }).includes("raw 日本語 {id}"),
    );
  }
});

for (const language of ["en", "zh-CN", "ja"])
  test(`CLI help and validation use ${language} without translating machine output or raw text`, async (t) => {
    const { root, run } = await fixture(t);
    const help = await run(["--language", language, "--help"]);
    assert.equal(help.code, 0, help.stderr);
    for (const key of [
      "help.project",
      "help.harness",
      "help.windows",
      "help.tray",
      "help.reply",
    ])
      assert.ok(help.stdout.includes(cliText(language, key)), key);
    assert.ok(help.stdout.includes("rdsh-dashboard budget policy|usage"));
    assert.ok(help.stdout.includes("--language en|zh-CN|ja"));
    assert.ok(help.stdout.includes(`<${cliText(language, "arg.directory")}>`));
    for (const [args, key] of [
      [["unknown-command"], "error.unknownCommand"],
      [
        ["project", "--project", root, "--port", "1", "--no-tailscale"],
        "error.portRange",
      ],
      [["subagents", "plan"], "error.subagentsAction"],
      [["task-outcomes", "bad"], "error.taskOutcomesAction"],
      [["cost-ledger", "validate"], "error.costPureOptions"],
      [["cost-ledger", "bad"], "error.costOptions"],
      [["backup", "bad"], "error.backupAction"],
      [["workers", "bad"], "error.workersAction"],
      [["integration", "bad"], "error.integrationAction"],
      [["routing", "bad"], "error.routingAction"],
      [["acceptance", "bad"], "error.acceptanceAction"],
      [["checkpoint", "bad"], "error.checkpointAction"],
      [["retry-history", "bad"], "error.retryHistoryAction"],
      [["run-history", "bad"], "error.runHistoryAction"],
      [["session-ledger", "bad"], "error.sessionAction"],
    ]) {
      const result = await run([...args, "--language", language]);
      assert.equal(result.code, 1, key);
      assert.equal(result.stdout, "", key);
      assert.equal(result.stderr, expected(language, key), key);
    }
    const parseError = await run(["--language", language, "--unknown-原文"]);
    assert.equal(parseError.code, 1);
    assert.ok(parseError.stderr.includes("--unknown-原文"));
    assert.ok(
      parseError.stderr.startsWith(
        expected(language, "error.argumentParsing", { detail: "" }).trimEnd(),
      ),
    );
    const missing = path.join(root, "原文 中文 {id}.json");
    const rawError = await run([
      "release",
      "stage",
      "--input-file",
      missing,
      "--language",
      language,
    ]);
    assert.equal(rawError.code, 1);
    assert.ok(rawError.stderr.includes("ENOENT"));
    assert.ok(rawError.stderr.includes(missing));
    const machine = await run([
      "preflight",
      "--entrypoint",
      "原文.js",
      "--language",
      language,
    ]);
    assert.equal(
      machine.stdout,
      '{"ready":false,"error":"invalid_preflight_input","execution_authority":false}\n',
    );
    assert.equal(machine.stderr, "");
    const first = await run(["adapters"]);
    const localized = await run(["--language=" + language, "adapters"]);
    assert.equal(localized.stdout, first.stdout);
    const label = "保存する · 原文 中文 {id}";
    const record = await run([
      "session-ledger",
      "record",
      "--project",
      root,
      "--session-id",
      "raw-native-id",
      "--label",
      label,
      "--language",
      language,
    ]);
    assert.equal(record.code, 0, record.stderr);
    assert.equal(JSON.parse(record.stdout).label, label);
  });

test("CLI resolves flag, environment and persisted language while refusing invalid files without overwriting bytes", async (t) => {
  const { settings, run } = await fixture(t);
  const file = path.join(settings, "rdsh.json");
  await writeFile(
    file,
    JSON.stringify({ schema: 1, general: { language: "ja" } }),
  );
  assert.ok(
    (await run(["--help"])).stdout.includes(cliText("ja", "help.project")),
  );
  assert.ok(
    (await run(["--help"], { RDSH_LANG: "zh_CN.UTF-8" })).stdout.includes(
      cliText("zh-CN", "help.project"),
    ),
  );
  assert.ok(
    (
      await run(["--help", "--language", "en"], { RDSH_LANG: "ja" })
    ).stdout.includes(cliText("en", "help.project")),
  );
  for (const raw of ['{"general":{"language":"fr"}}', "{broken"]) {
    await writeFile(file, raw);
    const result = await run(["--help", "--language", "ja"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      expected(
        "ja",
        raw.includes("fr") ? "settings.language" : "settings.read",
        { file },
      ),
    );
    assert.equal(await readFile(file, "utf8"), raw);
  }
});

test("CLI explicit language does not change delegated version-probe argv or locale environment", async (t) => {
  const { root, run } = await fixture(t);
  const file = path.join(root, "version-probe.mjs"),
    trace = path.join(root, "trace.json");
  await writeFile(
    file,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ args: process.argv.slice(2), language: process.env.RDSH_LANG, lc: process.env.LC_ALL, lang: process.env.LANG })); console.log('0.2.0-rc.2');`,
  );
  const result = await run(
    [
      "adapters",
      "--cli",
      "dsh",
      "--executable",
      process.execPath,
      "--entrypoint",
      file,
      "--language",
      "zh-CN",
    ],
    { RDSH_LANG: "ja", LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).health, "version_matched");
  assert.deepEqual(JSON.parse(await readFile(trace, "utf8")), {
    args: ["--version"],
    language: "ja",
    lc: "en_US.UTF-8",
    lang: "zh_CN.UTF-8",
  });
});

test("preflight preserves inline values when removing display-language options", async (t) => {
  const { root, run } = await fixture(t);
  await mkdir(path.join(root, "--demo"));
  await mkdir(path.join(root, "--language=ja"));
  for (const args of [
    ["preflight", "--project=--demo"],
    ["--language", "ja", "preflight", "--project=--demo"],
    ["preflight", "--project=--language=ja", "--language=zh-CN"],
    [
      "--language=ja",
      "preflight",
      "--project=--demo",
      "--language",
      "en",
      "--",
    ],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 0, JSON.stringify({ args, ...result }));
    const report = JSON.parse(result.stdout);
    assert.equal(report.ready, true);
    assert.equal(report.execution_authority, false);
    assert.equal(
      report.checks.find((check) => check.id === "cwd").status,
      "pass",
    );
    assert.equal(
      report.checks.find((check) => check.id === "cli").status,
      "not_required",
    );
    assert.equal(result.stderr, "");
  }
});

test("preflight retains unexpected positionals and option terminators for strict validation", async (t) => {
  const { root, run } = await fixture(t);
  await mkdir(path.join(root, "demo"));
  for (const args of [
    ["preflight", "unexpected", "--project=demo"],
    ["--language=ja", "preflight", "unexpected", "--project=demo"],
    [
      "preflight",
      "--project=demo",
      "--language=zh-CN",
      "--",
      "--language",
      "ja",
    ],
    ["--", "preflight", "--project=demo"],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1, JSON.stringify({ args, ...result }));
    assert.equal(
      result.stdout,
      '{"ready":false,"error":"invalid_preflight_input","execution_authority":false}\n',
    );
    assert.equal(result.stderr, "");
  }
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
for (const language of ["en", "zh-CN", "ja"])
  test(`CLI project startup propagates ${language} to real server HTML`, async (t) => {
    const { root, env } = await fixture(t);
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        cli,
        "project",
        "--project",
        root,
        "--port",
        String(port),
        "--no-tailscale",
        "--language",
        language,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(async () => {
      child.kill("SIGTERM");
      await exited;
    });
    const url = `http://127.0.0.1:${port}/`;
    let html;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) assert.fail(stderr || stdout);
      try {
        const response = await fetch(url);
        if (response.ok) {
          html = await response.text();
          if (stdout.includes(cliText(language, "status.open"))) break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(html, stderr);
    assert.ok(html.includes(`lang="${language}"`));
    assert.ok(html.includes(`data-rdsh-locale="${language}"`));
    assert.ok(
      stdout.includes(
        cliText(language, "status.started", { command: "project", url }),
      ),
    );
    assert.ok(stdout.includes(cliText(language, "status.open")));
    assert.ok(stdout.includes(cliText(language, "share.disabled")));
  });


test("pure native JSON bridges ignore corrupt settings while ordinary commands fail closed", async (t) => {
  const { root, settings, run } = await fixture(t);
  const malformed = "{broken settings";
  await writeFile(path.join(settings, "rdsh.json"), malformed);
  const request = path.join(root, "要求_日本語.json");
  const payload = { task_id: "未取得", raw: "日本語 {id}" };
  await writeFile(request, JSON.stringify(payload));
  // This private preload reports only the native child; it leaves the outer
  // dashboard process alone and works without an executable shell fixture.
  const reporter = path.join(root, "native-reporter.mjs");
  await writeFile(reporter, `
import { readFileSync } from "node:fs";
import path from "node:path";
const command = path.basename(process.argv[1]);
if (["subagents", "task-outcomes", "cost-ledger"].includes(command)) {
  console.log(JSON.stringify({ args: [command, ...process.argv.slice(2)], language: process.env.RDSH_LANG, request: JSON.parse(readFileSync(process.argv.at(-1), "utf8")) }));
  console.error("native raw 日本語");
  process.exit(Number(process.env.RDSH_BRIDGE_TEST_EXIT || 0));
}
`);
  const native = {
    RDSH_BIN: process.execPath,
    NODE_OPTIONS: `--import=${pathToFileURL(reporter).href}`,
  };
  for (const [flags, environment, language] of [
    [["--language", "ja"], { RDSH_LANG: "zh-CN" }, "ja"],
    [[], { RDSH_LANG: "zh-CN", LC_ALL: "ja_JP.UTF-8" }, "zh-CN"],
    [[], { RDSH_LANG: "", LC_ALL: "ja_JP.UTF-8" }, "ja"],
    [[], { RDSH_LANG: "", LC_ALL: "C" }, "en"],
  ]) {
    for (const command of [["subagents", "plan"], ...["apply", "validate", "schema"].map(action => ["task-outcomes", action]), ...["validate", "public", "schema"].map(action => ["cost-ledger", action])]) {
      const args = [...command, "--input-file", request];
      const result = await run([...flags, ...args], { ...native, ...environment });
      assert.equal(result.code, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      if (command[0] === "cost-ledger") {
        const temporary = observed.args.at(-1);
        assert.notEqual(temporary, request);
        assert.equal(path.dirname(temporary), path.join(root, "state"));
        await assert.rejects(readFile(temporary), { code: "ENOENT" });
        observed.args[observed.args.length - 1] = request;
      }
      assert.deepEqual(observed, { args, language, request: payload });
      assert.equal(await readFile(request, "utf8"), JSON.stringify(payload));
      assert.equal(result.stderr, "native raw 日本語\n");
    }
    const ordinary = await run([...flags, "--help"], { ...native, ...environment });
    assert.equal(ordinary.code, 1);
    assert.equal(ordinary.stdout, "");
    assert.ok(ordinary.stderr.includes(path.join(settings, "rdsh.json")));
    assert.equal(await readFile(path.join(settings, "rdsh.json"), "utf8"), malformed);
  }
  for (const command of ["task-outcomes", "cost-ledger"]) {
    const failed = await run([command, "validate", "--input-file", request], { ...native, RDSH_BRIDGE_TEST_EXIT: "7" });
    assert.equal(failed.code, 7);
    assert.equal(failed.stderr, "native raw 日本語\n");
    if (command === "cost-ledger") await assert.rejects(readFile(JSON.parse(failed.stdout).args.at(-1)), { code: "ENOENT" });
  }
  const stored = await run(["cost-ledger", "inspect"], native);
  assert.equal(stored.code, 1);
  assert.ok(stored.stderr.includes(path.join(settings, "rdsh.json")));
});

for (const language of ["en", "zh-CN", "ja"])
  test(`Windows private-request failure uses ${language} and preserves the colliding caller file`, { skip: process.platform !== "win32" }, async (t) => {
    const { root, env, run } = await fixture(t);
    const request = path.join(root, "要求 日本語.json");
    await writeFile(request, JSON.stringify({ operation: "schema", state: {} }));
    const preload = path.join(root, "exclusive-collision.mjs");
    await writeFile(preload, `
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import path from "node:path";
const id = "00000000-0000-4000-8000-000000000001";
crypto.randomUUID = () => id;
syncBuiltinESMExports();
if (path.basename(process.argv[1]) === "cli.mjs") {
  fs.mkdirSync(process.env.RDSH_DASHBOARD_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.RDSH_DASHBOARD_HOME, "cost-ledger-" + process.pid + "-" + id + ".json"), "existing caller 日本語", { flag: "wx" });
}
`);
    const result = await run(["--language", language, "cost-ledger", "schema", "--input-file", request], {
      RDSH_BIN: process.execPath,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expected(language, "error.privateJson", { operation: "CreateFileW", code: 80 }));
    const { readdir } = await import("node:fs/promises");
    const remaining = await readdir(env.RDSH_DASHBOARD_HOME);
    assert.equal(remaining.length, 1);
    assert.equal(await readFile(path.join(env.RDSH_DASHBOARD_HOME, remaining[0]), "utf8"), "existing caller 日本語");
  });
