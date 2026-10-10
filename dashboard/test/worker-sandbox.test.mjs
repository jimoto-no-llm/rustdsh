import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { digest } from "../contracts.mjs";
import { executeSandboxedOperation, nestedMountPath, probeSandbox, sandboxCapability } from "../worker-sandbox.mjs";

test("mountinfo parser detects nested mount points without rejecting the contract root mount", () => {
  const root = "/workspace/repo";
  const mountInfo = [
    "36 25 0:32 / /workspace/repo rw,relatime - ext4 /dev/vda rw",
    "37 36 0:44 / /workspace/repo/cache\\040mount rw,relatime - tmpfs tmpfs rw",
  ].join("\n");
  assert.equal(nestedMountPath(root, mountInfo), "/workspace/repo/cache mount");
  assert.equal(nestedMountPath("/workspace/repo/cache mount", mountInfo), null);
  assert.equal(nestedMountPath(root,
    "36 25 0:32 / /workspace/repo rw,relatime - ext4 /dev/vda rw"), null);
});

test("unsupported platforms hold without starting a sandbox operation", async () => {
  const unsupported = await sandboxCapability({ platform: "win32", arch: "x64" });
  assert.deepEqual(unsupported, { supported: false, reason: "unsupported_platform" });
  const result = await executeSandboxedOperation({
    repository: "C:\\fixture", contract: { repository: "C:\\fixture" },
    workerRole: "review", input: {}, capability: unsupported,
  });
  assert.deepEqual(result, { execution: "not_started", reason: "unsupported_platform" });
});

test("Linux workers use the real bwrap and seccomp boundary for reads, writes, commands and child processes", async (t) => {
  if (process.platform !== "linux") { t.skip("Bubblewrap backend is Linux-only"); return; }
  const capability = await probeSandbox(undefined, { diagnostics: true });
  assert.equal(capability.supported, true,
    `sandbox probe failed: ${JSON.stringify(capability)}`);
  assert.equal(capability.backend, "bubblewrap+seccomp");

  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-sandbox-test-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const repository = path.join(temp, "repo"), src = path.join(temp, "repo", "src");
  const outside = path.join(repository, "outside"), outsideFile = path.join(outside, "secret.txt");
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(src, "input.txt"), "visible fixture");
  await fs.writeFile(outsideFile, "hidden fixture");
  const root = await fs.realpath(repository), readRoot = await fs.realpath(src);
  const python = await fs.realpath("/usr/bin/python3");
  const contractFor = (args = []) => ({
    repository: root,
    write_roots: [readRoot],
    worker_roles: ["review", "implementation"],
    operation_policy: {
      schema: 1, read_roots: [readRoot],
      executables: args.length ? [{ file: python, argument_count: args.length,
        arguments_digest: digest(args) }] : [],
      network_origins: ["https://allowed.example"],
    },
  });
  const input = (tool, toolInput) => ({ schema: "rdsh.operation.v1", tool_name: tool,
    tool_input: { cwd: root, ...toolInput } });

  const reviewWrite = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "review",
    input: input("file.write", { path: "src/denied.txt", content: "no" }), capability });
  assert.equal(reviewWrite.reason, "review_worker_read_only");
  const reviewCommand = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "review",
    input: input("process.exec", { executable: python, args: ["-c", "print('no')"] }), capability });
  assert.equal(reviewCommand.reason, "review_worker_read_only");
  const outsideRead = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "review",
    input: input("file.read", { path: outsideFile }), capability });
  assert.equal(outsideRead.reason, "read_outside_policy");

  const read = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "review",
    input: input("file.read", { path: "src/input.txt" }), capability });
  assert.equal(read.execution, "completed");
  assert.equal(read.stdout, "visible fixture");

  const write = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "implementation",
    input: input("file.write", { path: "src/new.txt", content: "inside only" }), capability });
  assert.equal(write.execution, "completed");
  assert.equal(await fs.readFile(path.join(src, "new.txt"), "utf8"), "inside only");
  const outsideWrite = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "implementation",
    input: input("file.write", { path: outsideFile, content: "changed" }), capability });
  assert.equal(outsideWrite.reason, "write_outside_policy");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "hidden fixture");

  const readEscape = path.join(src, "escape.txt");
  await fs.symlink(outsideFile, readEscape);
  const escapedRead = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "review",
    input: input("file.read", { path: "src/escape.txt" }), capability });
  assert.equal(escapedRead.reason, "read_outside_policy");
  await fs.rm(readEscape);

  const linkedAlias = path.join(src, "outside-alias.txt");
  await fs.link(outsideFile, linkedAlias);
  const hardlinkWrite = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "implementation",
    input: input("file.write", { path: "src/new.txt", content: "must hold" }), capability });
  assert.equal(hardlinkWrite.reason, "sandbox_hardlink_in_write_root");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "hidden fixture");
  await fs.rm(linkedAlias);

  const writeEscape = path.join(src, "write-escape.txt");
  await fs.symlink(outsideFile, writeEscape);
  const symlinkWrite = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "implementation",
    input: input("file.write", { path: "src/new.txt", content: "must hold" }), capability });
  assert.equal(symlinkWrite.reason, "sandbox_symlink_in_write_root");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "hidden fixture");
  await fs.rm(writeEscape);

  const childCode = `import socket\ntry:\n open(${JSON.stringify(outsideFile)},'w').write('escape')\n fs='escaped'\nexcept OSError:\n fs='blocked'\ntry:\n socket.socket()\n net='escaped'\nexcept OSError:\n net='blocked'\nprint(fs+':'+net)`;
  const parentCode = `import subprocess,sys\nc=subprocess.run([sys.executable,'-c',${JSON.stringify(childCode)}],capture_output=True,text=True)\nprint(c.stdout.strip())\nsys.exit(c.returncode)`;
  const args = ["-c", parentCode];
  const processContract = contractFor(args);
  const child = await executeSandboxedOperation({ repository: root,
    contract: processContract, workerRole: "implementation",
    input: input("process.exec", { cwd: readRoot, executable: python, args }),
    evaluated: { cwd: readRoot, executable: python }, capability });
  assert.equal(child.execution, "completed", child.stderr);
  assert.equal(child.stdout.trim(), "blocked:blocked");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "hidden fixture");
  const otherArgs = ["-c", "print('unapproved')"];
  const unapproved = await executeSandboxedOperation({ repository: root,
    contract: processContract, workerRole: "implementation",
    input: input("process.exec", { cwd: readRoot, executable: python, args: otherArgs }),
    evaluated: { cwd: readRoot, executable: python }, capability });
  assert.equal(unapproved.reason, "executable_or_arguments_outside_policy");

  const unapprovedNetwork = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "implementation",
    input: input("network.request", { url: "https://blocked.example/", method: "GET", body: "" }),
    capability, networkOptions: { request: () => { throw new Error("must_not_request"); } } });
  assert.equal(unapprovedNetwork.reason, "network_origin_outside_policy");
  const network = await executeSandboxedOperation({ repository: root,
    contract: contractFor(), workerRole: "implementation",
    input: input("network.request", { url: "https://allowed.example/data", method: "GET", body: "" }),
    capability,
    networkOptions: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: (options, callback) => {
        assert.equal(options.hostname, "allowed.example");
        options.lookup(options.hostname, {}, (error, address) => {
          assert.equal(error, null);
          assert.equal(address, "93.184.216.34");
        });
        const request = new EventEmitter();
        request.setTimeout = () => {};
        request.end = () => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = { "content-type": "text/plain" };
          queueMicrotask(() => {
            callback(response);
            response.emit("data", Buffer.from("approved origin"));
            response.emit("end");
          });
        };
        request.write = () => {};
        request.destroy = (error) => request.emit("error", error);
        return request;
      },
    },
  });
  assert.equal(network.execution, "completed");
  assert.equal(network.body, "approved origin");
});
