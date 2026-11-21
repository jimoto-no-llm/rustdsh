import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostModule } from './host-runtime.js';

export const MAX_DOCUMENT_BYTES = 512 * 1024;
const hash = content => createHash('sha256').update(content).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Filesystem adapter for one provider-owned document, never an arbitrary path. */
export function createSettingsDocuments(ctx, RemoteError, load = hostModule) {
  const fail = (code, message) => new RemoteError(`settings/document-${code}`, message, {});
  const io = () => fail('io', '設定文書の読取りまたは保存に失敗しました。');
  async function target() {
    const settings = ctx.get('settings'), editor = ctx.get('configEditor'), profile = ctx.get('profileContext');
    if (!settings || typeof settings.prepareDocument !== 'function' || !editor || !profile)
      throw fail('unavailable', '設定文書を提供するDSHサービスがありません。');
    const path = await settings.prepareDocument();
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== resolve(editor.documentPath)
      || resolve(path) !== resolve(profile.patchPath) || dirname(resolve(path)) !== resolve(profile.dir)
      || basename(path) !== 'cordis.patch.yml') throw fail('unavailable', '設定文書の提供先が一致しません。');
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw fail('unsafe', '設定文書の場所を安全に開けません。');
    return { path, profile, writable: settings.writable === true };
  }
  async function snapshot(path) {
    let handle;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('unsafe', '設定文書は通常ファイルである必要があります。');
      if (stat.size > MAX_DOCUMENT_BYTES) throw fail('too-large', '設定文書はUTF-8で512 KiB以下にしてください。');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino) throw fail('unsafe', '設定文書が読取り中に変更されました。');
      const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_DOCUMENT_BYTES) throw fail('too-large', '設定文書はUTF-8で512 KiB以下にしてください。');
      let content;
      try { content = utf8.decode(buffer.subarray(0, length)); }
      catch { throw fail('invalid', '設定文書は有効なUTF-8である必要があります。'); }
      return { content, revision: hash(buffer.subarray(0, length)), exists: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { content: '[]\n', revision: hash('missing\0'), exists: false };
      throw error;
    } finally { await handle?.close(); }
  }
  async function safely(operation) {
    try { return await operation(); }
    catch (error) { if (error instanceof RemoteError) throw error; throw io(); }
  }
  return {
    async read() {
      return safely(async () => {
        const { path, writable } = await target();
        const { content, revision } = await snapshot(path);
        return { path, content, revision, writable };
      });
    },
    async save(content, expectedRevision) {
      return safely(async () => {
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES
          || utf8.decode(Buffer.from(content, 'utf8')) !== content)
          throw fail('invalid', '保存内容は512 KiB以下の有効なUTF-8にしてください。');
        if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw fail('invalid', '保存前のリビジョンが必要です。');
        const targetBefore = await target();
        if (!targetBefore.writable) throw fail('readonly', 'この設定文書は読取り専用です。');
        const [atomic, boot, yaml, include] = await Promise.all([
          load(ctx, '@deepseek-ai/dsh-atomic-write'), load(ctx, '@deepseek-ai/dsh-app-boot'),
          load(ctx, 'js-yaml'), load(ctx, '@deepseek-ai/cordis-plugin-include'),
        ]);
        let parsed;
        try {
          parsed = yaml.default.load(content, { schema: include.entryListSchema });
          if (!Array.isArray(parsed) || parsed.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error();
        } catch { throw fail('invalid', '設定文書のYAMLまたはパッチ形式が不正です。'); }
        const run = () => atomic.withFileLock(join(targetBefore.profile.dir, 'package.json'), async () => {
          const { path, profile, writable } = await target();
          if (!writable || path !== targetBefore.path) throw fail('readonly', '設定文書の提供状態が変更されました。');
          const before = await snapshot(path);
          if (before.revision !== expectedRevision) throw fail('conflict', '設定文書が変更されています。再読込みして編集をやり直してください。');
          let beforePatches, patches;
          try {
            const loaded = boot.loadProfileDirectory('dsh', profile.dir, profile.installAnchor);
            beforePatches = boot.readProfilePatches('dsh', profile);
            // Resolve inserted relative module paths beside the document, as
            // loadOptionalPatches does, before the public composition checks.
            const anchor = entry => {
              if (typeof entry.name === 'string' && (isAbsolute(entry.name) || /^\.\.?\//.test(entry.name)))
                entry.name = pathToFileURL(resolve(dirname(path), entry.name)).href;
              if (entry.group && Array.isArray(entry.config)) entry.config.forEach(anchor);
            };
            for (const patch of parsed) patch.insert?.forEach(anchor);
            patches = boot.readProfilePatches('dsh', profile, { ...loaded, patches: parsed });
            boot.composeEntries([patches]);
          } catch { throw fail('invalid', '設定文書をDSHのパッチとして適用できません。'); }
          const backupPath = `${path}.rdsh-backup-${randomUUID()}`;
          await atomic.writeFileAtomic(backupPath, before.content, { mode: 0o600 });
          // An external editor may not honor the Host lock. Recheck immediately
          // before committing, and never replace a newly planted symlink.
          if ((await snapshot(path)).revision !== before.revision) throw fail('conflict', '設定文書が保存前に変更されました。再読込みしてください。');
          await atomic.writeFileAtomic(path, content, { mode: 0o600 });
          try { await boot.reconcileProfilePatches(ctx.root, patches, 'dsh'); }
          catch {
            try {
              // Do not overwrite a third-party edit during failed activation.
              if ((await snapshot(path)).revision !== hash(content)) throw new Error();
              if (before.exists) await atomic.writeFileAtomic(path, before.content, { mode: 0o600 });
              else await rm(path);
              await boot.reconcileProfilePatches(ctx.root, beforePatches, 'dsh');
            } catch { throw fail('rollback-failed', '設定の適用と復元を完了できませんでした。文書と同じ場所のrdsh-backupを確認してください。'); }
            throw fail('apply-failed', '設定を適用できなかったため、元の文書と設定に戻しました。');
          }
          return { revision: hash(content), applied: true, backupPath };
        });
        const hmr = ctx.get('hmr');
        return typeof hmr?.runExclusive === 'function' ? hmr.runExclusive(run) : run();
      });
    },
  };
}
