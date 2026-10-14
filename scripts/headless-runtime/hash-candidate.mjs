import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

const candidate = process.argv[2];
if (!candidate) throw new Error('usage: node hash-candidate.mjs <candidate-directory>');
const root = await realpath(candidate);
const entries = [];
const normalizedMode = entry => (entry.mode & 0o777).toString(8).padStart(3, '0');

async function walk(directory) {
  const directoryStat = await lstat(directory);
  entries.push({ kind: 'directory', relative: path.relative(root, directory) || '.', mode: normalizedMode(directoryStat), value: '' });
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const stat = await lstat(file);
    const relative = path.relative(root, file);
    if (stat.isDirectory()) await walk(file);
    else if (stat.isSymbolicLink()) entries.push({ kind: 'symlink', relative, mode: normalizedMode(stat), value: await readlink(file) });
    else if (stat.isFile()) entries.push({ kind: 'file', relative, mode: normalizedMode(stat), value: createHash('sha256').update(await readFile(file)).digest('hex') });
  }
}

await walk(root);
entries.sort((left, right) => left.relative.localeCompare(right.relative));
const hash = createHash('sha256');
for (const entry of entries) hash.update(`${entry.kind}\0${entry.mode}\0${entry.relative}\0${entry.value}\n`);
console.log(JSON.stringify({ candidate: root, sha256: hash.digest('hex'), files: entries.filter(entry => entry.kind === 'file').length, directories: entries.filter(entry => entry.kind === 'directory').length, links: entries.filter(entry => entry.kind === 'symlink').length }));
