import { connect } from 'node:http2';
import { NativeTransportError } from './protocol.mjs';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
function safeMessage(value,headers,secrets=[]) {
  if(typeof value!=='string')return '';
  let text=value;
  try{text=decodeURIComponent(text);}catch{}
  const sensitive=[...secrets];
  const entries=headers instanceof Headers?[...headers.entries()]:Object.entries(headers);
  for(const [key,value] of entries)if(/authorization|cookie|token|api.?key/i.test(key)&&typeof value==='string'){
    sensitive.push(value,value.replace(/^Bearer\s+/i,''));
  }
  for(const secret of sensitive.filter(value=>typeof value==='string'&&value).sort((a,b)=>b.length-a.length)){
    for(const variant of new Set([secret,encodeURIComponent(secret)]))text=text.split(variant).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [REDACTED]').replace(/\b(?:sk-|eyJ)[A-Za-z0-9_./+-]{12,}/g,'[REDACTED]').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300);
}
export function grpcFrame(bytes) {
  const body = Buffer.from(bytes);
  if (body.length > MAX_FRAME) throw new NativeTransportError('gRPC request exceeds frame limit');
  const header = Buffer.alloc(5); header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** Raw HTTP/2 gRPC, with mandatory terminal status; no remote agent execution. */
export async function* grpcStream(url, body, { headers = {}, signal, connectImpl = connect, timeoutMs = 60000, transport='grpc', secrets=[] } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'api2.cursor.sh' || target.port || target.username || target.password || target.search || target.hash) throw new NativeTransportError('Unsupported native gRPC host');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new NativeTransportError('Invalid native gRPC timeout');
  if(!['grpc','connect'].includes(transport))throw new NativeTransportError('Unsupported native HTTP2 transport');
  signal?.throwIfAborted();
  const requestBody = grpcFrame(body);
  let session, request, responseHeaders, trailers, timer;
  let timedOut = false, networkFailed = false;
  const abort = () => request?.destroy();
  try {
    session = connectImpl(target.origin);
    session.on('error', () => { networkFailed = true; request?.destroy(); });
    const suppliedHeaders=headers instanceof Headers?Object.fromEntries(headers.entries()):headers;
    request = session.request({ ...suppliedHeaders, ':method': 'POST', ':path': target.pathname, 'content-type': transport==='connect'?'application/connect+proto':'application/grpc+proto', te: 'trailers', ...(transport==='connect'?{'connect-protocol-version':'1','connect-accept-encoding':'identity'}:{'grpc-accept-encoding':'identity'}), 'user-agent': 'rdsh/0.3.3 (+https://github.com/jimoto-no-llm/rustdsh)' });
    request.on('response', value => { responseHeaders = value; });
    request.on('trailers', value => { trailers = value; });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { timedOut = true; request.destroy(); }, timeoutMs); timer.unref?.();
    signal?.throwIfAborted();
    request.end(requestBody);
    let pending = Buffer.alloc(0), total = 0, ended=false;
    for await (const chunk of request) {
      signal?.throwIfAborted();
      total += chunk.length;
      if (total > MAX_TOTAL) throw new NativeTransportError('gRPC response exceeds size limit');
      pending = Buffer.concat([pending, chunk]);
      if(ended&&pending.length)throw new NativeTransportError('Data followed terminal Connect frame');
      while (pending.length >= 5) {
        const flags=pending[0];
        if (flags !== 0 && !(transport==='connect'&&flags===2)) throw new NativeTransportError('Unsupported native HTTP2 frame flag');
        const length = pending.readUInt32BE(1);
        if (length > MAX_FRAME) throw new NativeTransportError('gRPC response exceeds frame limit');
        if (pending.length < 5 + length) break;
        const payload=pending.subarray(5,5+length);
        pending = pending.subarray(5 + length);
        if(flags===2){
          let terminal;
          try{terminal=JSON.parse(payload.toString('utf8'));}catch{throw new NativeTransportError('Invalid Connect terminal JSON');}
          if(!terminal||typeof terminal!=='object'||Array.isArray(terminal))throw new NativeTransportError('Invalid Connect terminal object');
          ended=true;
          if(terminal.error){
            const rawCode=terminal.error.code;
            const knownCodes=['canceled','unknown','invalid_argument','deadline_exceeded','not_found','already_exists','permission_denied','resource_exhausted','failed_precondition','aborted','out_of_range','unimplemented','internal','unavailable','data_loss','unauthenticated'];
            const code=knownCodes.includes(rawCode)?rawCode:'unknown';
            const message=safeMessage(terminal.error.message,headers,secrets);
            throw new NativeTransportError(`Native Connect failed (${code})${message?`: ${message}`:''}`,{code});
          }
          if(pending.length)throw new NativeTransportError('Data followed terminal Connect frame');
        }else yield payload;
      }
    }
    signal?.throwIfAborted();
    if (timedOut) throw new NativeTransportError('Native gRPC request timed out', { code: 'deadline_exceeded' });
    if (networkFailed) throw new NativeTransportError('Native gRPC connection failed');
    if (responseHeaders?.[':status'] !== 200) throw new NativeTransportError(`Native gRPC returned HTTP ${Number(responseHeaders?.[':status']) || 'unknown'}`);
    const expected=transport==='connect'?/^application\/connect\+proto(?:;|$)/i:/^application\/grpc(?:\+proto)?(?:;|$)/i;
    if (!expected.test(responseHeaders?.['content-type'] ?? '')) throw new NativeTransportError('Native HTTP2 endpoint returned an invalid content type');
    if(pending.length)throw new NativeTransportError('Truncated native HTTP2 response frame');
    if(transport==='connect'){
      if(!ended)throw new NativeTransportError('Connect response lacks terminal frame');
      return;
    }
    const status = trailers?.['grpc-status'] ?? responseHeaders?.['grpc-status'];
    if (typeof status !== 'string' || !/^\d+$/.test(status)) throw new NativeTransportError('Native gRPC response lacks terminal status');
    if (status !== '0') {
      const message=safeMessage(trailers?.['grpc-message']??responseHeaders?.['grpc-message'],headers,secrets);
      const details=trailers?.['grpc-status-details-bin']??responseHeaders?.['grpc-status-details-bin'];
      const size=typeof details==='string'?Buffer.byteLength(details):Buffer.isBuffer(details)?details.length:undefined;
      throw new NativeTransportError(`Native gRPC failed (status ${Number(status)})${message?`: ${message}`:''}${size!==undefined?` [status details: ${size} bytes]`:''}`, { code: `grpc_${Number(status)}` });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (timedOut) throw new NativeTransportError('Native gRPC request timed out', { code: 'deadline_exceeded' });
    if (error instanceof NativeTransportError) throw error;
    throw new NativeTransportError('Native gRPC connection failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    request?.destroy();
    session?.destroy();
  }
}
