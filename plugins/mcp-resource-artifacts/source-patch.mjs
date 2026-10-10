#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const bundle = dirname(fileURLToPath(import.meta.url))
export class PatchError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function git(source, args, input) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', source, ...args], {
    encoding: 'utf8', input, windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.error) throw new PatchError('GIT_UNAVAILABLE', 'Git must be available on PATH.')
  if (result.status !== 0 && /detected dubious ownership|unsafe repository/.test(result.stderr)) {
    throw new PatchError('SOURCE_UNSAFE', 'Git rejected this checkout ownership. Select a trusted isolated source checkout.')
  }
  return result
}

function successful(result, code, message) {
  if (result.status !== 0) throw new PatchError(code, message)
  return result.stdout.trim()
}

function sameDirectory(left, right) {
  if (realpathSync(left) === realpathSync(right)) return true
  // Windows preserves drive-letter spelling in realpath; compare actual directory identity.
  const first = statSync(left, { bigint: true })
  const second = statSync(right, { bigint: true })
  return first.isDirectory() && second.isDirectory() && first.ino !== 0n
    && first.dev === second.dev && first.ino === second.ino
}

function validateManifest(manifest) {
  const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
  const files = manifest?.files
  if (!oid(manifest?.base_commit) || !oid(manifest?.patch_commit)
    || !Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length
    || files.some(path => typeof path !== 'string' || /[\\:\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
    || !manifest.file_blobs || JSON.stringify(Object.keys(manifest.file_blobs).sort()) !== JSON.stringify([...files].sort())
    || files.some(path => !oid(manifest.file_blobs[path]))) {
    throw new PatchError('MANIFEST_INVALID', 'The manifest must pin safe paths and their exact Git blob IDs.')
  }
}

const blobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
function matchesPatch(source, manifest) {
  return manifest.files.every(path => {
    try {
      const target = resolve(source, path)
      if (!lstatSync(target).isFile() || realpathSync(target) !== target) return false
      const bytes = readFileSync(target)
      if (blobId(bytes) === manifest.file_blobs[path]) return true
      // Git text checkouts may use CRLF. Never invoke repository clean filters to hash a file.
      return !bytes.includes(0) && blobId(Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === manifest.file_blobs[path]
    } catch { return false }
  })
}

/** Apply only the bundled MCP resource patch to an explicitly selected source checkout. */
export function prepare(sourcePath, { apply = false, patch, manifest, runGit = git } = {}) {
  patch ??= readFileSync(resolve(bundle, 'mcp-resource-artifacts.patch'))
  manifest ??= JSON.parse(readFileSync(resolve(bundle, 'manifest.json'), 'utf8'))
  validateManifest(manifest)
  if (createHash('sha256').update(patch).digest('hex') !== manifest.patch_sha256) {
    throw new PatchError('PATCH_INTEGRITY', 'The resource patch checksum does not match its manifest.')
  }
  if (!patch.toString().startsWith(`From ${manifest.patch_commit} `)) {
    throw new PatchError('PATCH_COMMIT', 'The patch header does not match the pinned source patch commit.')
  }
  let source
  try { source = realpathSync(sourcePath) } catch {
    throw new PatchError('SOURCE_MISSING', 'Select an existing DSH source checkout with --source.')
  }
  const top = successful(runGit(source, ['rev-parse', '--show-toplevel']), 'SOURCE_NOT_GIT', 'Select a DSH Git source checkout root.')
  if (!sameDirectory(top, source)) throw new PatchError('SOURCE_NOT_ROOT', '--source must select the checkout root.')
  const head = successful(runGit(source, ['rev-parse', 'HEAD']), 'HEAD_UNAVAILABLE', 'The source HEAD cannot be read.')
  if (head !== manifest.base_commit) {
    throw new PatchError('UNSUPPORTED_BASE', 'This source revision is not the verified MCP resource patch base. Do not apply it to installed DSH or a different upstream revision.')
  }
  const stats = successful(runGit(source, ['apply', '--numstat', '-z', '-'], patch), 'PATCH_INVALID', 'The resource patch is not a valid Git patch.')
  const paths = stats.split('\0').filter(Boolean).map(line => line.split('\t').slice(2).join('\t')).sort()
  if (JSON.stringify(paths) !== JSON.stringify([...manifest.files].sort())) {
    throw new PatchError('PATCH_SCOPE', 'The patch file set does not match the resource manifest.')
  }
  const outcome = state => ({ state, base_commit: head, patch_commit: manifest.patch_commit, files: paths.length })
  const status = runGit(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  successful(status, 'STATUS_UNAVAILABLE', 'The source working tree cannot be inspected.')
  const changes = status.stdout.split('\0').filter(Boolean)
  // Mixed index/worktree edits can hide another staged change even when working bytes match.
  const onlyPatchPaths = changes.every(entry => [' M', 'M ', 'A ', '??'].includes(entry.slice(0, 2)) && manifest.files.includes(entry.slice(3)))
  if (onlyPatchPaths && matchesPatch(source, manifest)
    && runGit(source, ['apply', '--reverse', '--check', '--whitespace=nowarn', '-'], patch).status === 0) return outcome('already-applied')
  if (changes.length) throw new PatchError('SOURCE_DIRTY', 'Use a clean isolated DSH checkout; existing edits and untracked files are preserved.')
  successful(runGit(source, ['apply', '--check', '--whitespace=nowarn', '-'], patch), 'PATCH_CONFLICT', 'The resource patch does not apply cleanly; no files were changed.')
  if (!apply) return outcome('ready')
  successful(runGit(source, ['apply', '--whitespace=nowarn', '-'], patch), 'APPLY_FAILED', 'Git could not apply the resource patch. Inspect this source checkout before retrying.')
  successful(runGit(source, ['apply', '--reverse', '--check', '--whitespace=nowarn', '-'], patch), 'VERIFY_FAILED', 'The patched source failed verification; inspect the source diff before building.')
  if (!matchesPatch(source, manifest)) throw new PatchError('VERIFY_FAILED', 'The patched files differ from the pinned resource blobs; inspect the source diff before building.')
  return outcome('applied')
}

export function main(args) {
  let source, apply = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--source') source = args[++index]
    else if (arg === '--apply') apply = true
    else if (arg === '--check') apply = false
    else if (arg === '--help') {
      console.log('node plugins/mcp-resource-artifacts/source-patch.mjs --source <clean-dsh-checkout> [--check|--apply]')
      console.log('Default: check only. Applies source files; never installs, builds, changes profiles, or starts tasks.')
      return
    } else throw new PatchError('USAGE', 'Use --source <checkout> and --check or --apply.')
  }
  if (!source) throw new PatchError('USAGE', '--source <DSH source checkout> is required; default mode is read-only.')
  console.log(JSON.stringify(prepare(source, { apply })))
}

function isEntryPoint() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isEntryPoint()) {
  try { main(process.argv.slice(2)) } catch (error) {
    const known = error instanceof PatchError
    console.error(JSON.stringify({ error: known ? error.code : 'UNEXPECTED', message: known ? error.message : 'Cannot prepare this source; no installation was attempted.' }))
    process.exitCode = 1
  }
}
