import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

const TOKEN_FILE=`${homedir()}/.gemini/antigravity-cli/antigravity-oauth-token`;
// Matched against getOauthParams in this installed public desktop client.
// Public installed-app OAuth client config is not a user's credential.
const CLIENTS={
  consumer:{id:'1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',offset:52602875},
  gcp:{id:'884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com',offset:52602910},
};
const KNOWN_BINARY='ebd71c4db14f79fca3fd0160332a38d9037146737422dcfc1f1d21ba01a13fff';
export async function loadAgyCredentials({fetchImpl=fetch,signal,forceRefresh=false}={}) {
  const doc=JSON.parse(await fs.readFile(TOKEN_FILE,'utf8'));
  if(!forceRefresh && Date.parse(doc.token?.expiry)>Date.now()+60000)return doc;
  const client=CLIENTS[doc.auth_method];
  if(!client||!doc.token?.refresh_token)throw Error('Antigravity login needs renewal in its installed client');
  const binary=await fs.readFile('/opt/homebrew/bin/agy');
  if(createHash('sha256').update(binary).digest('hex')!==KNOWN_BINARY)throw Error('Antigravity installed OAuth client changed; verify its configuration before refresh');
  const clientSecret=binary.subarray(client.offset,client.offset+35).toString('utf8');
  if(!clientSecret.startsWith('GOCSPX-'))throw Error('Antigravity installed OAuth client config is unavailable');
  const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',signal,redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded','user-agent':'rdsh/0.3.3'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:doc.token.refresh_token,client_id:client.id,client_secret:clientSecret})});
  if(!response.ok){await response.body?.cancel();throw Error(`Antigravity OAuth refresh HTTP ${response.status}`);}
  const value=await response.json();
  if(typeof value.access_token!=='string'||!Number.isFinite(value.expires_in)||value.expires_in<=0)throw Error('Invalid Antigravity refresh response');
  doc.token={...doc.token,access_token:value.access_token,token_type:value.token_type??doc.token.token_type,refresh_token:value.refresh_token??doc.token.refresh_token,expiry:new Date(Date.now()+value.expires_in*1000).toISOString()};
  const tmp=TOKEN_FILE+'.rdsh-new';await fs.writeFile(tmp,JSON.stringify(doc),{mode:0o600});await fs.rename(tmp,TOKEN_FILE);
  return doc;
}
