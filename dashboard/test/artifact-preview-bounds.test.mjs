import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createArtifactPreview,
  maximumArtifactBytes,
  maximumTextPreviewBytes,
} from "../artifact-preview.mjs";

const exec = promisify(execFile);
const probe = fileURLToPath(new URL("./fixtures/artifact-preview-probe.mjs", import.meta.url));

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-preview-bounds-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "report.log") };
}

function preview(root) {
  return createArtifactPreview(
    { root },
    [{ sequence: 1, type: "artifact", artifact: "report.log" }],
    1,
  );
}

async function isolated(root, mode) {
  const { stdout } = await exec(process.execPath, [probe, root, mode], {
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 2 * maximumArtifactBytes,
  });
  return JSON.parse(stdout);
}

test("maximum-size ordinary and malformed URL text completes under an external watchdog", async (t) => {
  const { root, file } = await fixture(t);
  for (const prefix of [
    "a",
    "a".repeat(maximumArtifactBytes - 3) + "://",
    "http://" + "u".repeat(maximumArtifactBytes - 7),
    "http://u:" + "p".repeat(maximumArtifactBytes - 9),
    "a://u:p:",
  ]) {
    const source = prefix.repeat(Math.ceil(maximumArtifactBytes / prefix.length)).slice(0, maximumArtifactBytes);
    await fs.writeFile(file, source);
    const result = await isolated(root, "text");
    assert.equal(result.status, 200);
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, source.slice(0, maximumTextPreviewBytes));
  }
});

test("long URL user-info is masked before preview truncation", async (t) => {
  const { root, file } = await fixture(t);
  await fs.writeFile(file, "http://" + "u".repeat(maximumTextPreviewBytes) +
    ":" + "p".repeat(maximumTextPreviewBytes) + "@host");
  const result = await isolated(root, "text");
  assert.equal(result.status, 200);
  assert.equal(result.redacted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.bytes, "http://[REDACTED]@host");
});

test("URL credentials are masked without rewriting schemes or ordinary near-matches", async (t) => {
  const { root, file } = await fixture(t);
  const source = "HTTP+git.2://user:p:a:ss@host/path ftp://é:秘密@host\n" +
    "123abc://u:p@host ://u:p@host http://u@host http://:p@host http://u:@host\n" +
    "http://bad/path@host http://bad://u:p@host a://a://u:p@host";
  await fs.writeFile(file, source);
  const result = await preview(root);
  assert.equal(result.status, 200);
  assert.equal(result.redacted, true);
  assert.equal(result.bytes.toString(), "HTTP+git.2://[REDACTED]@host/path ftp://[REDACTED]@host\n" +
    "123abc://[REDACTED]@host ://u:p@host http://u@host http://:p@host http://u:@host\n" +
    "http://bad/path@host http://bad://[REDACTED]@host a://a://[REDACTED]@host");
  assert.equal(await fs.readFile(file, "utf8"), source);
});

test("redaction covers credentials and private keys across the display boundary", async (t) => {
  const { root, file } = await fixture(t);
  for (const secret of [
    "https://user:synthetic-password@host/" + "x".repeat(80),
    "-----BEGIN PRIVATE KEY-----\nsynthetic-key\n-----END PRIVATE KEY-----" + "x".repeat(80),
    'password="synthetic-password' + "x".repeat(80) + '"',
  ]) {
    const source = " ".repeat(maximumTextPreviewBytes - 16) + secret;
    await fs.writeFile(file, source);
    const result = await preview(root);
    assert.equal(result.status, 200);
    assert.equal(result.redacted, true);
    assert.ok(result.bytes.length <= maximumTextPreviewBytes);
    assert.doesNotMatch(result.bytes.toString(), /synthetic|user:|BEGIN PRIVATE/);
    assert.equal(await fs.readFile(file, "utf8"), source);
  }
});

test("UTF-8 truncation keeps complete two-, three-, and four-byte code points", async (t) => {
  const { root, file } = await fixture(t);
  for (const character of ["é", "日", "😀"]) {
    const width = Buffer.byteLength(character);
    for (let remaining = 0; remaining <= width; remaining++) {
      const prefix = " ".repeat(maximumTextPreviewBytes - remaining);
      const source = prefix + character;
      await fs.writeFile(file, source);
      const result = await preview(root);
      assert.equal(result.status, 200);
      assert.equal(result.truncated, remaining < width);
      const decoded = new TextDecoder("utf8", { fatal: true }).decode(result.bytes);
      assert.equal(decoded, remaining < width ? prefix : source);
      assert.ok(result.bytes.length <= maximumTextPreviewBytes);
      assert.equal(await fs.readFile(file, "utf8"), source);
    }
  }
});

for (const mode of ["fifo", "replace"]) {
  test(`a ${mode === "fifo" ? "pre-existing FIFO" : "regular file replaced by a FIFO before open"} is rejected without reading`, {
    skip: process.platform === "win32" ? "POSIX FIFO requires mkfifo" : false,
  }, async (t) => {
    const { root, file } = await fixture(t);
    if (mode === "fifo") await exec("mkfifo", [file]);
    else await fs.writeFile(file, "regular file");
    const result = await isolated(root, mode);
    assert.equal(result.status, 415);
    assert.equal(result.bytes, undefined);
  });
}
