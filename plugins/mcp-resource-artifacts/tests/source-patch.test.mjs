import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { prepare } from '../source-patch.mjs'

const bundle = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = input => createHash('sha256').update(input).digest('hex')
function removeFixture(source) {
  const root = realpathSync(tmpdir())
  const target = realpathSync(source)
  assert.ok(target.startsWith(root + sep), 'fixture deletion must stay inside the temporary directory')
  rmSync(target, { recursive: true, force: true })
}
function fixture(t, { before = 'started\n', after = 'started\ncompleted\n', newFiles = {} } = {}) {
  const source = mkdtempSync(join(tmpdir(), 'rdsh resource fixture '))
  t.after(() => removeFixture(source))
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  const commit = message => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message)
  git('init', '-q')
  writeFileSync(join(source, '.gitattributes'), '* text=auto eol=lf\n')
  writeFileSync(join(source, 'card.txt'), before)
  writeFileSync(join(source, 'outside.txt'), 'preserve\n')
  git('add', '.gitattributes', 'card.txt', 'outside.txt')
  commit('fixture base')
  const base_commit = git('rev-parse', 'HEAD')
  writeFileSync(join(source, 'card.txt'), after)
  for (const [path, contents] of Object.entries(newFiles)) {
    mkdirSync(dirname(join(source, path)), { recursive: true })
    writeFileSync(join(source, path), contents)
  }
  const files = ['card.txt', ...Object.keys(newFiles)]
  git('add', ...files)
  commit('fixture resource patch')
  const patch_commit = git('rev-parse', 'HEAD')
  const patch = Buffer.from(git('format-patch', '--stdout', '--binary', '-1', patch_commit) + '\n')
  const file_blobs = Object.fromEntries(files.map(path => [path, git('rev-parse', `${patch_commit}:${path}`)]))
  // Only this test-owned temporary repository is reset to its fixture base.
  git('reset', '--hard', base_commit)
  const manifest = { base_commit, patch_commit, patch_sha256: hash(patch), files, file_blobs }
  return { source, patch, manifest, git }
}

const forwardGit = (source, args, input) => spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', source, ...args], { input, encoding: 'utf8', windowsHide: true })
const writesPatch = args => args[0] === 'apply' && !args.some(arg => ['--check', '--numstat', '--reverse'].includes(arg))

test('checks without writing; applies to a checkout with spaces; repeats with nested new files', t => {
  const f = fixture(t, { newFiles: { 'nested/fixture.yml': 'name: resource\n' } })
  assert.equal(prepare(f.source, f).state, 'ready')
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), 'started\n')
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(prepare(f.source, { ...f, apply: true }).state, 'applied')
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), 'started\ncompleted\n')
  assert.equal(prepare(f.source, { ...f, apply: true }).state, 'already-applied')
  f.git('add', ...f.manifest.files)
  assert.equal(prepare(f.source, f).state, 'already-applied')
})

test('Windows drive-letter casing still identifies the same source root', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const alternate = f.source.replace(/^[A-Z]:/, drive => drive.toLowerCase())
  assert.equal(prepare(alternate, f).state, 'ready')
  assert.equal(f.git('status', '--porcelain'), '')
})

test('rejects modified source, untracked files, wrong roots and unsupported revisions', t => {
  const f = fixture(t)
  writeFileSync(join(f.source, 'card.txt'), 'user edit\n')
  assert.throws(() => prepare(f.source, { ...f, apply: true }), { code: 'SOURCE_DIRTY' })
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), 'user edit\n')
  f.git('restore', 'card.txt')
  writeFileSync(join(f.source, 'untracked.txt'), 'keep\n')
  assert.throws(() => prepare(f.source, f), { code: 'SOURCE_DIRTY' })
  rmSync(join(f.source, 'untracked.txt'))
  mkdirSync(join(f.source, 'subdir'))
  assert.throws(() => prepare(join(f.source, 'subdir'), f), { code: 'SOURCE_NOT_ROOT' })
  assert.throws(() => prepare(f.source, { ...f, manifest: { ...f.manifest, base_commit: '1'.repeat(40) } }), { code: 'UNSUPPORTED_BASE' })
})

test('rejects changed patch bytes, header and unexpected paths before writing', t => {
  const f = fixture(t)
  assert.throws(() => prepare(f.source, { ...f, patch: Buffer.from('tampered') }), { code: 'PATCH_INTEGRITY' })
  const otherPath = { ...f.manifest, files: ['another.txt'], file_blobs: { 'another.txt': f.manifest.file_blobs['card.txt'] } }
  assert.throws(() => prepare(f.source, { ...f, manifest: otherPath }), { code: 'PATCH_SCOPE' })
  const patch = Buffer.from(f.patch.toString().replace(f.manifest.patch_commit, '2'.repeat(40)))
  assert.throws(() => prepare(f.source, { ...f, patch, manifest: { ...f.manifest, patch_sha256: hash(patch) } }), { code: 'PATCH_COMMIT' })
  assert.equal(f.git('status', '--porcelain'), '')
})

test('rejects unsafe or unpinned manifest paths', t => {
  const f = fixture(t)
  for (const path of ['../outside.txt', '/absolute.txt', '.git/config', 'a\\b.txt', 'C:/x.txt']) {
    const manifest = { ...f.manifest, files: [path], file_blobs: { [path]: '3'.repeat(40) } }
    assert.throws(() => prepare(f.source, { ...f, manifest }), { code: 'MANIFEST_INVALID' })
  }
  assert.throws(() => prepare(f.source, { ...f, manifest: { ...f.manifest, file_blobs: {} } }), { code: 'MANIFEST_INVALID' })
  assert.equal(f.git('status', '--porcelain'), '')
})

test('a conflicting multi-file patch applies no partial changes', t => {
  const f = fixture(t)
  const patch = Buffer.from(f.patch.toString() + 'diff --git a/missing.txt b/missing.txt\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-old\n+new\n')
  const manifest = { ...f.manifest, patch_sha256: hash(patch), files: ['card.txt', 'missing.txt'], file_blobs: { ...f.manifest.file_blobs, 'missing.txt': '4'.repeat(40) } }
  assert.throws(() => prepare(f.source, { patch, manifest, apply: true }), { code: 'PATCH_CONFLICT' })
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), 'started\n')
  assert.equal(f.git('status', '--porcelain'), '')
})

test('user whitespace preferences cannot reject the pinned patch', t => {
  const f = fixture(t, { after: 'started\n        deeply indented yaml\n' })
  f.git('config', 'core.whitespace', 'indent-with-non-tab')
  assert.equal(prepare(f.source, { ...f, apply: true }).state, 'applied')
  assert.equal(prepare(f.source, f).state, 'already-applied')
})

test('already-applied refuses unrelated tracked or untracked changes', t => {
  const f = fixture(t)
  prepare(f.source, { ...f, apply: true })
  for (const path of ['outside.txt', 'untracked.txt']) {
    writeFileSync(join(f.source, path), 'keep user edit\n')
    assert.throws(() => prepare(f.source, { ...f, apply: true }), { code: 'SOURCE_DIRTY' })
    assert.equal(readFileSync(join(f.source, path), 'utf8'), 'keep user edit\n')
    if (path === 'outside.txt') f.git('restore', path)
    else rmSync(join(f.source, path))
  }
  assert.equal(prepare(f.source, f).state, 'already-applied')
})

test('reverse-applicable target edits still fail exact blob verification', t => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('')
  const f = fixture(t, { before: lines + 'started\n', after: lines + 'started\ncompleted\n' })
  prepare(f.source, { ...f, apply: true })
  const edited = (lines + 'started\ncompleted\n').replace('line 0\n', 'user edit outside hunk\n')
  writeFileSync(join(f.source, 'card.txt'), edited)
  assert.equal(forwardGit(f.source, ['apply', '--reverse', '--check', '-'], f.patch).status, 0)
  assert.throws(() => prepare(f.source, { ...f, apply: true }), { code: 'SOURCE_DIRTY' })
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), edited)
})

test('a different staged target cannot hide behind matching working files', t => {
  const f = fixture(t)
  prepare(f.source, { ...f, apply: true })
  writeFileSync(join(f.source, 'card.txt'), 'staged user edit\n')
  f.git('add', 'card.txt')
  writeFileSync(join(f.source, 'card.txt'), 'started\ncompleted\n')
  assert.throws(() => prepare(f.source, { ...f, apply: true }), { code: 'SOURCE_DIRTY' })
  assert.match(f.git('show', ':card.txt'), /staged user edit/)
})

test('CRLF text checkout bytes match the pinned Git text blobs', t => {
  const f = fixture(t)
  prepare(f.source, { ...f, apply: true })
  writeFileSync(join(f.source, 'card.txt'), 'started\r\ncompleted\r\n')
  assert.equal(prepare(f.source, f).state, 'already-applied')
})

test('APPLY_FAILED is reported without claiming success or reverting user files', t => {
  const f = fixture(t)
  const runGit = (source, args, input) => writesPatch(args) ? { status: 1, stdout: '', stderr: 'fixture write failure' } : forwardGit(source, args, input)
  assert.throws(() => prepare(f.source, { ...f, apply: true, runGit }), { code: 'APPLY_FAILED' })
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), 'started\n')
  assert.equal(f.git('status', '--porcelain'), '')
})

test('VERIFY_FAILED catches post-write edits outside patch context and retains the evidence', t => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('')
  const f = fixture(t, { before: lines + 'started\n', after: lines + 'started\ncompleted\n' })
  const edited = (lines + 'started\ncompleted\n').replace('line 0\n', 'concurrent edit\n')
  const runGit = (source, args, input) => {
    const result = forwardGit(source, args, input)
    if (writesPatch(args) && result.status === 0) writeFileSync(join(source, 'card.txt'), edited)
    return result
  }
  assert.throws(() => prepare(f.source, { ...f, apply: true, runGit }), { code: 'VERIFY_FAILED' })
  assert.equal(readFileSync(join(f.source, 'card.txt'), 'utf8'), edited)
})

test('Git ownership protection is retained', t => {
  const f = fixture(t)
  const keys = ['GIT_TEST_ASSUME_DIFFERENT_OWNER', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  const config = join(f.source, '.git', 'ownership-test.gitconfig')
  writeFileSync(config, '')
  // CI may intentionally trust every checkout via safe.directory. Isolate that
  // policy for this test without modifying any real user or runner configuration.
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_COUNT = '0'
  delete process.env.GIT_CONFIG_PARAMETERS
  try {
    assert.throws(() => prepare(f.source, { ...f, apply: true }), { code: 'SOURCE_UNSAFE' })
  } finally {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key]
      else process.env[key] = previous.get(key)
    }
  }
  assert.equal(f.git('status', '--porcelain'), '')
})

test('preparation never invokes repository fsmonitor commands', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const script = join(f.source, '.git', 'monitor.sh')
  const marker = join(f.source, '.git', 'monitor-ran')
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  f.git('config', 'core.fsmonitor', script)
  assert.equal(prepare(f.source, f).state, 'ready')
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' })
})

test('bundled checksum, patch header, numstat and blob coverage agree', t => {
  const f = fixture(t)
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
  const patch = readFileSync(join(bundle, 'mcp-resource-artifacts.patch'))
  assert.equal(hash(patch), manifest.patch_sha256)
  assert.equal(manifest.base_commit, 'f97c0438fb1608bbc4c08c88a27344249795ea22')
  assert.equal(manifest.patch_commit, '3b7c71fc79c4fe438e1c08f6d0e98680c83d17b2')
  assert.ok(patch.toString().startsWith(`From ${manifest.patch_commit} `))
  // Git filters patch paths below its current directory. Parse from the
  // fixture repository root so npm test also works from the plugin directory.
  const stats = execFileSync('git', ['-c', 'core.fsmonitor=false', 'apply', '--numstat', '-z', '-'], { cwd: f.source, input: patch, encoding: 'utf8', windowsHide: true })
  const paths = stats.split('\0').filter(Boolean).map(entry => entry.split('\t').slice(2).join('\t')).sort()
  assert.deepEqual(paths, [...manifest.files].sort())
  assert.deepEqual(Object.keys(manifest.file_blobs).sort(), paths)
  assert.ok(Object.values(manifest.file_blobs).every(oid => /^[0-9a-f]{40}$/.test(oid)))
  assert.equal(paths.length, 10)
  assert.equal(new Set(paths).size, 10)
  assert.ok(paths.every(path => path === 'docs/tool-catalog.md' || path === 'pnpm-lock.yaml'
    || path.startsWith('packages/mcp/mcp-client/') || path.startsWith('packages/mcp/mcp-resources/')))
  assert.ok(readFileSync(join(bundle, 'DSH-LICENSE'), 'utf8').includes('MIT License'))
})

test('CLI executes through a linked bundle and diagnoses non-Git package directories', t => {
  const f = fixture(t)
  const link = join(f.source, 'linked bundle')
  symlinkSync(bundle, link, process.platform === 'win32' ? 'junction' : 'dir')
  const invoke = args => spawnSync(process.execPath, [join(link, 'source-patch.mjs'), ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
  })
  const help = invoke(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--source.*--check/)
  const absent = invoke([])
  assert.equal(absent.status, 1)
  assert.equal(JSON.parse(absent.stderr).error, 'USAGE')
  const installed = mkdtempSync(join(tmpdir(), 'rdsh installed fixture '))
  t.after(() => removeFixture(installed))
  writeFileSync(join(installed, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2"}')
  const result = invoke(['--source', installed, '--check'])
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stderr).error, 'SOURCE_NOT_GIT')
  assert.equal(readFileSync(join(installed, 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2"}')
})
