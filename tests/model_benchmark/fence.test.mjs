import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGuard, apply } from './fence.mjs';

test('allow only existing fixture files; deny secrets, escapes, other tools and writes to read fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'rdsh-model-fence-'));
  try {
    const fixture = join(root, 'fixture.json'), code = join(root, 'lib.rs');
    writeFileSync(fixture, '{}'); writeFileSync(code, '');
    symlinkSync(process.execPath, join(root, 'outside'));
    const guard = makeGuard({ cwd: root, readable: [fixture, code], writable: [code] });
    const call = (name, file_path) => guard({ name, arguments: { file_path } });
    assert.equal(call('read', 'fixture.json'), undefined);
    assert.equal(call('edit', 'lib.rs'), undefined);
    assert.equal(call('write', 'lib.rs'), undefined);
    for (const [name, path] of [['write','fixture.json'], ['read','outside'], ['read','../.credentials.yaml'],
      ['read','missing'], ['bash',code], ['web',code], ['read_image',fixture], ['write','new.rs']]) {
      assert.equal(typeof call(name,path), 'string');
    }
    assert.equal(typeof guard({ name: 'read', arguments: {} }), 'string');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restrict advertised tools and stop before a request exceeds the budget', async () => {
  const hooks = new Map();
  const ctx = { tools: { guard() {} }, on(name, callback) { hooks.set(name, callback); } };
  assert.throws(() => apply(ctx, { readable: [], writable: [] }), /limit required/);
  apply(ctx, { readable: [], writable: [], maxRequests: 1 });
  let allowed;
  hooks.get('agent/created')({ agent: { ctx: { tools: { restrict(filter) { allowed = filter.allow; } } } } });
  assert.deepEqual(allowed, []);
  let networkRequests = 0;
  const next = () => { networkRequests++; return {}; };
  await hooks.get('agent/request')({}, next);
  await assert.rejects(hooks.get('agent/request')({}, next), /limit exceeded/);
  assert.equal(networkRequests, 1);
});
