// Owned JSON request files: POSIX mode 0600 or an atomic protected Windows DACL.
import fs from "node:fs/promises";
import path from "node:path";

/** A Windows API failure without paths, account names or SID values. */
export class PrivateJsonFileError extends Error {
  constructor(operation, code) {
    super(`Private JSON file ${operation} failed (${code})`);
    this.name = "PrivateJsonFileError";
    this.operation = operation;
    this.code = code;
  }
}

const windowsError = (operation, error) =>
  error instanceof PrivateJsonFileError
    ? error
    : new PrivateJsonFileError(operation, error.code ?? "UNAVAILABLE");
let nativeApi;
async function windowsApi() {
  if (!nativeApi) nativeApi = loadWindowsApi();
  return nativeApi;
}

async function loadWindowsApi() {
  try {
    const { default: koffi } = await import("koffi");
    const kernel = koffi.load("kernel32.dll");
    const security = koffi.load("advapi32.dll");
    const attributes = koffi.struct({
      nLength: "uint32_t",
      lpSecurityDescriptor: "void *",
      bInheritHandle: "int",
    });
    const currentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
    const lastError = kernel.func("uint32_t __stdcall GetLastError()");
    const close = kernel.func("int __stdcall CloseHandle(void *handle)");
    const free = kernel.func("void * __stdcall LocalFree(void *memory)");
    const openToken = security.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
    const tokenInfo = security.func("int __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ uint32_t *needed)");
    const sidString = security.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");
    const descriptor = security.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)");
    const descriptorDacl = security.func("int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)");
    const descriptorOwner = security.func("int __stdcall GetSecurityDescriptorOwner(void *descriptor, _Out_ void **owner, _Out_ int *defaulted)");
    const descriptorControl = security.func("int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)");
    const aclInfo = security.func("int __stdcall GetAclInformation(void *acl, void *buffer, uint32_t size, int kind)");
    const getAce = security.func("int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)");
    const equalSid = security.func("int __stdcall EqualSid(void *left, void *right)");
    const getSecurity = security.func("uint32_t __stdcall GetSecurityInfo(void *handle, int kind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)");
    const create = kernel.func("__stdcall", "CreateFileW", "void *", [
      "str16", "uint32_t", "uint32_t", koffi.pointer(attributes),
      "uint32_t", "uint32_t", "void *",
    ]);
    const write = kernel.func("int __stdcall WriteFile(void *handle, const uint8_t *buffer, uint32_t size, _Out_ uint32_t *written, void *overlapped)");
    const invalidHandle = (1n << BigInt(koffi.sizeof("void *") * 8)) - 1n;
    const fail = (operation) => { throw new PrivateJsonFileError(operation, lastError()); };
    const entries = (acl) => {
      const size = Buffer.alloc(12);
      if (!acl || !aclInfo(acl, size, size.length, 2)) fail("GetAclInformation");
      const count = size.readUInt32LE(0);
      if (count < 2 || count > 3)
        throw new PrivateJsonFileError("GetAclInformation", "UNEXPECTED_ACE_COUNT");
      const result = [];
      for (let index = 0; index < count; index++) {
        const ace = [null];
        if (!getAce(acl, index, ace)) fail("GetAce");
        const header = Buffer.from(koffi.decode(ace[0], "uint8_t", 4));
        const length = header.readUInt16LE(2);
        if (header[0] !== 0 || header[1] !== 0 || length < 8)
          throw new PrivateJsonFileError("GetAce", "UNEXPECTED_ACE");
        result.push(Buffer.from(koffi.decode(ace[0], "uint8_t", length)).toString("hex"));
      }
      return result.sort();
    };
    return {
      descriptor() {
        const token = [null], text = [null], sd = [null];
        try {
          if (!openToken(currentProcess(), 8, token)) fail("OpenProcessToken");
          const needed = [0];
          if (tokenInfo(token[0], 1, null, 0, needed) || lastError() !== 122 || !needed[0])
            throw new PrivateJsonFileError("GetTokenInformation", "INVALID_TOKEN_SIZE");
          const buffer = Buffer.alloc(needed[0]);
          if (!tokenInfo(token[0], 1, buffer, buffer.length, needed)) fail("GetTokenInformation");
          const user = koffi.decode(buffer, "void *");
          if (!sidString(user, text)) fail("ConvertSidToStringSidW");
          const sid = koffi.decode.string16(text[0]);
          const trusted = [...new Set([sid, "S-1-5-18", "S-1-5-32-544"])];
          const sddl = `O:${sid}D:P${trusted.map(value => `(A;;FA;;;${value})`).join("")}`;
          if (!descriptor(sddl, 1, sd, null)) fail("ConvertStringSecurityDescriptorToSecurityDescriptorW");
          const dacl = [null], owner = [null], present = [0], defaulted = [0];
          if (!descriptorDacl(sd[0], present, dacl, defaulted) || !present[0] || !dacl[0])
            throw new PrivateJsonFileError("GetSecurityDescriptorDacl", "MISSING_DACL");
          if (!descriptorOwner(sd[0], owner, defaulted) || !owner[0]) fail("GetSecurityDescriptorOwner");
          const expected = entries(dacl[0]);
          const value = { pointer: sd[0], owner: owner[0], entries: expected };
          sd[0] = null;
          return value;
        } finally {
          if (sd[0]) free(sd[0]);
          if (text[0]) free(text[0]);
          if (token[0]) close(token[0]);
        }
      },
      create(file, sd) {
        // CREATE_NEW plus delete-on-close owns the object through native reading.
        // No shared write/delete handles can replace its name while held.
        const genericWrite = 0x40000000, deleteAccess = 0x10000;
        const shareRead = 1, createNew = 1;
        const normal = 0x80, deleteOnClose = 0x04000000;
        const handle = create(path.toNamespacedPath(file), genericWrite | deleteAccess, shareRead, {
          nLength: koffi.sizeof(attributes), lpSecurityDescriptor: sd.pointer, bInheritHandle: 0,
        }, createNew, normal | deleteOnClose, null);
        if (handle === null || handle === invalidHandle || handle === -1n) fail("CreateFileW");
        return handle;
      },
      verify(handle, expected) {
        const owner = [null], dacl = [null], sd = [null];
        try {
          const code = getSecurity(handle, 1, 5, owner, null, dacl, null, sd);
          if (code) throw new PrivateJsonFileError("GetSecurityInfo", code);
          const control = [0], revision = [0];
          if (!descriptorControl(sd[0], control, revision)) fail("GetSecurityDescriptorControl");
          if (!(control[0] & 0x1000) || !owner[0] || !equalSid(owner[0], expected.owner) || !dacl[0])
            throw new PrivateJsonFileError("GetSecurityInfo", "UNPROTECTED_DACL");
          const actual = entries(dacl[0]);
          if (actual.length !== expected.entries.length || actual.some((value, index) => value !== expected.entries[index]))
            throw new PrivateJsonFileError("GetSecurityInfo", "UNEXPECTED_DACL");
        } finally { if (sd[0]) free(sd[0]); }
      },
      write(handle, bytes) {
        const written = [0];
        if (!write(handle, bytes, bytes.length, written, null)) fail("WriteFile");
        return written[0];
      },
      close(handle) { if (!close(handle)) fail("CloseHandle"); },
      release(sd) { free(sd.pointer); },
    };
  } catch (error) { throw windowsError("Koffi", error); }
}

/**
 * Create one exclusive UTF-8 JSON file and hold its creator until disposal.
 * Windows sets and verifies a protected DACL before writing any payload bytes.
 * @param {string} file Unique caller-owned request path.
 * @param {object} document Parsed JSON request, serialized without translation.
 * @param {object} options Platform and native Windows API providers.
 * @returns {Promise<{dispose: function(): Promise<void>}>} Exact file cleanup lease.
 */
export async function createPrivateJsonFile(file, document, {
  platform = process.platform, nativeReader = windowsApi,
} = {}) {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  let dispose;
  if (platform === "win32") {
    let api, sd, handle, owned = false;
    const cleanup = async () => api.close(handle);
    try {
      api = await nativeReader();
      sd = api.descriptor();
      try {
        handle = api.create(file, sd);
        owned = true;
        api.verify(handle, sd);
        for (let offset = 0; offset < bytes.length;) {
          const written = api.write(handle, bytes.subarray(offset));
          if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset)
            throw new PrivateJsonFileError("WriteFile", "INVALID_BYTE_COUNT");
          offset += written;
        }
      } finally { api.release(sd); }
    } catch (error) {
      if (owned) {
        try { await cleanup(); }
        catch (cleanupError) { throw windowsError("CloseHandle", cleanupError); }
      }
      throw windowsError("Koffi", error);
    }
    dispose = async () => {
      try { await cleanup(); }
      catch (error) { throw windowsError("CloseHandle", error); }
    };
  } else {
    const handle = await fs.open(file, "wx", 0o600);
    const cleanup = async () => {
      try { await handle.close(); }
      finally { await fs.unlink(file); }
    };
    try { await handle.writeFile(bytes); }
    catch (error) { await cleanup(); throw error; }
    dispose = cleanup;
  }
  let disposal;
  return { dispose: () => disposal ??= dispose() };
}
