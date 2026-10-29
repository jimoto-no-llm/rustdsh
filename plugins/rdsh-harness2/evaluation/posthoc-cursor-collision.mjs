// Exploratory counterexample found after harness selection; excluded from primary scores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const {collectPages}=await import(pathToFileURL(`${process.env.RDSH_FIXTURE_ROOT}/src/collect-pages.mjs`).href);
test('null initial cursor is distinct from every legal string cursor',async()=>{
  const sentinel='\0__null__'; const calls=[];
  const result=await collectPages(async cursor=>{calls.push(cursor);return cursor===null?{items:[{id:1}],nextCursor:sentinel}:{items:[{id:2}],nextCursor:null};});
  assert.deepEqual(calls,[null,sentinel]); assert.deepEqual(result,[{id:1},{id:2}]);
});
