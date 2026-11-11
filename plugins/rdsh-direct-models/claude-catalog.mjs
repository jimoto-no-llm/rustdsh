// Read installed, credential-free model metadata. Never call the legacy adapter.
import { createRequire, findPackageJSON } from 'node:module';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function builtinModels() {
  const anchors = [import.meta.url, pathToFileURL(path.join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/package.json')).href];
  for (const anchor of anchors) {
    try {
      const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-llm-pi-ai');
      const manifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(entry));
      const data = JSON.parse(await readFile(manifest, 'utf8'));
      const target = data.exports?.['./providers/*']?.import;
      if (typeof target !== 'string' || !target.startsWith('./') || target.includes('..')) continue;
      const api = await import(pathToFileURL(path.resolve(path.dirname(manifest), target.replace('*', 'all'))).href);
      if (typeof api.getBuiltinModels === 'function') return api.getBuiltinModels;
    } catch { /* Another installation anchor may own the catalog. */ }
  }
  throw new Error('Claude CLI: installed model catalog unavailable');
}

export async function discoverClaudeModels({ getModels } = {}) {
  const rows = (getModels ?? await builtinModels())('anthropic');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Claude CLI: empty installed model catalog');
  const seen = new Set();
  return rows.map(row => {
    if (typeof row?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(row.id) || seen.has(row.id))
      throw new Error('Claude CLI: invalid installed model catalog');
    seen.add(row.id);
    return { id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id };
  });
}
