// Linux x86_64 filter shared by the built-in read-only tool and task workers.
// The process runs in a private network namespace; this additionally denies
// socket creation and kernel APIs that can submit network operations.
export function networkDenyFilter() {
  const instructions = [];
  const add = (code, jt, jf, k) => instructions.push({ code, jt, jf, k });
  add(0x20, 0, 0, 4);
  add(0x15, 1, 0, 0xc000003e);
  add(0x06, 0, 0, 0x80000000); // kill mismatched ABI
  add(0x20, 0, 0, 0);
  add(0x35, 0, 1, 0x40000000);
  add(0x06, 0, 0, 0x80000000); // reject x32 ABI syscall aliases
  // Keep the process inside the namespaces and limits established by the
  // launcher. clone3 is unavailable; libc may fall back to filtered clone.
  add(0x15, 0, 1, 435);
  add(0x06, 0, 0, 0x00050026); // ENOSYS
  add(0x15, 0, 3, 56);
  add(0x20, 0, 0, 16); // clone flags, low word of arg0
  add(0x45, 0, 1, 0x7e020080); // CLONE_NEW* flags
  add(0x06, 0, 0, 0x00050001);
  add(0x20, 0, 0, 0);
  for (const nr of [41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 55, 288, 425, 426, 427, 272, 308, 165, 166, 155, 161, 304, 321, 323, 298, 101, 310, 311]) {
    add(0x15, 0, 1, nr);
    add(0x06, 0, 0, 0x00050001); // EPERM
  }
  add(0x06, 0, 0, 0x7fff0000);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(({ code, jt, jf, k }, index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = jt;
    bytes[index * 8 + 3] = jf;
    bytes.writeUInt32LE(k, index * 8 + 4);
  });
  return bytes;
}
