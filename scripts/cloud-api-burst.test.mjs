import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http2 from 'node:http2';
import test from 'node:test';
import { prepareOpenRouter } from './cloud-api-burst-transport.mjs';
import { classifyResponse } from './deepinfra-burst-transport.mjs';

test('HTTP2 multiplexes 200 real loopback requests on two connections', async (t) => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  let connections = 0;
  const server = http2.createServer({ settings: { maxConcurrentStreams: 100 } });
  server.on('session', () => connections++);
  server.on('stream', (stream) => {
    calls++; active++; peak = Math.max(peak, active);
    stream.resume();
    setTimeout(() => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ model: 'test/model', usage: { cost: 0.000001 },
        choices: [{ message: { content: '1' } }] }));
      active--;
    }, 100);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const original = http2.connect;
  http2.connect = () => original(`http://127.0.0.1:${server.address().port}`);
  let transport;
  t.after(async () => {
    transport?.close(); http2.connect = original;
    await new Promise((resolve) => server.close(resolve));
  });
  transport = await prepareOpenRouter(200);
  assert.equal(calls, 0, 'prepare must never send a model request');
  const responses = await Promise.all(Array.from({ length: 200 }, () => transport.post({ key: 'dummy', body: '{}' })));
  assert.equal(calls, 200);
  assert.equal(peak, 200);
  assert.equal(connections, 2);
  assert.ok(responses.every((r) => classifyResponse(r, 'test/model', 'openrouter').outcome === 'http200'));
});

test('OpenRouter launches exactly 12000 synchronized requests with native fallback and raised price bounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rdsh-mixed-burst-'));
  try {
    const diKey = join(dir, 'di.env');
    const orKey = join(dir, 'or.env');
    const mock = join(dir, 'mock.mjs');
    const out = join(dir, 'result.json');
    writeFileSync(diKey, 'DEEPINFRA_API_KEY=dummy-deepinfra');
    writeFileSync(orKey, 'OpenRouter: sk-or-v1-dummy-openrouter');
    writeFileSync(mock, `
      import { EventEmitter } from 'node:events';
      import tls from 'node:tls';
      import https from 'node:https';
      import http2 from 'node:http2';
      const models = Array.from({length:50}, (_,i) => ({ id:'test/model-'+i,
        architecture:{output_modalities:['text']}, supported_parameters:['max_tokens'],
        pricing:{prompt:'0.00000002',completion:'0.00000004'},
        metadata:{tags:['chat'],pricing:{input_tokens:0.02,output_tokens:0.04}} }));
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        const data = path.endsWith('/models') ? {data:models} : path.endsWith('/key') ?
          {data:{limit_remaining:1}} : path.endsWith('/credits') ? {data:{total_credits:10,total_usage:1}} :
          path.endsWith('/rate_limit') ? {rate_limit:200,tpm_rate_limit:1100000} : null;
        if (!data) throw new Error('Unexpected network operation');
        return new Response(JSON.stringify(data));
      };
      tls.connect = () => {
        const socket = new EventEmitter(); socket.destroyed=false;
        socket.destroy = () => {socket.destroyed=true}; socket.setKeepAlive=()=>{};
        queueMicrotask(()=>socket.emit('secureConnect')); return socket;
      };
      const result = body => JSON.stringify({model:JSON.parse(body).models?.[1] ?? JSON.parse(body).model,
        choices:[{message:{content:'1'}}],usage:{estimated_cost:0.0000001,cost:0.0000001}});
      https.request = (url, options, callback) => {
        const req = new EventEmitter(); req.destroy=()=>{};
        req.end = body => setTimeout(()=>{
          const response = new EventEmitter(); response.statusCode=200; response.headers={}; response.complete=true;
          callback(response);response.emit('data',Buffer.from(result(body)));response.emit('end');
        },5000);
        queueMicrotask(()=>req.emit('socket',options.agent.createConnection())); return req;
      };
      http2.connect = () => {
        const session = new EventEmitter(); session.closed=false;session.destroyed=false;
        session.destroy=()=>{session.closed=true;session.destroyed=true};
        session.request=()=>{
          const stream=new EventEmitter();stream.close=()=>{};
          stream.end=body=>setTimeout(()=>{
            stream.emit('response',{':status':200});stream.emit('data',Buffer.from(result(body)));stream.emit('end');
          },5000); return stream;
        };
        queueMicrotask(()=>session.emit('remoteSettings',{maxConcurrentStreams:100})); return session;
      };
    `);
    const script = join(dirname(fileURLToPath(import.meta.url)), 'cloud-api-burst.mjs');
    const run = spawnSync(process.execPath, [script, '--deepinfra-key-file', diKey,
      '--openrouter-key-file', orKey, '--out', out, '--run', 'true',
      '--deepinfra-models', '0', '--per-model', '300', '--budget-usd', '0.50',
      '--max-input-price', '1', '--max-output-price', '3'],
    { encoding: 'utf8', timeout: 45_000,
      env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(mock).href } });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stderr);
    const evidence = JSON.parse(readFileSync(out));
    assert.equal(evidence.maximumRequests, 12000);
    assert.equal(evidence.recordedStarts, 12000);
    assert.equal(evidence.http200, 12000);
    assert.equal(evidence.peakSentInFlight, 12000);
    assert.equal(evidence.peakSuccessfulRequestsInFlight, 12000);
    assert.equal(evidence.targetReachedBySuccessfulRequestOverlap, true);
    assert.equal(evidence.preparedConnections, 120);
    assert.equal(evidence.serverSideConcurrencyMeasured, false);
    assert.equal(Object.keys(evidence.byModel).length, 40);
    assert.ok(Math.abs(evidence.reservedTotalUsd - 0.462) < 1e-8);
    assert.ok(evidence.plans.every((plan) => plan.body.models.length === 3));
  } finally {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.journal')) {
        for (const file of readdirSync(path)) unlinkSync(join(path, file));
        rmdirSync(path);
      } else unlinkSync(path);
    }
    rmdirSync(dir);
  }
});
