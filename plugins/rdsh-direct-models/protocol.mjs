import {gunzipSync} from 'node:zlib';

export class NativeTransportError extends Error {
  constructor(message,{status,code='NATIVE_TRANSPORT_ERROR'}={}) {
    super(message);this.code=code;this.status=status;
  }
}
const MAX_FRAME=4*1024*1024;
const MAX_TOTAL=16*1024*1024;
export function frameJson(value) {
  const data=Buffer.from(JSON.stringify(value));
  if(data.length>MAX_FRAME)throw new NativeTransportError('Request exceeds transport size limit');
  const prefix=Buffer.alloc(5);prefix.writeUInt32BE(data.length,1);
  return Buffer.concat([prefix,data]);
}
function safeCode(value) {
  return typeof value==='string'&&/^[a-z_0-9-]{1,80}$/i.test(value)?value:'unknown';
}
function safeMessage(value,secrets=[]) {
  let text=typeof value==='string'?value:'';
  for(const secret of secrets)if(typeof secret==='string'&&secret.length>8)text=text.split(secret).join('[REDACTED]');
  return text.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi,'[REDACTED]').replace(/[A-Za-z0-9_-]{48,}/g,'[REDACTED]').slice(0,400);
}
async function check(response) {
  if(response.ok)return;
  let code='http_error';
  try {const data=await response.json();code=safeCode(data.code??data.error?.code);}catch{}
  throw new NativeTransportError(`Native endpoint returned HTTP ${response.status} (${code})`,{status:response.status,code});
}
export async function unaryConnect(url,body,{headers={},signal,fetchImpl=fetch}={}) {
  const response=await fetchImpl(url,{method:'POST',signal,headers:{'content-type':'application/json','connect-protocol-version':'1','user-agent':'rdsh/0.3.3 (+https://github.com/jimoto-no-llm/rustdsh)',...headers},body:JSON.stringify(body)});
  await check(response);
  const text=await response.text();
  if(Buffer.byteLength(text)>MAX_TOTAL)throw new NativeTransportError('Unary response exceeds size limit');
  let data;try{data=JSON.parse(text);}catch{throw new NativeTransportError('Native endpoint returned invalid JSON');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new NativeTransportError('Native endpoint returned an invalid response object');
  return data;
}
export async function* streamConnect(url,body,{headers={},signal,fetchImpl=fetch}={}) {
  const response=await fetchImpl(url,{method:'POST',signal,headers:{'content-type':'application/connect+json','connect-protocol-version':'1','connect-accept-encoding':'gzip','user-agent':'rdsh/0.3.3 (+https://github.com/jimoto-no-llm/rustdsh)',...headers},body:frameJson(body)});
  await check(response);
  const secrets=Object.entries(headers).filter(([key])=>/authorization/i.test(key)).flatMap(([,value])=>[value,String(value).replace(/^Bearer /i,'')]);
  yield* decodeConnect(response.body,{signal,secrets});
}
export async function* decodeConnect(stream,{signal,secrets=[]}={}) {
  let pending=Buffer.alloc(0),total=0,ended=false;
  if(!stream)throw new NativeTransportError('Missing Connect response stream');
  for await(const chunk of stream) {
    signal?.throwIfAborted();
    if(ended)throw new NativeTransportError('Data followed terminal Connect frame');
    total+=chunk.length;
    if(total>MAX_TOTAL)throw new NativeTransportError('Connect response exceeds size limit');
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=5) {
      const flags=pending[0],length=pending.readUInt32BE(1);
      if(length>MAX_FRAME)throw new NativeTransportError('Connect frame exceeds size limit');
      if(pending.length<5+length)break;
      let payload=pending.subarray(5,5+length);pending=pending.subarray(5+length);
      if(flags&~3)throw new NativeTransportError('Unsupported Connect flags');
      if(flags&1)payload=gunzipSync(payload,{maxOutputLength:MAX_FRAME});
      let value;try{value=JSON.parse(payload.toString('utf8'));}catch{throw new NativeTransportError('Invalid Connect JSON frame');}
      if(!value||typeof value!=='object'||Array.isArray(value))throw new NativeTransportError('Invalid Connect message object');
      if(flags&2) {
        if(value.error)throw new NativeTransportError(`Native RPC failed (${safeCode(value.error.code)}): ${safeMessage(value.error.message,secrets)}`,{code:safeCode(value.error.code)});
        ended=true;if(pending.length)throw new NativeTransportError('Data followed terminal Connect frame');
      } else yield value;
    }
  }
  if(pending.length||!ended)throw new NativeTransportError('Truncated Connect stream');
}
