// Short-lived native observer. Keeping Koffi out of the dashboard process lets
// managed release slots replace their Windows native module after child exit.
import { createHash } from "node:crypto";

const unknown = { status: "unknown" };
const pid = Number(process.argv[2]);
const validPid =
  /^[1-9][0-9]{0,9}$/.test(process.argv[2] || "") &&
  Number.isSafeInteger(pid) &&
  pid <= 2147483647;

async function observeProcess() {
  if (process.platform !== "win32" || !validPid) return unknown;
  const win = await import("@deepseek-ai/dsh-win32-process");
  const api = win.extendWin32ProcessBindings(({ advapi32, bind, kernel32 }) => ({
    openProcess: bind(kernel32, "OpenProcess", "void*", [
      "uint32",
      "int",
      "uint32",
    ]),
    getProcessTimes: bind(kernel32, "GetProcessTimes", "int", [
      "void*",
      "void*",
      "void*",
      "void*",
      "void*",
    ]),
    regGetValueW: bind(advapi32, "RegGetValueW", "int32", [
      "void*",
      "str16",
      "str16",
      "uint32",
      "void*",
      "void*",
      "void*",
    ]),
  }));

  // HKEY_LOCAL_MACHINE is a predefined sign-extended pseudo-handle on x64.
  const localMachine = 0xffff_ffff_8000_0002n;
  const subkey = "SOFTWARE\\Microsoft\\Cryptography";
  const valueName = "MachineGuid";
  const typeString = 0x2;
  const size = Buffer.alloc(4);
  const querySize = api.regGetValueW(
    localMachine,
    subkey,
    valueName,
    typeString,
    null,
    null,
    size,
  );
  const byteLength = size.readUInt32LE(0);
  if (querySize !== 0 || byteLength < 2 || byteLength > 1024 || byteLength % 2)
    return unknown;
  const data = Buffer.alloc(byteLength);
  size.writeUInt32LE(byteLength, 0);
  if (
    api.regGetValueW(
      localMachine,
      subkey,
      valueName,
      typeString,
      null,
      data,
      size,
    ) !== 0
  )
    return unknown;
  const machineGuid = data.toString("utf16le").replace(/\0+$/, "");
  if (!/^[0-9a-fA-F-]{36}$/.test(machineGuid)) return unknown;
  const scope = createHash("sha256")
    .update("win32:" + machineGuid)
    .digest("hex");

  const processHandle = api.openProcess(0x0010_1000, 0, pid);
  if (processHandle === null || processHandle === 0n)
    return api.getLastError() === 87
      ? { status: "gone", platform: "win32", scope }
      : unknown;
  try {
    const wait = api.waitForSingleObject(processHandle, 0);
    if (wait === 0) return { status: "gone", platform: "win32", scope };
    if (wait !== 258) return unknown;
    const creation = Buffer.alloc(8);
    if (
      api.getProcessTimes(
        processHandle,
        creation,
        Buffer.alloc(8),
        Buffer.alloc(8),
        Buffer.alloc(8),
      ) !== 1
    )
      return unknown;
    // Preserve the .NET DateTime.Ticks epoch used by persisted identities.
    const birth = (
      creation.readBigUInt64LE(0) + 504_911_232_000_000_000n
    ).toString();
    return {
      status: "observed",
      identity: { platform: "win32", pid, birth, scope },
    };
  } finally {
    api.closeHandle(processHandle);
  }
}

try {
  process.stdout.write(JSON.stringify(await observeProcess()) + "\n");
} catch {
  process.stdout.write(JSON.stringify(unknown) + "\n");
}
