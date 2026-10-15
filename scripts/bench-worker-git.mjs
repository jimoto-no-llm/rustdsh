import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  dirtyPaths,
  observeWorktree,
  repository,
  sourceSnapshot,
} from "../dashboard/worker-git.mjs";

const nativeBinary = process.env.RDSH_BENCH_BIN;
if (!nativeBinary || !path.isAbsolute(nativeBinary)) {
  throw new Error("RDSH_BENCH_BIN must be an absolute path");
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-git-bench-"));
const root = path.join(fixture, "repo");
const fallbackBinary = path.join(fixture, "missing-rdsh");
const originalBinary = process.env.RDSH_BIN;

function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function invoke(binary, operation) {
  process.env.RDSH_BIN = binary;
  return operation();
}

function median(values) {
  return [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ];
}

try {
  await fs.mkdir(root);
  runGit(["init", "-q"]);
  runGit(["config", "user.name", "RustDSH benchmark"]);
  runGit(["config", "user.email", "rustdsh-benchmark@example.invalid"]);
  runGit(["config", "commit.gpgsign", "false"]);
  for (let index = 0; index < 128; index++) {
    const name = `file-${String(index).padStart(3, "0")}.txt`;
    await fs.writeFile(path.join(root, name), `tracked ${index}\n`);
  }
  runGit(["add", "--all"]);
  runGit(["commit", "-qm", "benchmark fixture"]);
  const base = runGit(["rev-parse", "HEAD"]);
  for (let index = 0; index < 8; index++) {
    const name = `file-${String(index).padStart(3, "0")}.txt`;
    await fs.writeFile(path.join(root, name), `dirty ${index}\n`);
  }

  const metadata = await invoke(fallbackBinary, () => repository(root));
  const operations = [
    ["repository", () => repository(root)],
    ["sourceSnapshot", () => sourceSnapshot(root)],
    ["dirtyPaths", () => dirtyPaths(root)],
    [
      "observeWorktree",
      () =>
        observeWorktree(root, {
          git_common_dir: metadata.git_common_dir,
          branch: metadata.branch,
          base,
        }),
    ],
  ];
  const modes = [
    ["JS", fallbackBinary],
    ["Rust", nativeBinary],
  ];
  console.log(
    JSON.stringify({
      benchmark: "worker-git",
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      fixture: { tracked: 128, dirty: 8 },
      warmupsPerMode: 1,
      alternatingPairs: 7,
    }),
  );

  for (const [name, operation] of operations) {
    const timings = { JS: [], Rust: [] };
    const expected = {};
    for (const [mode, binary] of modes) {
      expected[mode] = await invoke(binary, operation);
    }
    assert.deepEqual(expected.Rust, expected.JS, `${name} output differs`);
    for (const [, binary] of modes) await invoke(binary, operation);

    for (let pair = 0; pair < 7; pair++) {
      const order = pair % 2 === 0 ? modes : [...modes].reverse();
      for (const [mode, binary] of order) {
        const started = performance.now();
        const result = await invoke(binary, operation);
        timings[mode].push(performance.now() - started);
        assert.deepEqual(result, expected.JS, `${name} output changed`);
      }
    }

    const javascriptMs = median(timings.JS);
    const rustMs = median(timings.Rust);
    console.log(
      JSON.stringify({
        operation: name,
        javascriptMedianMs: Number(javascriptMs.toFixed(2)),
        rustMedianMs: Number(rustMs.toFixed(2)),
        rustOverJavascript: Number((rustMs / javascriptMs).toFixed(2)),
        outputsMatch: true,
      }),
    );
  }
} finally {
  if (originalBinary === undefined) delete process.env.RDSH_BIN;
  else process.env.RDSH_BIN = originalBinary;
  await fs.rm(fixture, { recursive: true, force: true });
}
