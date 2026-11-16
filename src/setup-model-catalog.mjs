// Read only the installed harness's static chat catalog. No generation, login,
// remote discovery or credential values are needed for this operation.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
const entry = realpathSync(process.argv[2]);
const providers = JSON.parse(process.argv[3]);
if (!Array.isArray(providers) || providers.length > 32 || providers.some(id => typeof id !== 'string' || !/^[a-z0-9._-]{1,100}$/.test(id))) throw new Error('INVALID_PROVIDERS');
let sdk;
for (const name of ['@earendil-works/pi-ai/providers/all', '@mariozechner/pi-ai']) {
  try { sdk = await import(import.meta.resolve(name, pathToFileURL(entry).href)); break; }
  catch { /* The older supported harness uses a different static SDK entry. */ }
}
const listing = sdk && (sdk.getBuiltinModels || sdk.getModels);
if (typeof listing !== 'function') throw new Error('CATALOG_UNAVAILABLE');
const choices = [];
for (const provider of providers) {
  const models = await listing(provider);
  for (const model of models || []) {
    if (typeof model.id !== 'string' || !model.id || model.id.length > 200 || /[\u0000-\u001f\u007f]/.test(model.id)) continue;
    choices.push({ provider, model: model.id, profiles: ['web', 'tui'] });
    if (choices.length >= 128) break;
  }
  if (choices.length >= 128) break;
}
process.stdout.write(JSON.stringify(choices));
