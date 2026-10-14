// Run the same real-server acceptance flows in all supported product languages.
import { spawn } from 'node:child_process';
import path from 'node:path';
const output=path.resolve(process.env.RDSH_E2E_OUTPUT || path.join(import.meta.dirname,'../../target/e2e'));
for(const language of ['en','zh-CN','ja']) {
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'browser.mjs')],{stdio:'inherit',env:{...process.env,RDSH_E2E_LANGUAGE:language,RDSH_E2E_OUTPUT:path.join(output,language)}});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  if(code!==0)throw new Error(`Browser language acceptance failed: ${language} (exit ${code})`);
}
