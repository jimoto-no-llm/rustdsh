import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink, link, rename, truncate } from 'node:fs/promises';
import { watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrganizer } from '../organizer.js';

const linux = { skip: process.platform !== 'linux' };
const code = expected => error => error.code === expected;
async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'rdsh-easy-'));
  const folder = join(directory, 'downloads'); await mkdir(folder);
  const organizer = createOrganizer(options);
  t.after(async () => { await organizer.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, folder, organizer };
}
test('preview reads metadata and copy/undo preserve originals and later edits to copies', linux, async t => {
  const f = await fixture(t);
  await writeFile(join(f.folder, '写真.png'), 'synthetic picture');
  await writeFile(join(f.folder, 'data.csv'), 'value\n1');
  await mkdir(join(f.folder, 'nested')); await writeFile(join(f.folder, '.private'), 'private');
  const plan = await f.organizer.preview(f.folder);
  assert.deepEqual(plan.entries.map(e => e.group), ['表', '写真']);
  assert.equal(plan.skipped, 2); assert.equal(plan.output, null);
  assert.equal((await readdir(f.folder)).length, 4);
  await assert.rejects(f.organizer.execute(plan.id, false), code('CONFIRMATION_REQUIRED'));
  const done = await f.organizer.execute(plan.id, true);
  assert.equal(done.copied, 2); assert.equal(done.state, 'completed');
  assert.equal(await readFile(join(done.output, '写真', '写真.png'), 'utf8'), 'synthetic picture');
  await writeFile(join(done.output, '写真', '写真.png'), 'later edit');
  const undo = await f.organizer.undo(plan.id, true);
  assert.equal(undo.state, 'undone');
  assert.equal(await readFile(join(undo.output, '写真', '写真.png'), 'utf8'), 'later edit');
  assert.equal(await readFile(join(f.folder, '写真.png'), 'utf8'), 'synthetic picture');
  await assert.rejects(f.organizer.undo(plan.id, true), code('NOT_UNDOABLE'));
});
test('changed inputs invalidate the approved plan before any destination is created', linux, async t => {
  const f = await fixture(t); const source = join(f.folder, 'report.pdf');
  await writeFile(source, 'before'); const plan = await f.organizer.preview(f.folder);
  await writeFile(source, 'after');
  await assert.rejects(f.organizer.execute(plan.id, true), code('FILES_CHANGED'));
  assert.deepEqual(await readdir(f.folder), ['report.pdf']);
});
test('symlinks, hard links and new unapproved files are never copied', linux, async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'outside.txt'), 'outside');
  await symlink(join(f.directory, 'outside.txt'), join(f.folder, 'pointer.txt'));
  await link(join(f.directory, 'outside.txt'), join(f.folder, 'hard.txt'));
  await writeFile(join(f.folder, 'approved.txt'), 'approved');
  const plan = await f.organizer.preview(f.folder);
  assert.equal(plan.entries.length, 1); assert.equal(plan.skipped, 2);
  await writeFile(join(f.folder, 'late.txt'), 'late');
  const done = await f.organizer.execute(plan.id, true);
  assert.deepEqual(await readdir(join(done.output, '資料')), ['approved.txt']);
  assert.equal(await readFile(join(f.directory, 'outside.txt'), 'utf8'), 'outside');
});
test('replacement of an approved source with a symlink fails closed', linux, async t => {
  const f = await fixture(t); const source = join(f.folder, 'selected.txt');
  await writeFile(source, 'selected'); const plan = await f.organizer.preview(f.folder);
  await rm(source); await symlink(f.directory, source);
  await assert.rejects(f.organizer.execute(plan.id, true), code('FILES_CHANGED'));
  assert.equal((await readdir(f.folder)).length, 1);
});
test('existing outputs and a moved folder cannot be overwritten', linux, async t => {
  const f = await fixture(t); await writeFile(join(f.folder, 'a.txt'), 'a');
  const plan = await f.organizer.preview(f.folder);
  const output = join(f.folder, `rdsh-organized-${plan.id}`);
  await mkdir(output); await writeFile(join(output, 'existing'), 'keep');
  await assert.rejects(f.organizer.execute(plan.id, true), code('COPY_FAILED'));
  assert.equal(await readFile(join(output, 'existing'), 'utf8'), 'keep');
  const fresh = await f.organizer.preview(f.folder);
  await rename(f.folder, join(f.directory, 'moved')); await mkdir(f.folder);
  await assert.rejects(f.organizer.execute(fresh.id, true), code('FOLDER_CHANGED'));
  assert.deepEqual(await readdir(f.folder), []);
});
test('restart recovery permits archival of owned completed or interrupted outputs', linux, async t => {
  const f = await fixture(t); await writeFile(join(f.folder, 'a.pdf'), 'fixture');
  const plan = await f.organizer.preview(f.folder);
  const done = await f.organizer.execute(plan.id, true); await f.organizer.close();
  const next = createOrganizer(); t.after(() => next.close());
  const current = await next.preview(f.folder);
  const recovered = await next.recover(current.id);
  assert.equal(recovered.length, 1); assert.equal(recovered[0].id, plan.id);
  const undone = await next.undo(recovered[0].id, true);
  assert.equal(await readFile(join(undone.output, '資料', 'a.pdf'), 'utf8'), 'fixture');
  await assert.rejects(readFile(join(done.output, '.rdsh-organize.json')));
});
test('execution requires a live server-held plan; unsupported hosts retain preview only', async t => {
  const f = await fixture(t, { platform: 'darwin' }); await writeFile(join(f.folder, 'a.txt'), 'fixture');
  const plan = await f.organizer.preview(f.folder); assert.equal(plan.executable, false);
  await assert.rejects(f.organizer.execute(plan.id, true), code('PREVIEW_ONLY_PLATFORM'));
  await assert.rejects(f.organizer.execute('client-invented-id', true), code('PLAN_EXPIRED'));
  assert.deepEqual(await readdir(f.folder), ['a.txt']);
});
test('expired and concurrent previews have bounded admission', async t => {
  let now = 0;
  const f = await fixture(t, { now: () => now, platform: 'darwin' });
  const first = await f.organizer.preview(f.folder); now = 600001;
  await assert.rejects(f.organizer.execute(first.id, true), code('PLAN_EXPIRED'));
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.organizer.preview(f.folder)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal(results.at(-1).reason.code, 'TOO_MANY_PLANS');
  await f.organizer.release(results[0].value.id);
  assert.equal((await f.organizer.preview(f.folder)).state, 'preview');
});

test('a real mid-copy input change persists a partial output that can be recovered and archived', linux, async t => {
  const f = await fixture(t), first = Buffer.alloc(1024 * 1024, 7);
  await writeFile(join(f.folder, 'a.pdf'), first); await writeFile(join(f.folder, 'b.pdf'), 'approved');
  const plan = await f.organizer.preview(f.folder);
  // Output creation follows the full preflight. Mutate only this fixture's
  // second input at that filesystem event, before the later file is opened.
  let changed = false;
  const watcher = watch(f.folder, (_event, filename) => {
    if (!changed && String(filename) === `rdsh-organized-${plan.id}`) {
      changed = true; writeFileSync(join(f.folder, 'b.pdf'), 'later user edit');
    }
  });
  try { await assert.rejects(f.organizer.execute(plan.id, true), code('FILES_CHANGED')); }
  finally { watcher.close(); }
  assert.equal(changed, true);
  const partial = await f.organizer.status(plan.id);
  assert.equal(partial.state, 'partial'); assert.equal(partial.copied, 1);
  assert.equal(JSON.parse(await readFile(join(partial.output, '.rdsh-organize.json'))).state, 'partial');
  await f.organizer.close();
  const next = createOrganizer(); t.after(() => next.close());
  const preview = await next.preview(f.folder), recovered = await next.recover(preview.id);
  assert.equal(recovered.length, 1); assert.equal(recovered[0].copied, 1);
  const archived = await next.undo(plan.id, true);
  assert.deepEqual(await readFile(join(archived.output, '資料', 'a.pdf')), first);
  assert.deepEqual(await readFile(join(f.folder, 'a.pdf')), first);
  assert.equal(await readFile(join(f.folder, 'b.pdf'), 'utf8'), 'later user edit');
});

test('undo refuses a replaced output directory and preserves both the owned copies and replacement', linux, async t => {
  const f = await fixture(t); await writeFile(join(f.folder, 'a.txt'), 'source');
  const preview = await f.organizer.preview(f.folder), done = await f.organizer.execute(preview.id, true);
  const moved = join(f.directory, 'owned-copy'); await rename(done.output, moved);
  await mkdir(done.output); await writeFile(join(done.output, 'unrelated.txt'), 'keep');
  await assert.rejects(f.organizer.undo(preview.id, true), code('OUTPUT_CHANGED'));
  assert.equal(await readFile(join(done.output, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(moved, '資料', 'a.txt'), 'utf8'), 'source');
  assert.equal(await readFile(join(f.folder, 'a.txt'), 'utf8'), 'source');
});

test('recovery ignores forged, oversized and symlinked manifests without admitting them', linux, async t => {
  const f = await fixture(t); await writeFile(join(f.folder, 'a.txt'), 'source');
  const preview = await f.organizer.preview(f.folder), done = await f.organizer.execute(preview.id, true);
  const path = join(done.output, '.rdsh-organize.json'), record = await readFile(path, 'utf8');
  await f.organizer.close();
  const next = createOrganizer(); t.after(() => next.close()); const current = await next.preview(f.folder);
  await writeFile(path, JSON.stringify({ ...JSON.parse(record), output: 'wrong:inode' }));
  assert.deepEqual(await next.recover(current.id), []);
  await writeFile(path, 'x'.repeat(65537)); assert.deepEqual(await next.recover(current.id), []);
  await rm(path); const outside = join(f.directory, 'outside.json'); await writeFile(outside, record);
  await symlink(outside, path); assert.deepEqual(await next.recover(current.id), []);
  assert.equal(await readFile(outside, 'utf8'), record);
  await rm(path); await writeFile(path, record);
  assert.equal((await next.recover(current.id)).length, 1);
});

test('oversized byte totals, file counts and hidden directory scans fail without exhausting plan capacity', async t => {
  for (const kind of ['bytes', 'files', 'scan']) {
    const f = await fixture(t);
    if (kind === 'bytes') { await writeFile(join(f.folder, 'large.pdf'), ''); await truncate(join(f.folder, 'large.pdf'), 256 * 1024 * 1024 + 1); }
    else for (let i = 0; i < (kind === 'files' ? 201 : 1001); i++) await writeFile(join(f.folder, (kind === 'scan' ? '.' : '') + `${i}.txt`), '');
    await assert.rejects(f.organizer.preview(f.folder), code('FOLDER_TOO_LARGE'));
    await rm(f.folder, { recursive: true }); await mkdir(f.folder);
    for (let i = 0; i < 4; i++) assert.equal((await f.organizer.preview(f.folder)).state, 'preview');
  }
});

test('close rejects queued operations and future requests before creating output', async t => {
  const f = await fixture(t); await writeFile(join(f.folder, 'a.txt'), 'fixture');
  const pending = Promise.allSettled(Array.from({ length: 3 }, () => f.organizer.preview(f.folder)));
  await f.organizer.close();
  assert.deepEqual((await pending).map(result => result.reason.code), ['CLOSED', 'CLOSED', 'CLOSED']);
  await assert.rejects(f.organizer.preview(f.folder), code('CLOSED'));
  assert.deepEqual(await readdir(f.folder), ['a.txt']);
});
