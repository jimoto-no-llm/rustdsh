import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, symlinkSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const binary = path.resolve(process.env.BIN || `target/debug/rdsh${process.platform === 'win32' ? '.exe' : ''}`);
function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'rdsh-runtime-compat-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'), dsh=path.join(root,'dsh-home');
  mkdirSync(home);mkdirSync(dsh);
  const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,XDG_DATA_HOME:root,XDG_CONFIG_HOME:root,XDG_CACHE_HOME:root};
  for (const key of ['RDSH_ORIG_BIN','DSH_ORIG_BIN','RDSH_DEFAULT_PROFILE','NPM_BIN','RDSH_MUSL','RDSH_SYNC_FROM_SOURCE','RDSH_SYNC_VERSION']) delete env[key];
  return {root,home,dsh,env};
}

test('metadata delegation uses the selected DSH tree interpreter, resolves aliases, and retains PATH fallbacks', t=>{
  const {root,env}=fixture(t);
  const wrapper=path.join(root,process.platform==='win32'?'dsh.exe':'dsh');
  copyFileSync(binary,wrapper);
  env.RDSH_PASSTHROUGH='1';
  const nodeName=process.platform==='win32'?'node.exe':'node';
  const platform=process.platform==='win32'?'win':process.platform==='darwin'?'darwin':'linux';
  const architecture=process.arch==='arm64'?'arm64':'x64';
  const tree=path.join(root,`node-v${process.versions.node}-${platform}-${architecture}`);
  const treeBin=path.join(tree,'bin'), systemBin=path.join(root,'system-bin');
  mkdirSync(treeBin,{recursive:true});mkdirSync(systemBin);
  const treeNode=path.join(treeBin,nodeName), systemNode=path.join(systemBin,nodeName);
  copyFileSync(process.execPath,treeNode);copyFileSync(process.execPath,systemNode);
  env.PATH=systemBin+path.delimiter+(env.PATH||'');
  const library=path.join(tree,'lib','node_modules','@deepseek-ai','dsh','lib');
  mkdirSync(library,{recursive:true});
  const entry=path.join(library,'bin.js');
  writeFileSync(entry,'console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}));\n');
  function check(target,expected) {
    const result=spawnSync(wrapper,['--version'],{env:{...env,RDSH_ORIG_BIN:target},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const output=JSON.parse(result.stdout);
    const canonical=value=>{
      const resolved=realpathSync.native(value);
      return process.platform==='win32'?resolved.toLowerCase():resolved;
    };
    assert.equal(canonical(output.node),canonical(expected));
    assert.deepEqual(output.args,['--version']);
  }
  check(entry,treeNode);
  const alias=path.join(root,'launcher-alias');
  symlinkSync(library,alias,process.platform==='win32'?'junction':'dir');
  check(path.join(alias,'bin.js'),treeNode);
  const foreign=path.join(root,`node-v${process.versions.node}-other-${architecture}`);
  mkdirSync(path.join(foreign,'bin'),{recursive:true});mkdirSync(path.join(foreign,'lib'));
  copyFileSync(process.execPath,path.join(foreign,'bin',nodeName));
  copyFileSync(entry,path.join(foreign,'lib','bin.js'));
  check(path.join(foreign,'lib','bin.js'),systemNode);
  rmSync(treeNode);check(entry,systemNode);
  mkdirSync(treeNode);check(entry,systemNode);
  if (process.platform === 'win32') {
    const rootNode=path.join(tree,nodeName);copyFileSync(process.execPath,rootNode);
    check(entry,rootNode);
  }
  const standalone=path.join(root,'standalone.js');copyFileSync(entry,standalone);check(standalone,systemNode);
});

test('sync --check-only follows SemVer precedence and never upgrades to a lower version', {skip:process.platform==='win32'?'sync-dsh.sh is Unix-only':false},t=>{
  const {root,home,env}=fixture(t);
  const pkgRoot=path.join(root,'packages'), pkg=path.join(pkgRoot,'@deepseek-ai','dsh');
  mkdirSync(pkg,{recursive:true});
  const npm=path.join(root,'npm-fixture');
  writeFileSync(npm,'#!/bin/sh\ncase "$1" in root) printf "%s\\n" "$FIXTURE_PACKAGE_ROOT" ;; view) cat "$FIXTURE_VERSIONS" ;; *) echo "unexpected npm mutation" >&2; exit 91 ;; esac\n',{mode:0o700});
  const nodeDir=path.join(home,'.local','bin');mkdirSync(nodeDir,{recursive:true});
  symlinkSync(process.execPath,path.join(nodeDir,'node'));
  const versionsFile=path.join(root,'versions.json');
  const cases=[
    {current:'0.2.0-rc.2',versions:['0.2.0-rc.2','0.2.0'],latest:'0.2.0',update:true},
    {current:'0.2.0',versions:['0.2.0-rc.99','0.2.0'],latest:'0.2.0',update:false},
    {current:'0.2.0-rc.2',versions:['0.2.0-rc.2','0.2.0-rc.10'],latest:'0.2.0-rc.10',update:true},
    {current:'1.0.0-alpha',versions:['1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0'],latest:'1.0.0',update:true},
    {current:'1.0.0-beta.2',versions:['1.0.0-beta.11','1.0.0-beta.2'],latest:'1.0.0-beta.11',update:true},
    {current:'1.0.0-alpha.2',versions:['1.0.0-alpha.2','1.0.0-alpha.beta'],latest:'1.0.0-alpha.beta',update:true},
    {current:'1.0.0',versions:['1.0.0+different-build'],latest:'1.0.0+different-build',update:false},
    {current:'9.0.0',versions:['8.0.0','8.1.0-rc.1'],latest:'8.1.0-rc.1',update:false},
    {current:'1.0.0',versions:['1.0.0-beta','1.0.0-rc.2','1.0.0','1.1.0-beta'],latest:'1.0.0',update:false,channel:'rc'},
    {current:'0.2.0-rc.2',versions:['0.2.0-rc.2','0.2.1-alpha.1'],latest:'0.2.1-alpha.1',update:true},
    {current:'0.2.0-rc.2',versions:['0.2.0-rc.2','0.2.1-alpha.1'],latest:'0.2.0-rc.2',update:false,channel:'rc'},
    {current:'0.2.1-alpha.1',versions:['0.2.0-rc.2','0.2.1-alpha.1'],latest:'0.2.1-alpha.1',update:false},
    {current:'1.9.0',versions:['1.9.0','1.10.0'],latest:'1.10.0',update:true},
    {current:'1.0.0',versions:['1.0.0','01.0.0','1.0.0-rc.01','2.0.0..','999'],latest:'1.0.0',update:false},
    {current:'9007199254740992.0.0',versions:['9007199254740993.0.0','9007199254740992.0.0'],latest:'9007199254740993.0.0',update:true},
  ];
  for (const scenario of cases) {
    writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:scenario.current}));
    writeFileSync(versionsFile,JSON.stringify(scenario.versions));
    const result=spawnSync('sh',['sync-dsh.sh','--check-only',`--channel=${scenario.channel||'any'}`],{env:{...env,NPM_BIN:npm,FIXTURE_PACKAGE_ROOT:pkgRoot,FIXTURE_VERSIONS:versionsFile},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    assert.ok(result.stdout.includes(`latest(${scenario.channel||'any'})=${scenario.latest}`),JSON.stringify({scenario,output:result.stdout}));
    assert.equal(result.stdout.includes('dsh update available:'),scenario.update,result.stdout);
  }
  for (const [current,versions] of [['invalid',['1.0.0']],['1.0.0',['broken','01.0.0']]]) {
    writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:current}));
    writeFileSync(versionsFile,JSON.stringify(versions));
    const result=spawnSync('sh',['sync-dsh.sh','--check-only'],{env:{...env,NPM_BIN:npm,FIXTURE_PACKAGE_ROOT:pkgRoot,FIXTURE_VERSIONS:versionsFile},encoding:'utf8',timeout:15000});
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.match(result.stdout,/binaries untouched/);
  }
  writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'1.0.0'}));
  for (const versions of ['not-json','[]','{}','["1.0.0", 2]']) {
    writeFileSync(versionsFile,versions);
    const result=spawnSync('sh',['sync-dsh.sh','--check-only'],{env:{...env,NPM_BIN:npm,FIXTURE_PACKAGE_ROOT:pkgRoot,FIXTURE_VERSIONS:versionsFile},encoding:'utf8',timeout:15000});
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.match(result.stdout,/binaries untouched/);
  }
  const invalidChannel=spawnSync('sh',['sync-dsh.sh','--check-only','--channel=typo'],{env,encoding:'utf8',timeout:15000});
  assert.equal(invalidChannel.status,2,invalidChannel.stdout+invalidChannel.stderr);
  assert.match(invalidChannel.stderr,/unsupported channel/);
});
