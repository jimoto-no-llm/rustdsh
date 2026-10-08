import { createRequire } from 'node:module';
import z from '@deepseek-ai/schemastery';
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools';
import { CatalogError, createCatalog } from './catalog.js';
import { catalogTools } from './tools.js';

export const inject = ['tools', 'systemPrompt', 'ptcRuntime'];
export const name = 'rdsh-ptc-catalog';
export const Config = z.object({
  inlineTokenBudget: z.number().default(16384),
  inlineTools: z.array(z.string()).default([]),
  maxSearchResults: z.number().default(20),
});

const require = createRequire(import.meta.url);
const renderers = { typescript: renderToolsSdk, python: renderToolsSdkPy };

export function apply(ctx, config = {}) {
  // The mandatory rdsh launcher deliberately forces Native and denies run_code.
  // This opt-in metadata extension must never lift or emulate that boundary.
  if (globalThis[Symbol.for('rdsh.tool-boundary.install')])
    throw new CatalogError('RDSH_CATALOG_GUARDED_NATIVE', 'The guarded rdsh launcher requires Native tools; this catalog requires an existing authorized DSH PTC composition');
  if (require('@deepseek-ai/dsh-tools/package.json').version !== '0.2.0-rc.2')
    throw new CatalogError('RDSH_CATALOG_VERSION', 'rdsh-ptc-catalog supports @deepseek-ai/dsh-tools 0.2.0-rc.2');
  if (!ctx.get('ptcRuntime'))
    throw new CatalogError('RDSH_CATALOG_RUNTIME', 'Load an original DSH PTC runtime before rdsh-ptc-catalog');
  const catalog = createCatalog(ctx.tools, renderers, config);
  const getLanguage = () => ctx.get('ptcRuntime')?.language;
  const definitions = catalogTools(catalog, getLanguage);
  const disposers = [];
  const dispose = () => {
    for (const fn of disposers.splice(0).reverse()) fn();
  };
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register(definition));
    disposers.push(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next();
      // An empty/missing SDK section is Native. Do not change modes, wire tool
      // schemas, complete prompts, bindings, guards, or executor methods.
      if (!result.sections.some(section => section.name === 'tools:sdk' && section.text)) return result;
      const bounded = catalog.inline(context.scope, getLanguage(), definitions);
      return { ...result, sections: result.sections.map(section => section.name === 'tools:sdk'
        ? { ...section, text: bounded.text, interpolate: false } : section) };
    }));
    return ctx.effect(() => dispose);
  } catch (error) {
    dispose();
    throw error;
  }
}
