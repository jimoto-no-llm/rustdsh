// Preserve macOS symlinks/permissions in a single CI artifact; no release upload.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packagedPaths } from './build.mjs';

const { values } = parseArgs({ options: { checkout: { type: 'string' }, output: { type: 'string' } } });
if (!values.checkout || !values.output) throw new Error('Usage: node desktop/archive.mjs --checkout <prepared source> --output <artifact directory>');
const paths = packagedPaths(values.checkout), output = resolve(values.output);
const record = JSON.parse(readFileSync(join(resolve(values.checkout), 'apps/desktop/rdsh-build.json'), 'utf8'));
mkdirSync(output, { recursive: true });
const archive = join(output, `rdsh-desktop-${record.rdshVersion}-${paths.target}-unsigned.zip`);
if (existsSync(archive) || existsSync(archive + '.sha256')) throw new Error('Archive output exists; use a fresh output directory');
if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', paths.application, archive]);
else execFileSync('tar.exe', ['-a', '-cf', archive, basename(paths.application)], { cwd: dirname(paths.application) });
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const digest = hash.digest('hex');
writeFileSync(archive + '.sha256', `${digest}  ${basename(archive)}\n`);
console.log(`PASS unsigned archive with SHA256: ${basename(archive)}`);
