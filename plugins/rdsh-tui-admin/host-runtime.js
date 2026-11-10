import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve from the running Host before the local plugin. A file:// plugin has
// no node_modules of its own; never install another copy of the Host runtime.
export async function hostModule(ctx, specifier) {
  const anchors = [ctx.get('profileContext')?.installAnchor, process.argv[1], import.meta.url,
    join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/package.json')];
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || (!isAbsolute(anchor) && !anchor.startsWith('file:'))) continue;
    let resolved;
    try { resolved = createRequire(anchor).resolve(specifier); } catch { continue; }
    return import(pathToFileURL(resolved).href);
  }
  throw new Error('The installed DSH runtime is unavailable');
}
