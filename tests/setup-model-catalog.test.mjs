import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rdsh-model-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'harness.mjs'); writeFileSync(entry, '');
  const pkg = path.join(root, 'node_modules/@earendil-works/pi-ai'); mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({type: 'module', exports: {'./providers/all': './all.mjs'}}));
  writeFileSync(path.join(pkg, 'all.mjs'), `export function getBuiltinModels(provider) {return [{id: provider+'-chat', apiKey:'NEVER_RETURN_THIS'}, {id:'bad\\nmodel'}];}`);
  return entry;
}
test('static model choices are scoped to the requested providers and exclude secret fields', t => {
  const entry = fixture(t);
  const result = spawnSync(process.execPath, ['--experimental-import-meta-resolve', 'src/setup-model-catalog.mjs', entry, JSON.stringify(['openai', 'anthropic'])], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const choices = JSON.parse(result.stdout);
  assert.deepEqual(choices.map(x => [x.provider, x.model]), [['openai', 'openai-chat'], ['anthropic', 'anthropic-chat']]);
  assert.doesNotMatch(result.stdout, /NEVER_RETURN_THIS|bad/);
});
test('unbounded or malformed provider requests are refused', t => {
  const entry = fixture(t);
  for (const request of [['../command'], Array(33).fill('openai'), {provider:'openai'}]) {
    const result=spawnSync(process.execPath,['--experimental-import-meta-resolve','src/setup-model-catalog.mjs',entry,JSON.stringify(request)],{encoding:'utf8'});
    assert.notEqual(result.status,0);
  }
});
