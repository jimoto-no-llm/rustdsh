import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProductLocale, resolveProductLocale } from "../product-locale.mjs";

test("dashboard language uses the CLI precedence and first nonblank OS value", () => {
  assert.equal(resolveProductLocale("en", "ja", {RDSH_LANG:"zh"}), "en");
  assert.equal(resolveProductLocale(undefined,"ja",{RDSH_LANG:"zh_CN.UTF-8"}),"zh-CN");
  assert.equal(resolveProductLocale(undefined,"ja",{RDSH_LANG:"   ",LANG:"en"}),"ja");
  assert.equal(resolveProductLocale(undefined,"auto",{LC_ALL:"C",LANG:"ja"}),"en");
  assert.equal(resolveProductLocale(undefined,"auto",{LC_ALL:" ",LC_MESSAGES:"Japanese_Japan.932"}),"ja");
  assert.equal(resolveProductLocale(undefined,"auto",{LANG:"Chinese_China.936"}),"zh-CN");
  assert.equal(resolveProductLocale(undefined,"auto",{}),"en");
});

test("dashboard refuses invalid persisted language even with an explicit override and preserves bytes", async t => {
  const root=await mkdtemp(path.join(tmpdir(),"rdsh-language-settings-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const env={DSH_HOME:root};const file=path.join(root,"rdsh.json");
  assert.equal(await loadProductLocale(undefined,env),"en");
  for(const language of ["en","zh-CN","ja"]){await writeFile(file,JSON.stringify({general:{language}}));assert.equal(await loadProductLocale(undefined,env),language);}
  for(const invalid of ['{"general":{"language":"xx"}}','{"general":{"language":null}}','{broken']){
    await writeFile(file,invalid);await assert.rejects(loadProductLocale("ja",env));assert.equal(await readFile(file,"utf8"),invalid);
  }
});
