import { createRequire } from 'node:module';
import z from '@deepseek-ai/schemastery';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools';
import { compileConfig, EXPOSURES, ExposureError } from './policy.js';
import { Discovery, digest } from './discovery.js';
import { discoveryTools } from './tools.js';

export const name = 'rdsh-mcp-exposure';
export const inject = ['tools', 'systemPrompt', 'sessions'];
const mode = z.union(EXPOSURES);
export const Config = z.object({
  servers: z.array(z.object({ connection: McpClient.Config, exposure: mode.default('deferred'),
    toolExposure: z.array(z.object({ match: z.string().required(), exposure: mode.required() })).default([]),
    source: z.string() })).required(),
  maxSearchResults: z.number().default(20),
  maxLoadedTools: z.number().default(512),
});
const require = createRequire(import.meta.url);

/** Compose the original MCP plugin without a second connection or agent loop. */
export async function apply(ctx, input = {}) {
  const config = compileConfig(input);
  if (globalThis[Symbol.for('rdsh.tool-boundary.install')])
    throw new ExposureError('RDSH_MCP_GUARDED_NATIVE', 'The guarded rdsh launcher reserves its audited Native tool set; this bundle requires an existing authorized original DSH composition');
  for (const pkg of ['dsh-tools', 'dsh-mcp-client', 'dsh-session', 'dsh-system-prompt'])
    if (require(`@deepseek-ai/${pkg}/package.json`).version !== '0.2.0-rc.2')
      throw new ExposureError('RDSH_MCP_VERSION', 'rdsh-mcp-exposure supports DSH 0.2.0-rc.2');
  if (config.servers.some(server => server.needsPtc)) {
    if (!ctx.get('ptcRuntime')) throw new ExposureError('RDSH_MCP_PTC_RUNTIME', 'PTC-only exposure requires an existing original DSH PTC runtime');
  }
  // Apply the original schema/defaults before registering effects or connecting.
  const connections = input.servers.map(server => McpClient.Config(server.connection));
  const discovery = new Discovery(ctx.tools, config, { typescript: renderToolsSdk, python: renderToolsSdkPy });
  const definitions = discoveryTools(discovery);
  discovery.bindHelpers(definitions);
  const disposers = [];
  const dispose = () => { discovery.dispose(); for (const fn of disposers.splice(0).reverse()) fn(); };
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register(definition));
    disposers.push(ctx.tools.guard(exec => discovery.guard(exec)));
    disposers.push(ctx.on('tools/result', (exec, result) => { discovery.settle(exec, result); }));
    disposers.push(ctx.systemPrompt.section({ name: 'rdsh:mcp-exposure', order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false, text: `MCP discovery uses rdsh_mcp_search and rdsh_mcp_load. Direct tools are declared normally. Deferred tools must be loaded before a direct call; loaded declarations belong to the current session branch. PTC-only tools require the existing run_code runtime and cannot be called directly. Loading metadata never grants permission. Servers: ${config.servers.filter(server => server.mayConnect).map(server => `${server.serverName} (${server.fallback})`).join(', ')}.` }));
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) =>
      discovery.present(await next(), context, ctx.get('ptcRuntime')?.language)));
    const direct = [];
    config.servers.forEach((server, index) => {
      if (!server.mayConnect) return;
      const connection = connections[index];
      // Context.extend is Cordis's public, local metadata overlay. Only register
      // is adapted: all definitions, execution callbacks, transport supervision,
      // resource providers, instructions, and teardown are original MCP code.
      const adapted = ctx.extend({ tools: discovery.bridge(server, digest({ server: server.serverName,
        transport: connection.transport, url: connection.url ?? null, command: connection.command ?? null,
        args: connection.args ?? [], cwd: connection.cwd ?? '' })) });
      const startup = McpClient.apply(adapted, connection);
      discovery.setReady(server.serverName, startup);
      if (server.hasDirect) direct.push(startup);
    });
    disposers.push(ctx.effect(() => dispose));
    // A non-direct server remains original-supervised background startup work.
    // Search/load wait for its initial discovery, while the first prompt does not.
    await Promise.all(direct);
  } catch (error) { dispose(); throw error; }
}
