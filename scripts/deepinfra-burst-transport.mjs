// Bounded HTTP/1.1 transport. No implicit retry, redirect or model fallback.
import https from 'node:https';

export function createBurstTransport({ concurrency = 200, connectMs = 30_000,
  requestMs = 120_000, maxBodyBytes = 256 * 1024, preparedSockets = null } = {}) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency,
    maxTotalSockets: concurrency, maxFreeSockets: concurrency });
  const prepared = new Set(preparedSockets ?? []);
  const available = [...prepared];
  if (preparedSockets) agent.createConnection = () => {
    const socket = available.shift();
    if (!socket || socket.destroyed) throw Object.assign(new Error('Prepared connection unavailable'),
      { code: 'PREPARED_CONNECTION_CLOSED' });
    return socket;
  };
  return {
    close() { agent.destroy(); for (const socket of prepared) socket.destroy(); },
    post({ key, body }) {
      return new Promise((resolve) => {
        const trace = { started: Date.now(), phase: 'connecting', mayHaveSent: false,
          connected: null, sent: null, headersAt: null, status: null, requestId: null };
        let finished = false;
        let req;
        let connectTimer;
        let requestTimer;
        const finish = (extra) => {
          if (finished) return;
          finished = true;
          clearTimeout(connectTimer);
          clearTimeout(requestTimer);
          resolve({ ...trace, ended: Date.now(), ...extra });
        };
        const fail = (code) => {
          finish({ error: String(code || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) });
          req?.destroy();
        };
        connectTimer = setTimeout(() => fail('CONNECT_TIMEOUT'), connectMs);
        requestTimer = setTimeout(() => fail('REQUEST_TIMEOUT'), requestMs);
        try {
          req = https.request('https://api.deepinfra.com/v1/openai/chat/completions', {
            method: 'POST', agent,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json',
              'content-length': Buffer.byteLength(body) },
          }, (response) => {
            trace.phase = 'response_body';
            trace.status = response.statusCode;
            trace.headersAt = Date.now();
            const requestId = response.headers['x-request-id'];
            if (typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(requestId))
              trace.requestId = requestId;
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
              if (finished) return;
              size += chunk.length;
              if (size > maxBodyBytes) { fail('RESPONSE_TOO_LARGE'); return; }
              chunks.push(chunk);
            });
            response.on('aborted', () => fail('RESPONSE_ABORTED'));
            response.on('error', (error) => fail(error.code));
            response.on('end', () => {
              if (finished) return;
              if (!response.complete) { fail('RESPONSE_INCOMPLETE'); return; }
              let result = null;
              try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* classified below */ }
              trace.phase = 'complete';
              finish({ result });
            });
          });
          req.on('error', (error) => fail(error.code));
          req.on('socket', (socket) => {
            // Do not send HTTP headers/body until TLS succeeds. This makes failures
            // before end(body) distinguishable from uncertain remote execution.
            const send = () => {
              if (finished) return;
              clearTimeout(connectTimer);
              trace.connected = Date.now();
              trace.phase = 'awaiting_headers';
              trace.mayHaveSent = true;
              trace.sent = Date.now();
              req.end(body);
            };
            if (req.reusedSocket || prepared.has(socket)) send();
            else socket.once('secureConnect', send);
          });
        } catch (error) { fail(error.code || 'CLIENT_SETUP_ERROR'); }
      });
    },
  };
}

export function classifyResponse(response, model, provider = 'deepinfra') {
  const { result, ...trace } = response;
  const record = { ...trace, outcome: 'transportUnknown' };
  const cost = provider === 'openrouter' ? result?.usage?.cost : result?.usage?.estimated_cost;
  // A received rejection status remains useful even if the error body is cut off.
  if (response.status === 429) record.outcome = 'rateLimited';
  else if (response.status >= 500) record.outcome = 'serverUnknown';
  else if (response.status >= 300) record.outcome = 'httpError';
  else if (response.error) record.outcome = response.mayHaveSent ? 'transportUnknown' : 'notSent';
  else if (response.status !== 200 || !result || typeof result !== 'object') record.outcome = 'serverUnknown';
  else if (!(Array.isArray(model) ? model.includes(result.model) : result.model === model)) record.outcome = 'modelMismatch';
  else if (!Number.isFinite(cost) || cost < 0)
    record.outcome = 'missingCost';
  else {
    record.outcome = 'http200';
    record.costUsd = cost;
    record.usable = typeof result.choices?.[0]?.message?.content === 'string' &&
      result.choices[0].message.content.trim().length > 0;
  }
  for (const [name, value] of Object.entries({ generationId: result?.id, actualModel: result?.model,
    routedProvider: result?.provider, apiErrorCode: result?.error?.code,
    limitSource: result?.error?.metadata?.limit_source })) {
    if ((typeof value === 'string' || typeof value === 'number') &&
        /^[A-Za-z0-9_ .:/-]{1,200}$/.test(String(value))) record[name] = value;
  }
  // Keep accounting metadata even if model validation failed; never save content.
  for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(result?.usage?.[name]) && result.usage[name] >= 0)
      (record.tokens ??= {})[name] = result.usage[name];
  }
  return record;
}
