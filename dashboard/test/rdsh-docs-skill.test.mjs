import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const skillRoot = join(repoRoot, 'plugins', 'skills', 'rdsh-docs');
const installer = join(repoRoot, 'plugins', 'install-skills.sh');
const shellSkip = process.platform === 'win32' ? 'the source skill installer is POSIX shell' : false;

test('rdsh-docs declares a DSH directory skill with focused references', async () => {
  const body = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, 'SKILL.md starts with YAML frontmatter');
  assert.match(frontmatter[1], /^name:\s*rdsh-docs\s*$/m);
  assert.match(frontmatter[1], /^description:\s*.+$/m);
  assert.match(body, /0\.2\.0-rc\.2/);
  assert.match(body, /cordis_inspect_list/);
  assert.match(body, /documented capability, current configuration|Documented:/i);
  for (const file of ['source-index.md', 'acceptance.md']) {
    assert.ok((await readFile(join(skillRoot, 'references', file), 'utf8')).length > 100);
  }
});

test('installer dry run previews rdsh-docs without creating a DSH home', { skip: shellSkip }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'rdsh-docs-dry-run-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'dsh-home');
  const result = spawnSync('sh', [installer], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: home, DRY_RUN: '1' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /install: rdsh-docs/);
  assert.doesNotMatch(result.stdout, /backup:|installed:/);
  await assert.rejects(readFile(join(home, 'skills', 'rdsh-docs', 'SKILL.md')));
});

test('installer copies rdsh-docs and keeps forced-refresh backups outside skill discovery', { skip: shellSkip }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'rdsh-docs-install-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'dsh-home');
  const tmp = join(work, 'tmp');
  const ponytailRepo = join(work, 'ponytail-repo');
  const ponytailSkill = join(ponytailRepo, '.openclaw', 'skills', 'ponytail');
  await mkdir(ponytailSkill, { recursive: true });
  await mkdir(tmp, { recursive: true });
  await writeFile(join(ponytailSkill, 'SKILL.md'), '---\nname: ponytail\ndescription: Fixture skill\n---\nFixture.\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: ponytailRepo });
  execFileSync('git', ['-c', 'user.name=rdsh test', '-c', 'user.email=rdsh-test@example.invalid', 'add', '--all'], { cwd: ponytailRepo });
  execFileSync('git', ['-c', 'user.name=rdsh test', '-c', 'user.email=rdsh-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: ponytailRepo });

  function run(force) {
    return spawnSync('sh', [installer], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DSH_HOME: home,
        DRY_RUN: '0',
        FORCE: force,
        REF: 'main',
        PONYTAIL_REPO: ponytailRepo,
        TMPDIR: tmp,
      },
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  const first = run('0');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await readFile(join(home, 'skills', 'rdsh-docs', 'SKILL.md'), 'utf8'), await readFile(join(skillRoot, 'SKILL.md'), 'utf8'));
  assert.equal(await readFile(join(home, 'skills', 'ponytail', 'SKILL.md'), 'utf8'), '---\nname: ponytail\ndescription: Fixture skill\n---\nFixture.\n');

  const localNote = join(home, 'skills', 'rdsh-docs', 'local-note.md');
  await writeFile(localNote, 'preserve this local copy');
  const kept = run('0');
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(await readFile(localNote, 'utf8'), 'preserve this local copy');

  const refreshed = run('1');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const backups = await readdir(join(home, 'skill-backups', 'rdsh-docs'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, 'skill-backups', 'rdsh-docs', backups[0], 'local-note.md'), 'utf8'), 'preserve this local copy');
  assert.deepEqual((await readdir(join(home, 'skills'))).sort(), ['ponytail', 'rdsh-docs']);
  await assert.rejects(readFile(join(home, 'skills', 'rdsh-docs.bak-1', 'SKILL.md')));
});
