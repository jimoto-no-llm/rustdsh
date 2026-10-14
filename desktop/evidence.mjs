// Official Host smokes print a private loopback URL. Keep its temporary token,
// authorization values and email addresses out of public diagnostic output.
import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function redactOutput(value) {
  return String(value)
    .replace(/(https?:\/\/)[^/\s@]+@/giu, '$1[redacted]@')
    .replace(/([?&](?:token|api_key|access_token|refresh_token|password|secret)=)[^&\s"'<>\\]+/giu, '$1[redacted]')
    .replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]+/giu, '$1 [redacted]')
    .replace(/("(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret)"\s*:\s*")(?:\\.|[^"\\])*(")/giu, '$1[redacted]$2')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]');
}

export async function collectEvidence(source, output) {
  const input = resolve(source), destination = resolve(output), stat = await lstat(input);
  const relation = relative(input, destination);
  if (relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep)))
    throw new Error('Evidence output must be outside the diagnostic source');
  if (stat.isSymbolicLink()) throw new Error('Diagnostic links are refused');
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(input)) await collectEvidence(join(input, name), join(destination, name));
  } else if (stat.isFile()) {
    if (stat.size > 67108864) throw new Error('Diagnostic file is too large');
    await writeFile(destination, redactOutput(await readFile(input, 'utf8')), { flag: 'wx' });
  } else throw new Error('Unexpected diagnostic file');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' } } });
  if (!values.source || !values.output) throw new Error('Usage: node desktop/evidence.mjs --source <packaging logs> --output <fresh evidence directory>');
  await collectEvidence(values.source, values.output);
  console.log('PASS redacted packaging diagnostics');
}
