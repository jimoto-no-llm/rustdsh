import { constants as C } from 'node:fs';
import { open, opendir, realpath, lstat, mkdir, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PLANS = 4;
const TTL = 10 * 60 * 1000;
const folderPattern = /^rdsh-organized-([a-f0-9]{32})$/;
const groups = {
  写真: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'tiff'],
  資料: ['pdf', 'doc', 'docx', 'txt', 'md', 'ppt', 'pptx', 'odt'],
  表: ['xls', 'xlsx', 'csv', 'tsv', 'ods'],
  動画: ['mp4', 'mov', 'mkv', 'webm'],
  音声: ['mp3', 'wav', 'm4a', 'flac', 'ogg'],
};
const fail = code => Object.assign(new Error(code), { code });
const identity = s => [s.dev, s.ino].map(String).join(':');
const fingerprint = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const directoryFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
const readFlags = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;
const anchor = handle => `/proc/self/fd/${handle.fd}`;
const groupOf = name => Object.entries(groups).find(([, list]) => list.includes(name.split('.').at(-1).toLowerCase()))?.[0] || 'その他';

// Preview reads metadata only. Linux execution stays relative to opened directory
// handles; no path-based fallback is used on other platforms. Originals are never
// changed, and undo archives the entire copy directory without deleting files.
export function createOrganizer({ platform = process.platform, now = Date.now } = {}) {
  const plans = new Map();
  let closed = false;
  let pending = Promise.resolve(), admitted = 0;
  function serial(operation) {
    if (closed) return Promise.reject(fail('CLOSED'));
    if (admitted >= 8) return Promise.reject(fail('WORK_IN_PROGRESS'));
    admitted++;
    const result = pending.then(() => { if (closed) throw fail('CLOSED'); return operation(); });
    pending = result.catch(() => {});
    return result.finally(() => { admitted--; });
  }
  async function discard(plan) { clearTimeout(plan.timer); plans.delete(plan.id); await plan.root?.close(); }
  function touch(plan) {
    clearTimeout(plan.timer);
    plan.expiresAt = now() + TTL;
    plan.timer = setTimeout(() => serial(async () => {
      if (plans.get(plan.id) === plan && !plan.busy && plan.expiresAt <= now()) await discard(plan);
    }).catch(() => {}), TTL);
    plan.timer.unref();
  }
  function publicPlan(p) {
    return { id: p.id, folder: p.path, output: p.output ? join(p.path, p.output) : null,
      executable: platform === 'linux', state: p.state, copied: p.copied || 0,
      entries: p.entries.map(({ name, group, size }) => ({ name, group, size })),
      bytes: p.bytes, skipped: p.skipped, expiresAt: p.expiresAt };
  }
  async function sweep() {
    for (const p of [...plans.values()]) if (!p.busy && p.expiresAt <= now()) await discard(p);
  }
  function get(id) {
    const p = plans.get(id);
    if (closed || !p || p.expiresAt <= now()) throw fail('PLAN_EXPIRED');
    if (p.busy) throw fail('WORK_IN_PROGRESS');
    return p;
  }
  async function preview(path) {
    if (closed) throw fail('CLOSED');
    await sweep();
    if (plans.size >= MAX_PLANS) throw fail('TOO_MANY_PLANS');
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) throw fail('INVALID_FOLDER');
    const canonical = await realpath(path);
    const before = await lstat(canonical, { bigint: true });
    if (!before.isDirectory()) throw fail('INVALID_FOLDER');
    const root = platform === 'linux' ? await open(canonical, directoryFlags) : undefined;
    try {
      if (root && identity(await root.stat({ bigint: true })) !== identity(before)) throw fail('FOLDER_CHANGED');
      const base = root ? anchor(root) : canonical;
      const entries = [];
      let skipped = 0, bytes = 0, scanned = 0;
      // Bound the directory scan as well as the copy; oversized folders require
      // choosing a smaller folder, rather than silently organizing a subset.
      const directory = await opendir(base);
      for await (const entry of directory) {
        if (++scanned > 1000) throw fail('FOLDER_TOO_LARGE');
        if (!entry.isFile() || entry.name.startsWith('.')) { skipped++; continue; }
        const s = await lstat(join(base, entry.name), { bigint: true });
        if (!s.isFile() || s.nlink !== 1n) { skipped++; continue; }
        bytes += Number(s.size);
        if (entries.length >= MAX_FILES || bytes > MAX_BYTES) throw fail('FOLDER_TOO_LARGE');
        entries.push({ name: entry.name, group: groupOf(entry.name), size: Number(s.size), fingerprint: fingerprint(s) });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      const id = randomBytes(16).toString('hex');
      const p = { id, path: canonical, root, rootIdentity: identity(before), entries, bytes, skipped,
        state: 'preview', expiresAt: now() + TTL, copied: 0 };
      touch(p);
      plans.set(id, p);
      return publicPlan(p);
    } catch (e) { await root?.close(); throw e; }
  }
  async function persist(p, output) {
    const manifest = { version: 1, id: p.id, root: p.rootIdentity, output: p.outputIdentity,
      state: p.state, copied: p.copied, bytes: p.bytes };
    // The directory is new, mode 0700. An exclusive temporary file and rename
    // provide a recoverable record even if the app stops during a copy.
    const temp = join(anchor(output), `.manifest-${randomBytes(16).toString('hex')}`);
    const file = await open(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(anchor(output), '.rdsh-organize.json'));
    await output.sync();
  }
  async function execute(id, confirmed) {
    if (confirmed !== true) throw fail('CONFIRMATION_REQUIRED');
    const p = get(id);
    if (platform !== 'linux') throw fail('PREVIEW_ONLY_PLATFORM');
    if (p.state !== 'preview' || !p.entries.length) throw fail('NOT_EXECUTABLE');
    p.busy = true;
    let output;
    const destinations = new Map();
    try {
      const base = anchor(p.root);
      if (identity(await lstat(p.path, { bigint: true })) !== p.rootIdentity) throw fail('FOLDER_CHANGED');
      // Recheck every input before creating any output. New files are not added
      // to the human-approved plan; changed inputs make that plan obsolete.
      for (const e of p.entries) if (fingerprint(await lstat(join(base, e.name), { bigint: true })) !== e.fingerprint) throw fail('FILES_CHANGED');
      p.output = `rdsh-organized-${p.id}`;
      await mkdir(join(base, p.output), { mode: 0o700 });
      output = await open(join(base, p.output), directoryFlags);
      p.outputIdentity = identity(await output.stat({ bigint: true }));
      p.state = 'copying';
      await persist(p, output);
      for (const e of p.entries) {
        if (closed) throw fail('CLOSED');
        let destination = destinations.get(e.group);
        if (!destination) {
          await mkdir(join(anchor(output), e.group), { mode: 0o700 });
          destination = await open(join(anchor(output), e.group), directoryFlags);
          destinations.set(e.group, destination);
        }
        const source = await open(join(base, e.name), readFlags);
        let target;
        try {
          const s = await source.stat({ bigint: true });
          if (!s.isFile() || s.nlink !== 1n || fingerprint(s) !== e.fingerprint) throw fail('FILES_CHANGED');
          target = await open(join(anchor(destination), e.name), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
          const buffer = Buffer.alloc(65536);
          let offset = 0;
          while (offset < e.size) {
            if (closed) throw fail('CLOSED');
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, e.size - offset), offset);
            if (!bytesRead) throw fail('FILES_CHANGED');
            let written = 0;
            while (written < bytesRead) {
              const result = await target.write(buffer, written, bytesRead - written, offset + written);
              if (!result.bytesWritten) throw fail('COPY_FAILED');
              written += result.bytesWritten;
            }
            offset += bytesRead;
          }
          if (fingerprint(await source.stat({ bigint: true })) !== e.fingerprint) throw fail('FILES_CHANGED');
          await target.sync();
        } finally { await target?.close(); await source.close(); }
        p.copied++;
        await persist(p, output);
      }
      if (identity(await lstat(p.path, { bigint: true })) !== p.rootIdentity) throw fail('FOLDER_CHANGED');
      p.state = 'completed';
      await persist(p, output);
    } catch (error) {
      if (output) { p.state = 'partial'; await persist(p, output).catch(() => {}); }
      else if (!p.outputIdentity) { p.state = 'expired'; }
      throw fail(['FILES_CHANGED', 'FOLDER_CHANGED', 'CLOSED'].includes(error.code) ? error.code : 'COPY_FAILED');
    } finally {
      await Promise.all([...destinations.values()].map(h => h.close()));
      await output?.close();
      p.busy = false;
      if (!closed) touch(p);
    }
    return publicPlan(p);
  }
  async function undo(id, confirmed) {
    if (confirmed !== true) throw fail('CONFIRMATION_REQUIRED');
    const p = get(id);
    if (platform !== 'linux') throw fail('PREVIEW_ONLY_PLATFORM');
    if (!['completed', 'partial', 'copying'].includes(p.state)) throw fail('NOT_UNDOABLE');
    p.busy = true;
    try {
      const base = anchor(p.root);
      if (identity(await lstat(p.path, { bigint: true })) !== p.rootIdentity) throw fail('FOLDER_CHANGED');
      const source = join(base, p.output);
      const s = await lstat(source, { bigint: true });
      if (!s.isDirectory() || identity(s) !== p.outputIdentity) throw fail('OUTPUT_CHANGED');
      const archive = `.rdsh-organize-undone-${randomBytes(16).toString('hex')}`;
      // A directory rename keeps all copies, including later user edits. No
      // recursive delete or unlink of user file names is performed on undo.
      await rename(source, join(base, archive));
      await p.root.sync();
      p.state = 'undone'; p.output = archive;
      return publicPlan(p);
    } finally { p.busy = false; }
  }
  async function recover(id) {
    const p = get(id);
    if (platform !== 'linux') return [];
    const records = [];
    let scanned = 0;
    for await (const entry of await opendir(anchor(p.root))) {
      if (++scanned > 1000) break;
      const match = folderPattern.exec(entry.name);
      if (!entry.isDirectory() || !match || plans.has(match[1])) continue;
      if (plans.size >= MAX_PLANS) break;
      let folder, file;
      try {
        folder = await open(join(anchor(p.root), entry.name), directoryFlags);
        file = await open(join(anchor(folder), '.rdsh-organize.json'), readFlags);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 65536) continue;
        const buffer = Buffer.alloc(65537);
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (count > 65536) continue;
        const value = JSON.parse(buffer.subarray(0, count).toString('utf8'));
        const outputIdentity = identity(await folder.stat({ bigint: true }));
        if (value.version !== 1 || value.id !== match[1] || value.root !== p.rootIdentity || value.output !== outputIdentity) continue;
        const root = await open(anchor(p.root), C.O_RDONLY | C.O_DIRECTORY);
        const restored = { ...p, id: value.id, root, output: entry.name, outputIdentity, state: 'partial',
          entries: [], bytes: 0, skipped: 0, copied: Number.isSafeInteger(value.copied) && value.copied >= 0 && value.copied <= MAX_FILES ? value.copied : 0,
          expiresAt: now() + TTL, busy: false };
        touch(restored); plans.set(restored.id, restored);
        records.push(publicPlan(restored));
      } catch { /* Unrelated or unreadable folders are never acted on. */ }
      finally { await file?.close(); await folder?.close(); }
    }
    return records;
  }
  return { preview: path => serial(() => preview(path)), execute: (id, confirmed) => serial(() => execute(id, confirmed)),
    undo: (id, confirmed) => serial(() => undo(id, confirmed)), recover: id => serial(() => recover(id)),
    status: id => serial(() => publicPlan(get(id))),
    release: id => serial(async () => { const p = plans.get(id); if (p) await discard(p); return { released: true }; }),
    async close() { closed = true; await pending; for (const p of [...plans.values()]) await discard(p); },
  };
}
