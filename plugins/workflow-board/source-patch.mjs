#!/usr/bin/env node
// Compatibility adapter. Patch validation, Git operations and hashing live in Rust.
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const bundle = dirname(realpathSync(fileURLToPath(import.meta.url)))
export class PatchError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
function nativeBin() {
  if (process.env.RDSH_BIN) return process.env.RDSH_BIN
  const name = process.platform === 'win32' ? 'rdsh.exe' : 'rdsh'
  for (const mode of ['debug', 'release']) {
    const file = resolve(bundle, '../../target', mode, name)
    if (existsSync(file)) return file
  }
  return 'rdsh'
}
export function prepare(source, { apply = false, patch, manifest } = {}) {
  if (typeof source !== 'string' || !source) throw new PatchError('USAGE', '--source is required.')
  patch ??= readFileSync(resolve(bundle, 'workflow-board.patch'))
  manifest ??= JSON.parse(readFileSync(resolve(bundle, 'manifest.json'), 'utf8'))
  const result = spawnSync(nativeBin(), ['workflow-board', '--json-stdin'], {
    input: JSON.stringify({ source, apply, patch: patch.toString('utf8'), manifest }),
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000,
  })
  if (result.error) throw new PatchError('RDSH_UNAVAILABLE', 'Build rdsh with cargo build, or set RDSH_BIN to the new binary.')
  if (result.status !== 0) {
    let failure
    try { failure = JSON.parse(result.stderr.trim()) } catch {}
    throw new PatchError(failure?.error || 'RDSH_FAILED', failure?.message || 'Build a current rdsh binary and inspect the source before retrying.')
  }
  try { return JSON.parse(result.stdout) } catch {
    throw new PatchError('RDSH_FAILED', 'The native patch tool returned an invalid result.')
  }
}
export function main(args) {
  let source, apply = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--source') source = args[++index]
    else if (arg === '--apply') apply = true
    else if (arg === '--check') apply = false
    else if (arg === '--help') {
      console.log('rdsh workflow-board --source <clean-dsh-checkout> [--check|--apply]')
      console.log('Node adapter: node plugins/workflow-board/source-patch.mjs --source <checkout> [--check|--apply]')
      return
    } else throw new PatchError('USAGE', 'Use --source <checkout> and --check or --apply.')
  }
  console.log(JSON.stringify(prepare(source, { apply })))
}
function isEntryPoint() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}
if (isEntryPoint()) {
  try { main(process.argv.slice(2)) } catch (error) {
    const known = error instanceof PatchError
    console.error(JSON.stringify({ error: known ? error.code : 'UNEXPECTED', message: known ? error.message : 'Cannot prepare the selected source.' }))
    process.exitCode = 1
  }
}
