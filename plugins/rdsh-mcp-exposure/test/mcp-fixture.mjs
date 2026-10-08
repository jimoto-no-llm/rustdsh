import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

export function tool(name, description = 'Read a fixed fixture value.') {
  return { name, description, inputSchema: { type: 'object', properties: { key: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
}

/** Actual MCP SDK and loopback HTTP; all capabilities are fixed test data. */
export async function mcpFixture({ tools = [tool('read')], blocked = false } = {}) {
  const sdk = new Server({ name: 'rdsh-fixed-mcp-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  const calls = [], handlers = [];
  let descriptors = tools, listing = 0, released = !blocked, release;
  const gate = new Promise(resolve => { release = () => { released = true; resolve(); }; });
  sdk.setRequestHandler('tools/list', async () => { listing++; if (!released) await gate; return { tools: descriptors }; });
  sdk.setRequestHandler('tools/call', async request => {
    calls.push({ name: request.params.name, arguments: request.params.arguments });
    const value = { value: `FIXTURE:${request.params.name}:${request.params.arguments?.key ?? ''}` };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  });
  await sdk.connect(transport);
  const server = http.createServer((req, res) => {
    const handling = transport.handleRequest(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(500); res.end(); throw error;
    });
    handling.catch(() => {}); handlers.push(handling);
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, sdk, calls, release,
    get listing() { return listing; },
    get released() { return released; },
    async replace(next) { descriptors = next; await sdk.sendToolListChanged(); },
    async close() {
      release();
      const errors = [];
      try { await sdk.close(); } catch (error) { errors.push(error); }
      for (const socket of sockets) socket.destroy();
      try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
      const settled = await Promise.allSettled(handlers);
      for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, 'MCP fixture cleanup failed');
    } };
}
