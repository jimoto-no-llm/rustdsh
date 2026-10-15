import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RunnerError } from "../agent-runners.mjs";
import { cliErrorText, cliText } from "../cli-locale.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const languages = ["en", "zh-CN", "ja"];
const text = {
  en: {
    action: "Invalid agents action/options",
    submit: "agents submit requires --agent, --project and --prompt-file",
    runner: "Agent runner: ",
    args: ["directory", "file", "name", "path", "script"],
  },
  "zh-CN": {
    action: "agents 操作或选项无效",
    submit: "agents submit 需要 --agent、--project 和 --prompt-file",
    runner: "代理运行器错误：",
    args: ["目录", "文件", "名称", "路径", "脚本"],
  },
  ja: {
    action: "agentsの操作またはオプションが不正です",
    submit: "agents submitには--agent、--project、--prompt-fileが必要です",
    runner: "エージェント実行エラー: ",
    args: ["ディレクトリ", "ファイル", "名前", "パス", "スクリプト"],
  },
};
const promptText = "日本語の依頼：桜の状態を確認してください。";
const resultText = "日本語の結果：桜は満開です。\n";

function assertStableResult(actual, expected) {
  // Live PID observations can change between reads on an unconfirmed Windows job.
  for (const key of [
    "id", "runner", "state", "code", "project", "permission", "model",
    "created_at", "started_at", "finished_at", "elapsed_ms", "cleanup",
    "cleanup_code", "result",
  ]) assert.deepEqual(actual[key], expected[key], key);
}

// Both explicit entrypoints run only this local Node fixture, never an agent CLI.
const childSource = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("locale-fixture-1.0"); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
const devin = args.includes("--prompt-file");
const prompt = devin ? fs.readFileSync(value("--prompt-file"), "utf8") : args.at(-1);
fs.writeFileSync(path.join(__dirname, "received-prompt.json"), JSON.stringify(prompt));
if (prompt === "INVALID_JSON_FIXTURE") { process.stdout.write("{broken"); process.exit(0); }
if (devin) {
  fs.writeFileSync(value("--export"), JSON.stringify({schema_version:"ATIF-v1.7",session_id:"日本語-session",agent:{model_name:"fixture-model"},steps:[]}));
  process.stdout.write(${JSON.stringify(resultText)});
} else process.stdout.write(JSON.stringify({type:"result",is_error:false,result:${JSON.stringify(resultText)},session_id:"日本語-session"}));
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-agent-locale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const project = path.join(root, "日本語プロジェクト");
  const state = path.join(root, "state");
  const temporary = path.join(root, "tmp");
  await fs.mkdir(project);
  await fs.mkdir(temporary);
  const entrypoint = path.join(root, "fake-agent.cjs");
  const prompt = path.join(root, "日本語の依頼.txt");
  await fs.writeFile(entrypoint, childSource);
  await fs.writeFile(prompt, promptText);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    RDSH_DASHBOARD_HOME: state,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LC_ALL: "C",
    LANG: "C",
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key];
  const run = async (language, args) => {
    try {
      return { code: 0, ...(await execute(process.execPath, [cli, "--language", language, ...args], {
        cwd: root, env, timeout: 15000,
      })) };
    } catch (error) {
      if (typeof error.code === "number")
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      throw error;
    }
  };
  const submit = (runner, file = prompt) => [
    "agents", "submit", "--agent", runner, "--project", project,
    "--prompt-file", file, "--executable", process.execPath, "--entrypoint", entrypoint,
  ];
  return { root, project, state, prompt, run, submit };
}

test("only owned RunnerError instances localize while preserving message, code and detail", () => {
  const detail = { raw: "未加工の状態 {id}", cleanup: "unconfirmed" };
  for (const code of ["invalid_runner", "invalid_permission", "prompt_unreadable", "job_not_found", "cancel_unconfirmed", "future_code"]) {
    const error = new RunnerError(code, detail);
    const before = JSON.stringify(error);
    for (const language of languages) {
      assert.equal(cliErrorText(language, error), text[language].runner + code);
      assert.equal(error.message, "Agent runner: " + code);
      assert.equal(error.code, code);
      assert.equal(error.detail, detail);
      assert.equal(JSON.stringify(error), before);
    }
  }
  const foreign = Object.assign(new Error("Agent runner: invalid_runner"), {
    name: "RunnerError", code: "invalid_runner", detail,
  });
  for (const language of languages)
    assert.equal(cliErrorText(language, foreign), cliText(language, "error.context", { detail: foreign.message }));
});

for (const language of languages) {
  test(`agent CLI help and owned validation use ${language}`, async t => {
    const f = await fixture(t);
    const help = await f.run(language, ["--help"]);
    assert.equal(help.code, 0, help.stderr);
    const [directory, file, name, location, script] = text[language].args;
    assert.equal(help.stdout.split("\n").find(line => line.startsWith("rdsh-dashboard agents submit ")),
      `rdsh-dashboard agents submit --agent <cursor-agent|devin> --project <${directory}> --prompt-file <${file}> [--model <${name}>] [--permission read-only|edit|full] [--resume <id>] [--trust-workspace] [--executable <${location}>] [--entrypoint <${script}>] [--wait]`);
    for (const [args, expected] of [
      [["agents", "unknown"], text[language].action],
      [["agents", "submit"], text[language].submit],
      [f.submit("unknown-runner"), text[language].runner + "invalid_runner"],
      [[...f.submit("cursor-agent"), "--permission", "root"], text[language].runner + "invalid_permission"],
      [f.submit("cursor-agent", path.join(f.root, "存在しない依頼.txt")), text[language].runner + "prompt_unreadable"],
      [["agents", "status", "job_" + "0".repeat(24)], text[language].runner + "job_not_found"],
    ]) {
      const result = await f.run(language, args);
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `[rdsh-dashboard] ${expected}\n`);
    }
  });
}

test("unprobed runner catalog JSON is byte-identical across all display languages", async t => {
  const f = await fixture(t);
  const outputs = [];
  for (const language of languages) {
    const value = await f.run(language, ["agents", "list"]);
    assert.equal(value.code, 0, value.stderr);
    assert.equal(value.stderr, "");
    outputs.push(value.stdout);
  }
  assert.ok(outputs.every(value => value === outputs[0]));
  const catalog = JSON.parse(outputs[0]);
  assert.deepEqual(catalog.runners.map(row => row.id), ["cursor-agent", "devin"]);
  assert.deepEqual(catalog.jobs, []);
  for (const runner of catalog.runners)
    assert.deepEqual(Object.keys(runner.permissions), ["read-only", "edit", "full"]);
});

for (const language of languages) {
  test(`local fake agent jobs preserve Japanese data and machine results in ${language}`, async t => {
    const f = await fixture(t);
    for (const runner of ["cursor-agent", "devin"]) {
      const complete = await f.run(language, [...f.submit(runner), "--wait"]);
      assert.equal(complete.code, 0, complete.stderr);
      assert.equal(complete.stderr, "");
      const output = JSON.parse(complete.stdout);
      assert.equal(output.state, "succeeded");
      assert.equal(output.code, null);
      assert.equal(output.result.text, resultText);
      assert.equal(output.result.session_id, "日本語-session");
      assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "received-prompt.json"), "utf8")), promptText);
      const dir = path.join(f.state, "agent-jobs", output.id);
      assert.equal(await fs.readFile(path.join(dir, "prompt.txt"), "utf8"), promptText);
      const persistedBefore = await fs.readFile(path.join(dir, "result.json"), "utf8");
      for (const display of languages) {
        const result = await f.run(display, ["agents", "result", output.id]);
        assert.equal(result.code, 0, result.stderr);
        assertStableResult(JSON.parse(result.stdout), output);
        const status = await f.run(display, ["agents", "status", output.id]);
        assert.equal(status.code, 0, status.stderr);
        const state = JSON.parse(status.stdout);
        assert.equal(state.state, "succeeded");
        assert.equal(state.code, null);
        assert.equal(state.runner, runner);
      }
      assert.equal(await fs.readFile(path.join(dir, "result.json"), "utf8"), persistedBefore);
    }
    const invalidPrompt = path.join(f.root, "invalid-fixture.txt");
    await fs.writeFile(invalidPrompt, "INVALID_JSON_FIXTURE");
    const failed = await f.run(language, [...f.submit("cursor-agent", invalidPrompt), "--wait"]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    const output = JSON.parse(failed.stdout);
    assert.equal(output.state, "failed");
    assert.equal(output.code, "invalid_json");
    for (const display of languages) {
      const status = await f.run(display, ["agents", "status", output.id]);
      assert.equal(status.code, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).code, "invalid_json");
      const result = await f.run(display, ["agents", "result", output.id]);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assertStableResult(JSON.parse(result.stdout), output);
    }
  });
}
