import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// npm run supplies its own JS entry on all three OSes; no shell quoting or
// reliance on Windows executing npm.cmd directly is required.
if (!process.env.npm_execpath) throw new Error('Run through npm run test:packed');
const consumer = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const filename = manifest.name.slice(1).replace('/', '-') + '-' + manifest.version + '.tgz';
const archive = join(resolve(process.argv[3]), filename);
execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--prefix', consumer,
  '--prefer-offline', '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], { stdio: 'inherit' });
execFileSync(process.execPath, [fileURLToPath(new URL('./packed-sdk.mjs', import.meta.url)), consumer], { stdio: 'inherit' });
