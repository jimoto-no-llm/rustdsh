import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {unaryConnect} from './protocol.mjs';
import {grpcStream} from './grpc.mjs';
import {pbFields,pbString,pbBytes,pbInt,decodeFields,pbText} from './protobuf.mjs';

const BASE='https://api2.cursor.sh';
export async function readCursorCredentials() {
  if(process.env.CURSOR_ACCESS_TOKEN)return {accessToken:process.env.CURSOR_ACCESS_TOKEN};
  if(process.platform==='darwin') {
    try {
      const token=execFileSync('/usr/bin/security',['find-generic-password','-s','cursor-access-token','-a','cursor-user','-w'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
      if(token)return {accessToken:token};
    }catch{}
  }
  try {
    const data=JSON.parse(await fs.readFile(path.join(os.homedir(),'.cursor/auth.json'),'utf8'));
    if(typeof data.accessToken==='string'&&data.accessToken)return {accessToken:data.accessToken};
  }catch{}
  throw new Error('Cursor native login unavailable; sign in with the installed Cursor client');
}
function toolArguments(value) {
  let args;
  try { args=typeof value==='string'?JSON.parse(value):value; } catch { throw new Error('Cursor returned invalid tool JSON'); }
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Cursor tool arguments must be an object');
  return typeof value==='string'?value:JSON.stringify(args);
}
function integerField(fields,number) {
  const value=fields.get(number)?.[0];
  if(value===undefined)return undefined;
  if(typeof value!=='bigint'||value>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Invalid Cursor tool integer metadata');
  return Number(value);
}
function replayCall(message,id) {
  const replay=message.providerMetadata?.cursor??message.source?.replayState?.response;
  return replay?.toolCalls?.find(call=>call.id===id)??{};
}
function encodeToolCall(call,metadata={}) {
  return pbFields(pbInt(1,19),pbString(3,call.id),pbString(9,call.name),pbString(10,toolArguments(call.arguments)),metadata.toolIndex!==undefined?pbInt(48,metadata.toolIndex):null,metadata.modelCallId?pbString(49,metadata.modelCallId):null);
}
export function cursorRequest(options) {
  if (typeof options.model !== 'string' || !options.model) throw new Error('Cursor model ID is required');
  const tools=options.tools??[];
  const names=new Set();
  const definitions=tools.map(tool=>{
    if(typeof tool.name!=='string'||!tool.name||names.has(tool.name))throw new Error('Invalid Cursor tool definition');
    names.add(tool.name);
    return pbBytes(34,pbFields(pbString(1,tool.name),pbString(2,tool.description??''),pbString(3,JSON.stringify(tool.parameters??{type:'object',properties:{}})),pbString(4,'rdsh')));
  });
  const system = options.system ? [options.system] : [];
  const conversation = [], pending=new Map();
  for (const message of options.messages ?? []) {
    if (!['system','developer','user','assistant','tool'].includes(message.role)) throw new Error('Unsupported Cursor history role');
    const blocks = typeof message.content === 'string' ? [{type:'text',text:message.content}] : message.content ?? [];
    if (blocks.some(block => !['text','tool-call'].includes(block.type))) throw new Error('Cursor native chat supports text and tool history only; images are unsupported');
    const text = blocks.filter(block=>block.type==='text').map(block => block.text).join('\n');
    if (message.role === 'system' || message.role === 'developer') { if(blocks.some(block=>block.type!=='text'))throw new Error('Invalid Cursor system history');system.push(text); continue; }
    if(message.role==='tool') {
      const id=message.toolCallId??message.source?.callId;
      const previous=pending.get(id);
      if(!previous)throw new Error('Cursor tool result has no matching assistant call');
      const {call,metadata,bubble}=previous;
      const mcpResult=pbFields(pbString(1,call.name),pbString(2,text));
      const result=pbFields(pbInt(1,19),pbBytes(28,mcpResult),pbString(35,id),metadata.modelCallId?pbString(48,metadata.modelCallId):null,metadata.toolIndex!==undefined?pbInt(49,metadata.toolIndex):null);
      bubble.results.push(pbBytes(18,pbFields(pbString(1,id),pbString(2,call.name),metadata.toolIndex!==undefined?pbInt(3,metadata.toolIndex):null,pbString(5,toolArguments(call.arguments)),pbString(7,text),pbBytes(8,result),pbBytes(11,encodeToolCall(call,metadata)),metadata.modelCallId?pbString(12,metadata.modelCallId):null)));
      pending.delete(id);
      continue;
    }
    const bubble={text,type:message.role==='assistant'?2:1,id:message.id??randomUUID(),results:[]};
    const calls=blocks.filter(block=>block.type==='tool-call');
    if(calls.length&&message.role!=='assistant')throw new Error('Cursor tool calls require assistant history');
    for(const call of calls){
      if(typeof call.id!=='string'||!call.id||typeof call.name!=='string'||!call.name||pending.has(call.id))throw new Error('Invalid Cursor assistant tool call');
      toolArguments(call.arguments);
      pending.set(call.id,{call,metadata:replayCall(message,call.id),bubble});
    }
    conversation.push(bubble);
  }
  if(pending.size)throw new Error('Cursor history contains unanswered tool calls');
  const messages=conversation.map(bubble=>pbBytes(1,pbFields(pbString(1,bubble.text),pbInt(2,bubble.type),pbString(13,bubble.id),...bubble.results)));
  const toolMode=tools.length>0;
  const inner = pbFields(...messages,pbBytes(3,pbString(1,system.join('\n'))),pbBytes(5,pbString(1,options.model)),pbInt(22,1),pbString(23,options.sessionId??randomUUID()),pbInt(27,toolMode?1:0),toolMode?pbInt(29,19):null,pbInt(33,1),...definitions,pbInt(46,1),pbInt(48,toolMode?0:1));
  return pbBytes(1,inner);
}
function decodeTool(fields,kind) {
  const tool=integerField(fields,1);
  if(tool!==19)throw new Error('Cursor requested an unsupported server tool');
  const call={id:pbText(fields,kind==='client'?3:2),name:pbText(fields,kind==='client'?9:8),arguments:pbText(fields,10)??'',toolIndex:integerField(fields,kind==='client'?48:50),modelCallId:pbText(fields,kind==='client'?49:51)};
  if(!call.id)throw new Error('Cursor returned a tool call without an ID');
  return call;
}
export function createCursorBackend({fetchImpl=fetch,credentials=readCursorCredentials,grpcImpl=(url,body,options)=>grpcStream(url,body,{...options,transport:'connect'})}={}) {
  async function headers() {
    const auth=await credentials();
    if(!auth?.accessToken)throw new Error('Cursor access token unavailable');
    return {authorization:`Bearer ${auth.accessToken}`,'x-ghost-mode':'true','x-cursor-client-type':'cli','x-cursor-client-version':'cli-2026.10.12-d47ca18','x-request-id':randomUUID()};
  }
  return {
    async discover({signal}={}) {
      const data=await unaryConnect(BASE+'/aiserver.v1.AiService/AvailableModels',{}, {headers:await headers(),signal,fetchImpl});
      if(Array.isArray(data.models))return data.models.filter(m=>m&&typeof(m.serverModelName??m.name)==='string').map(m=>({id:m.serverModelName??m.name,name:m.clientDisplayName??m.name??m.serverModelName,contextWindow:m.contextTokenLimit}));
      if(Array.isArray(data.modelNames))return data.modelNames.filter(x=>typeof x==='string').map(id=>({id,name:id}));
      throw new Error('Cursor returned an invalid model catalog');
    },
    async generate(options) {
      const body=cursorRequest(options);
      let text='';
      const calls=new Map(),allowed=new Set((options.tools??[]).map(tool=>tool.name));
      const accept=(fields,kind)=>{
        const call=decodeTool(fields,kind),previous=calls.get(call.id);
        if(call.name&&!allowed.has(call.name))throw new Error('Cursor returned an unknown tool name');
        if(previous?.name&&call.name&&previous.name!==call.name)throw new Error('Cursor changed a tool-call name');
        if(previous?.toolIndex!==undefined&&call.toolIndex!==undefined&&previous.toolIndex!==call.toolIndex)throw new Error('Cursor changed tool-call index');
        if(previous?.modelCallId&&call.modelCallId&&previous.modelCallId!==call.modelCallId)throw new Error('Cursor changed model-call ID');
        if(previous?.authoritative&&kind==='client'&&previous.arguments!==call.arguments)throw new Error('Cursor returned conflicting final tool calls');
        calls.set(call.id,{...previous,...call,name:call.name||previous?.name,arguments:previous?.authoritative&&kind==='streamed'?previous.arguments:call.arguments,authoritative:kind==='client'||previous?.authoritative,toolIndex:call.toolIndex??previous?.toolIndex,modelCallId:call.modelCallId??previous?.modelCallId});
      };
      for await(const frame of grpcImpl(BASE+'/aiserver.v1.ChatService/StreamUnifiedChatWithTools',body,{headers:await headers(),signal:options.signal})) {
        const outer=decodeFields(frame);
        for(const value of outer.get(1)??[]){if(!Buffer.isBuffer(value))throw new Error('Invalid Cursor client tool response');accept(decodeFields(value),'client');}
        for(const value of outer.get(2)??[]) {
          if(!Buffer.isBuffer(value))throw new Error('Invalid Cursor response envelope');
          const inner=decodeFields(value);
          const delta=pbText(inner,1);
          if(delta!==undefined)text+=delta;
          for(const value of inner.get(36)??[]){if(!Buffer.isBuffer(value))throw new Error('Invalid Cursor streamed tool response');accept(decodeFields(value),'streamed');}
        }
      }
      for(const call of calls.values()){if(!allowed.has(call.name))throw new Error('Cursor returned an incomplete tool call');toolArguments(call.arguments);}
      if(!text.trim()&&!calls.size)throw new Error('Cursor returned no model text or tool calls');
      const toolCalls=[...calls.values()].map(({id,name,arguments:args})=>({id,name,arguments:args}));
      return {text,toolCalls,...(calls.size?{replayState:{toolCalls:[...calls.values()].map(({authoritative,...call})=>call)}}:{})};
    },
  };
}
