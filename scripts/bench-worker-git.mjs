import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  legacyWorkerGitRequest,
  nativeWorkerGitRequest,
  requireWorkerGitExecutable,
} from "../dashboard/worker-git.mjs";

const nativeBinary = process.env.RDSH_BENCH_BIN;
if (!nativeBinary || !path.isAbsolute(nativeBinary)) {
  throw new Error("RDSH_BENCH_BIN must be an absolute path");
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-git-bench-"));
const root = path.join(fixture, "repo");

function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function withRDSHBinary(binary, operation) {
  const originalBinary = process.env.RDSH_BIN;
  process.env.RDSH_BIN = binary;
  try {
    return await operation();
  } finally {
    if (originalBinary === undefined) delete process.env.RDSH_BIN;
    else process.env.RDSH_BIN = originalBinary;
  }
}

async function requireNativeWorkerGit(binary) {
  try {
    return await withRDSHBinary(binary, () => requireWorkerGitExecutable());
  } catch {
    throw new Error("RDSH_BENCH_BIN must support worker-git");
  }
}

function median(values) {
  return [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ];
}

async function prepareNativeBinary(sourcePath) {
  const executionPath = path.join(
    fixture,
    process.platform === "win32" ? "rdsh.exe" : "rdsh",
  );
  const source = await fs.stat(sourcePath);
  await fs.copyFile(sourcePath, executionPath);
  if (process.platform !== "win32") {
    await fs.chmod(executionPath, source.mode & 0o777);
  }
  return {
    sourcePath,
    executionPath,
    sha256: createHash("sha256").update(await fs.readFile(executionPath)).digest("hex"),
  };
}

try {
  const nativeSourcePath = await requireNativeWorkerGit(nativeBinary);
  const nativeBinaryMetadata = await prepareNativeBinary(nativeSourcePath);
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

  const metadata = await legacyWorkerGitRequest({ op: "repository", root });
  const operations = [
    [
      "repository",
      () => legacyWorkerGitRequest({ op: "repository", root }),
      () =>
        nativeWorkerGitRequest(
          { op: "repository", root },
          nativeBinaryMetadata.executionPath,
        ),
    ],
    [
      "sourceSnapshot",
      () => legacyWorkerGitRequest({ op: "source-snapshot", root }),
      () =>
        nativeWorkerGitRequest(
          { op: "source-snapshot", root },
          nativeBinaryMetadata.executionPath,
        ),
    ],
    [
      "dirtyPaths",
      () => legacyWorkerGitRequest({ op: "dirty-paths", root }),
      () =>
        nativeWorkerGitRequest(
          { op: "dirty-paths", root },
          nativeBinaryMetadata.executionPath,
        ),
    ],
    [
      "observeWorktree",
      () =>
        legacyWorkerGitRequest({
          op: "observe-worktree",
          root,
          git_common_dir: metadata.git_common_dir,
          branch: metadata.branch,
          base,
        }),
      () =>
        nativeWorkerGitRequest(
          {
            op: "observe-worktree",
            root,
            git_common_dir: metadata.git_common_dir,
            branch: metadata.branch,
            base,
          },
          nativeBinaryMetadata.executionPath,
        ),
    ],
  ];
  console.log(
    JSON.stringify({
      benchmark: "worker-git",
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      fixture: { tracked: 128, dirty: 8 },
      warmupsPerMode: 1,
      alternatingPairs: 7,
      nativeBinary: nativeBinaryMetadata,
      measurementBoundary: {
        timingScope: "operation-request-only",
        excludes: [
          "native-binary-discovery",
          "worker-git-capability-preflight",
          "fixture-setup",
          "output-parity-check",
          "warmup",
        ],
      },
    }),
  );

  for (const [name, javascript, rust] of operations) {
    const timings = { JS: [], Rust: [] };
    const expected = {};
    const modes = [
      ["JS", javascript],
      ["Rust", rust],
    ];
    for (const [mode, operation] of modes) {
      expected[mode] = await operation();
    }
    assert.deepEqual(expected.Rust, expected.JS, `${name} output differs`);
    for (const [, operation] of modes) await operation();

    for (let pair = 0; pair < 7; pair++) {
      const order = pair % 2 === 0 ? modes : [...modes].reverse();
      for (const [mode, operation] of order) {
        const started = performance.now();
        const result = await operation();
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
        javascriptSamplesMs: timings.JS,
        rustSamplesMs: timings.Rust,
        outputsMatch: true,
      }),
    );
  }
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
