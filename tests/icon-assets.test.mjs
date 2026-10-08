import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const binary = path.resolve(
  process.env.BIN ||
    `target/debug/rdsh${process.platform === "win32" ? ".exe" : ""}`,
);
for (const command of ["serve", "setup"]) {
  test(`${command} serves the common icon bytes without granting API access`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "rdsh-icon-"));
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: path.join(home, "dsh"),
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CACHE_HOME: home,
    };
    for (const key of Object.keys(env))
      if (/TOKEN|API_KEY|SECRET/i.test(key)) delete env[key];
    const settings = spawnSync(
      binary,
      ["settings", "set", "extras.enable", "serve"],
      { env, encoding: "utf8" },
    );
    assert.equal(settings.status, 0);
    const args =
      command === "setup"
        ? ["setup", "--web", "--port", "0"]
        : ["serve", "--port", "0"];
    const child = spawn(binary, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (b) => {
      output += b;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    });
    const deadline = Date.now() + 15000;
    while (!output.match(/http:\/\/127\.0\.0\.1:\d+/)) {
      assert.equal(
        child.exitCode,
        null,
        "owned icon fixture exited before becoming ready",
      );
      assert.ok(Date.now() < deadline, "owned icon fixture readiness timeout");
      await delay(25);
    }
    const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    for (const [route, file, type] of [
      ["/icon.png", "icon-256.png", "image/png"],
      ["/favicon.ico", "icon.ico", "image/x-icon"],
      ["/icon.svg", "icon.svg", "image/svg+xml"],
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), type);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(
        bytes,
        await readFile(new URL(`../assets/${file}`, import.meta.url)),
      );
      assert.equal(
        Number(response.headers.get("content-length")),
        bytes.length,
      );
      assert.equal(
        (
          await fetch(base + route, {
            headers: { origin: "https://evil.example" },
          })
        ).status,
        403,
      );
    }
    const api = command === "setup" ? "/api/status" : "/api/doctor";
    assert.equal((await fetch(base + api)).status, 401);
    assert.equal((await fetch(base + "/assets/../Cargo.toml")).status, 404);
    const html = await (await fetch(base)).text();
    assert.match(html, /rel="icon" type="image\/png" href="\/icon.png"/);
  });
}
