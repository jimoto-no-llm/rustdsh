import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  createArtifactPreview,
  maximumArtifactBytes,
  maximumTextPreviewBytes,
} from "../artifact-preview.mjs";
import { identity } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function fixture(t) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-artifact-preview-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  return {
    temporary,
    project: { id: "fixture", root, directory: path.join(temporary, "state") },
  };
}

function event(artifact, sequence = 1) {
  return { sequence, type: "artifact", artifact };
}

test(
  "text previews redact common credentials, stay bounded, and leave source bytes untouched",
  async (t) => {
  const { project } = await fixture(t);
  await fs.mkdir(path.join(project.root, "qa"));
  const source = Buffer.from(
    "report\nOPENAI_API_KEY=sk-proj-123456789012345678901234\n" +
      "Authorization: Bearer ghp_123456789012345678901234567890123456\n" +
      "keep this line\n",
  );
  const file = path.join(project.root, "qa", "report.log");
  await fs.writeFile(file, source);

  const preview = await createArtifactPreview(
    project,
    [event("qa/report.log")],
    1,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.kind, "text");
  assert.equal(preview.redacted, true);
  assert.equal(preview.truncated, false);
  const value = preview.bytes.toString("utf8");
  assert.match(value, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(value, /sk-proj-123/);
  assert.doesNotMatch(value, /ghp_123/);
  assert.match(value, /keep this line/);
  assert.deepEqual(await fs.readFile(file), source);

  await fs.writeFile(file, Buffer.alloc(maximumTextPreviewBytes + 8, 0x61));
  const truncated = await createArtifactPreview(
    project,
    [event("qa/report.log")],
    1,
  );
  assert.equal(truncated.status, 200);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.bytes.length, maximumTextPreviewBytes);
  },
);

test("path traversal, absolute paths, dotfiles, HTML, and binary text are refused", async (t) => {
  const { project } = await fixture(t);
  const outside = path.join(project.root, "..", "outside.txt");
  await fs.writeFile(outside, "private");
  await fs.writeFile(
    path.join(project.root, "page.html"),
    "<script>alert(1)</script>",
  );
  await fs.writeFile(path.join(project.root, "binary.log"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(project.root, ".env"), "API_KEY=hidden");

  for (const reference of [
    "../outside.txt",
    outside,
    ".env",
    "page.html",
    "binary.log",
    "C:/Windows/win.ini",
  ]) {
    const preview = await createArtifactPreview(project, [event(reference)], 1);
    assert.notEqual(preview.status, 200, reference);
    assert.equal(JSON.stringify(preview).includes("private"), false);
  }
  assert.equal(
    (await createArtifactPreview(project, [event("safe.txt")], 999)).status,
    404,
  );
  assert.equal(
    (
      await createArtifactPreview(
        project,
        [event("safe.txt"), event("other.txt")],
        1,
      )
    ).status,
    404,
  );
});

test("symlink targets are refused, including links outside the project", async (t) => {
  const { temporary, project } = await fixture(t);
  const outside = path.join(temporary, "outside.log");
  await fs.writeFile(outside, "outside secret");
  const link = path.join(project.root, "linked.log");
  try {
    await fs.symlink(outside, link);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const preview = await createArtifactPreview(project, [event("linked.log")], 1);
  assert.equal(preview.status, 422);
  assert.doesNotMatch(JSON.stringify(preview), /outside secret/);
});

test("file size cap and image signature checks reject misleading or oversized files", async (t) => {
  const { project } = await fixture(t);
  await fs.writeFile(
    path.join(project.root, "large.log"),
    Buffer.alloc(maximumArtifactBytes + 1),
  );
  await fs.writeFile(path.join(project.root, "mismatch.png"), "not a png");
  await fs.writeFile(
    path.join(project.root, "preview.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  assert.equal((await createArtifactPreview(project, [event("large.log")], 1)).status, 413);
  assert.equal((await createArtifactPreview(project, [event("mismatch.png")], 1)).status, 415);
  const image = await createArtifactPreview(project, [event("preview.png")], 1);
  assert.equal(image.status, 200);
  assert.equal(image.kind, "image");
  assert.equal(image.mime, "image/png");
});

test(
  "the HTTP preview is browser-authenticated, project-scoped, no-store, and never serves raw HTML",
  async (t) => {
  const { temporary, project } = await fixture(t);
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "home");
  await fs.mkdir(path.join(project.root, "qa"));
  const file = path.join(project.root, "qa", "report.txt");
  await fs.writeFile(file, "status\nAPI_KEY=secret-value\n");
  const canonicalProject = await identity(project.root);
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));

  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
    else delete process.env.RDSH_DASHBOARD_HOME;
  });
  dashboard = await startDashboard({ project: canonicalProject, port, tailscale: false });
  await dashboard.store.mutate("event", {
    type: "artifact",
    title: "QA report",
    artifact: "qa/report.txt",
  });
  const sequence = dashboard.store.value.events[0].sequence;
  const browserToken = new URLSearchParams(new URL(dashboard.browserUrl).hash.slice(1)).get("key");
  const runtime = JSON.parse(
    await fs.readFile(
      path.join(canonicalProject.directory, "runtime.json"),
      "utf8",
    ),
  );

  const denied = await fetch(`${dashboard.localUrl}api/artifacts/${sequence}`);
  assert.equal(denied.status, 401);
  const mcpDenied = await fetch(`${dashboard.localUrl}api/artifacts/${sequence}`, {
    headers: { authorization: `Bearer ${runtime.mcp_token}` },
  });
  assert.equal(mcpDenied.status, 401);
  const response = await fetch(`${dashboard.localUrl}api/artifacts/${sequence}`, {
    headers: { "x-rdsh-browser-token": browserToken },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-rdsh-preview-redacted"), "true");
  assert.doesNotMatch(await response.text(), /secret-value/);
  assert.equal(await fs.readFile(file, "utf8"), "status\nAPI_KEY=secret-value\n");

  const html = await fetch(`${dashboard.localUrl}api/artifacts/${sequence + 1}`, {
    headers: { "x-rdsh-browser-token": browserToken },
  });
  assert.equal(html.status, 404);
  },
);
