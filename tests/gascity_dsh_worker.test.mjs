import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('../scripts/gascity-dsh-worker.mjs', import.meta.url));
const options = { skip: process.platform !== 'linux' };
function fixture(t, { exit = 0, credential = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rdsh-gc-contract-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const name of ['state', 'work']) mkdirSync(path.join(root, name));
  const writeBin = (name, body) => { const file = path.join(root, name); writeFileSync(file, `#!${process.execPath}\n${body}`, {mode: 0o700}); return file; };
  const gc = writeBin('gc', `if(process.argv[2]!=='prime'||process.argv[3]!=='worker')process.exit(2); console.log('TASK_FROM_GASCITY');`);
  const rdsh = writeBin('rdsh', `
    import assert from 'node:assert/strict';
    assert.equal(process.env.UNRELATED_CREDENTIAL, undefined);
    assert.equal(process.argv.at(-1), 'TASK_FROM_GASCITY\\n');
    assert.notEqual(process.env.HOME, process.env.DSH_HOME);
    console.error(process.env.DEEPINFRA_API_KEY);
    console.log(JSON.stringify({type:'session',sessionId:'dsh-contract'}));
    console.log(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'completed'}}));
    console.log(JSON.stringify({type:'final',text:'DONE'}));
    process.exit(${exit});
  `);
  const keyFile = path.join(root, 'key.env');
  writeFileSync(keyFile, credential ? 'DEEPINFRA_API_KEY=contract-secret' : '');
  const config = path.join(root, 'runtime.json');
  writeFileSync(config, JSON.stringify({gc, rdsh, dshEntry:'/unused', keyFile, stateDir:path.join(root,'state'), model:'fixture', timeoutSeconds:5}));
  return { root, run: () => spawnSync(process.execPath, [worker], { cwd: path.join(root,'work'), encoding:'utf8', timeout:10000,
    env:{PATH:process.env.PATH, RDSH_SWARM_CONFIG:config, GC_SESSION_ID:'gc-contract', GC_TEMPLATE:'worker', UNRELATED_CREDENTIAL:'not-forwarded'} }),
    result: () => JSON.parse(readFileSync(path.join(root, 'state/gc-contract/result.json'), 'utf8')) };
}
test('Gas City prompt delegation, isolated environment, credential redaction and duplicate refusal', options, t => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(f.result().completed, true);
  assert.equal(f.result().dsh_session_id, 'dsh-contract');
  const stderr = readFileSync(path.join(f.root,'state/gc-contract/stderr.txt'),'utf8');
  assert.ok(!stderr.includes('contract-secret'));
  assert.match(stderr, /REDACTED/);
  const before = JSON.stringify(f.result());
  assert.notEqual(f.run().status, 0);
  assert.equal(JSON.stringify(f.result()), before);
});
test('a nonzero DSH exit remains a failed worker', options, t => {
  const f = fixture(t, {exit:7});
  assert.equal(f.run().status, 7);
  assert.equal(f.result().code, 7);
});
test('missing credentials produce a durable failure before launching DSH', options, t => {
  const f = fixture(t, {credential:false});
  assert.equal(f.run().status, 1);
  assert.equal(f.result().completed, false);
  assert.match(f.result().error, /credential/);
});
