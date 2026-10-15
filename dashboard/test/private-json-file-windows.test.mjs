import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPrivateJsonFile } from "../private-json-file.mjs";

const exec = promisify(execFile);
const windows = process.platform === "win32";
const document = { operation: "schema", state: { note: "日本語 / 中文 {id}" } };
async function powershell(script, env) {
  const binary = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await exec(binary, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, ...env }, windowsHide: true, timeout: 15000,
  });
  return JSON.parse(stdout.trim());
}
const aclScript = `
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:RDSH_QA_FILE
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Role($reference) {
 $sid=$reference.Translate([Security.Principal.SecurityIdentifier]).Value
 if($sid -eq $current){return 'CURRENT_USER'}
 if($sid -eq 'S-1-5-18'){return 'SYSTEM'}
 if($sid -eq 'S-1-5-32-544'){return 'ADMINISTRATORS'}
 return 'OTHER'
}
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
 [ordered]@{role=(Role $_.IdentityReference);type=$_.AccessControlType.ToString();inherited=$_.IsInherited;rights=[int]$_.FileSystemRights}
})
$parent=Get-Acl -LiteralPath (Split-Path -Parent $env:RDSH_QA_FILE)
$digest=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($parent.GetSecurityDescriptorBinaryForm())).Replace('-','').ToLowerInvariant()
$fileDigest=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($acl.GetSecurityDescriptorBinaryForm())).Replace('-','').ToLowerInvariant()
[ordered]@{ownerRole=(Role ($acl.GetOwner([Security.Principal.SecurityIdentifier])));protected=$acl.AreAccessRulesProtected;rules=$rules;parentDigest=$digest;fileDigest=$fileDigest}|ConvertTo-Json -Depth 5 -Compress
`;

for (const broadParent of [false, true])
  test(`Windows creates a protected file atomically under ${broadParent ? "an explicitly shared" : "the default temporary"} parent and holds its name until disposal`, { skip: !windows }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-private-windows-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    if (broadParent) {
      await powershell(`
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:RDSH_QA_PARENT
$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:RDSH_QA_PARENT -AclObject $acl
'{}'
`, { RDSH_QA_PARENT: root });
    }
    const parent = path.join(root, "保持する 親");
    await fs.mkdir(parent);
    const file = path.join(parent, "要求 日本語.json");
    const sentinel = path.join(parent, "parent-digest-only.json");
    await fs.writeFile(sentinel, "{}");
    const before = await powershell(aclScript, { RDSH_QA_FILE: sentinel });
    await assert.rejects(createPrivateJsonFile(sentinel, document), error => error.operation === "CreateFileW" && error.code === 80);
    assert.equal(await fs.readFile(sentinel, "utf8"), "{}");
    assert.equal((await powershell(aclScript, { RDSH_QA_FILE: sentinel })).fileDigest, before.fileDigest);
    await fs.unlink(sentinel);
    const lease = await createPrivateJsonFile(file, document);
    try {
      const observed = await powershell(aclScript, { RDSH_QA_FILE: file });
      assert.equal(observed.protected, true);
      assert.equal(observed.ownerRole, "CURRENT_USER");
      assert.equal(observed.parentDigest, before.parentDigest);
      assert.ok(observed.rules.length >= 2);
      assert.ok(observed.rules.every(rule => ["CURRENT_USER", "SYSTEM", "ADMINISTRATORS"].includes(rule.role) && rule.type === "Allow" && !rule.inherited));
      const read = await exec(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", file], { encoding: "buffer", windowsHide: true, timeout: 15000 });
      assert.deepEqual(read.stdout, Buffer.from(JSON.stringify(document)));
      for (const change of [() => fs.rename(file, path.join(root, "replaced.json")), () => fs.writeFile(file, "replacement")])
        await assert.rejects(change(), error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
      assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(document));
      for (const directory of [parent, root]) {
        const moved = `${directory}-moved`;
        let renamed = false;
        try { await fs.rename(directory, moved); renamed = true; }
        catch (error) { assert.ok(["EPERM", "EACCES", "EBUSY"].includes(error.code), error.code); }
        if (renamed) await fs.rename(moved, directory);
        assert.equal(renamed, false, "a request ancestor can be renamed while its child lease is held");
      }
    } finally { await lease.dispose(); }
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  });

test("Windows preserves UTF-8 requests through long Japanese paths", { skip: !windows }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-private-long-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let parent = root;
  while (parent.length < 300) parent = path.join(parent, "日本語の長い パス-abcdefghijklmnopqrstuvwxyz");
  await fs.mkdir(parent, { recursive: true });
  const file = path.join(parent, "要求 日本語.json");
  const lease = await createPrivateJsonFile(file, document);
  try { assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(document)); }
  finally { await lease.dispose(); }
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
