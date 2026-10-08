import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,symlinkSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [beforeBin,afterBin,beforeSource,afterSource,outputFile]=process.argv.slice(2);
const root=mkdtempSync(path.join(os.tmpdir(),'rdsh-runtime-bench-'));
const home=path.join(root,'home'),dsh=path.join(root,'dsh'),system=path.join(root,'system-bin');
for (const dir of [home,dsh,system]) mkdirSync(dir);
const tree=path.join(root,`node-v${process.versions.node}-linux-x64`);
mkdirSync(path.join(tree,'bin'),{recursive:true});
const paired=path.join(tree,'bin','node'),fallback=path.join(system,'node');
copyFileSync(process.execPath,paired);copyFileSync(process.execPath,fallback);
const library=path.join(tree,'lib','node_modules','@deepseek-ai','dsh','lib');
mkdirSync(library,{recursive:true});
const entry=path.join(library,'bin.js');
writeFileSync(entry,'console.log(process.execPath);\n');
const env={...process.env,HOME:home,DSH_HOME:dsh,XDG_DATA_HOME:root,XDG_CONFIG_HOME:root,XDG_CACHE_HOME:root,RDSH_ORIG_BIN:entry,RDSH_PASSTHROUGH:'1',PATH:system+path.delimiter+process.env.PATH};
for (const key of ['DSH_ORIG_BIN','RDSH_DEFAULT_PROFILE','NPM_BIN','RDSH_SYNC_VERSION','RDSH_SYNC_FROM_SOURCE','RDSH_MUSL','NODE_COMPILE_CACHE','RDSH_NODE_COMPILE_CACHE']) delete env[key];
const wrappers={};
for (const [name,bin] of [['before',beforeBin],['after',afterBin]]) {
  mkdirSync(path.join(root,name));const wrapper=path.join(root,name,'dsh');
  copyFileSync(bin,wrapper);wrappers[name]=wrapper;
}
function measure(name) {
  const start=process.hrtime.bigint();
  const result=spawnSync(wrappers[name],['--version'],{env,encoding:'utf8',timeout:10000});
  const elapsed=Number(process.hrtime.bigint()-start)/1e6;
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),name==='before'?fallback:paired);
  return elapsed;
}
for (let i=0;i<5;i++) {measure('before');measure('after');}
const samples={before:[],after:[]};
for (let i=0;i<30;i++) for (const name of i%2?['after','before']:['before','after']) samples[name].push(measure(name));
function stats(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  return {medianMs:(sorted[14]+sorted[15])/2,p95Ms:sorted[Math.ceil(sorted.length*.95)-1],minMs:sorted[0],maxMs:sorted.at(-1),samplesMs:values};
}
const pkgRoot=path.join(root,'packages'),pkg=path.join(pkgRoot,'@deepseek-ai','dsh');
mkdirSync(pkg,{recursive:true});
const npm=path.join(root,'npm'),versionsFile=path.join(root,'versions.json');
writeFileSync(npm,'#!/bin/sh\ncase "$1" in root) printf "%s\\n" "$FIXTURE_PACKAGE_ROOT" ;; view) cat "$FIXTURE_VERSIONS" ;; *) echo "mutation refused" >&2; exit 91 ;; esac\n',{mode:0o700});
mkdirSync(path.join(home,'.local','bin'),{recursive:true});
symlinkSync(process.execPath,path.join(home,'.local','bin','node'));
const cases=[
  {name:'stable beats release candidate',current:'0.2.0',versions:['0.2.0-rc.99','0.2.0'],format:'pretty'},
  {name:'numeric rc ordering with compact JSON',current:'0.2.0-rc.2',versions:['0.2.0-rc.2','0.2.0-rc.10'],format:'compact'},
  {name:'no downgrade',current:'9.0.0',versions:['8.0.0','8.1.0-rc.1'],format:'pretty'},
  {name:'build metadata has no precedence',current:'1.0.0',versions:['1.0.0+another-build'],format:'pretty'},
];
const differences=[];
for (const scenario of cases) {
  writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:scenario.current}));
  writeFileSync(versionsFile,JSON.stringify(scenario.versions,null,scenario.format==='pretty'?2:0));
  const difference={...scenario};
  for (const [name,source] of [['before',beforeSource],['after',afterSource]]) {
    const result=spawnSync('sh',[path.join(source,'sync-dsh.sh'),'--check-only','--channel=any'],{env:{...env,NPM_BIN:npm,FIXTURE_PACKAGE_ROOT:pkgRoot,FIXTURE_VERSIONS:versionsFile},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    difference[name]={exitCode:result.status,stdout:result.stdout,stderr:result.stderr};
  }
  differences.push(difference);
}
const sha256=bin=>createHash('sha256').update(readFileSync(bin)).digest('hex');
const result={baselineCommit:'96dbcbbd6e1295b2e92ba31e9cf9037770107b24',candidateCommit:'81e38f32d3442de9c89e95fa2d7a034c54771621',os:os.type(),release:os.release(),cpu:os.cpus()[0]?.model,node:process.version,warmups:5,n:30,order:'alternating before/after; reverse every other pair',fixture:'Two copies of the same actual Node runtime, with matching-tree DSH metadata entry and synthetic HOME. No model/provider calls.',beforeBinarySha256:sha256(beforeBin),afterBinarySha256:sha256(afterBin),before:stats(samples.before),after:stats(samples.after),delegation:{before:fallback,after:paired,args:['--version'],bothExitZero:true},updateOutputDifferences:differences};
writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({before:result.before.medianMs,after:result.after.medianMs,beforeP95:result.before.p95Ms,afterP95:result.after.p95Ms,outputFile}));
