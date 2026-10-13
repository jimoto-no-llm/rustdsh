import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink, link, rename } from 'node:fs/promises';
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
