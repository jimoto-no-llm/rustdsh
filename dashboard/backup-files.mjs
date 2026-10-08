import fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  backupMaximum,
  validateHistoryBackup,
  backupHash,
} from "./history-backup.mjs";

export async function readBackupJson(file) {
  let handle;
  try {
    // Do not follow a final symlink or read a device/FIFO. No archive extraction.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > backupMaximum) throw new Error();
    handle = await fs.open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > backupMaximum ||
      stat.dev !== opened.dev ||
      stat.ino !== opened.ino
    )
      throw new Error();
    const bytes = await handle.readFile();
    if (bytes.length > backupMaximum) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(
      "Invalid backup JSON: require a regular UTF-8 file of at most 2 MiB",
    );
  } finally {
    await handle?.close();
  }
}
export async function writeHistoryBackup(file, archive) {
  validateHistoryBackup(archive);
  const body = JSON.stringify(archive, null, 2) + "\n";
  if (Buffer.byteLength(body) > backupMaximum)
    throw new Error("backup_too_large");
  // Exclusive destination creation never replaces an existing file. A partial
  // file fails its checksum and cannot be restored after an interrupted write.
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return backupInspection(archive);
}
export function backupInspection(archive) {
  validateHistoryBackup(archive);
  return {
    archive_id: archive.archive_id,
    integrity: archive.integrity,
    source: archive.source,
    created_at: archive.created_at,
    selection: archive.selection,
    selection_digest: backupHash(archive.selection),
    counts: Object.fromEntries(
      Object.entries(archive.records).map(([k, v]) => [k, v.length]),
    ),
    reviewed_fields: archive.reviewed_fields,
    withheld_fields: archive.withheld_fields,
    policy: archive.policy,
    records: archive.records,
  };
}
