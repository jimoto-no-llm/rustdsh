import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const messages = {
  en: {
    guardedNative: 'The guarded rdsh launcher reserves its audited Native tool set; this bundle requires an existing authorized original DSH composition',
    version: 'rdsh-mcp-exposure requires matching DSH 0.2.0-rc.2 or 0.2.1-alpha.3 packages',
    ptcRuntime: 'PTC-only exposure requires an existing original DSH PTC runtime',
    object: '{label} must be an object',
    field: '{label} contains an unsupported field',
    exposure: '{label} must be direct, deferred, ptc-only, or hidden',
    serverName: 'connection.serverName is invalid',
    source: 'source must be a short single-line configuration label',
    rules: 'toolExposure must contain at most 256 ordered rules',
    namespace: 'toolExposure must name this server using the original DSH public namespace',
    exact: 'exact toolExposure names must be unique valid public names',
    foreignName: 'The MCP client supplied a name outside its reserved namespace',
    servers: 'servers must contain between 1 and 64 connections',
    range: '{label} is outside its supported range',
    duplicateServer: 'Each serverName must be unique in this bundle',
    liveName: 'A live MCP generation already owns this tool name',
    search: 'MCP search arguments are outside their supported range',
    load: 'MCP load requires up to 64 unique public names',
  },
  ja: {
    guardedNative: '保護されたrdshランチャーは監査済みのNativeツール群を専用に使用します。このバンドルには、許可された既存のオリジナルDSH構成が必要です',
    version: 'rdsh-mcp-exposureには、版を揃えたDSH 0.2.0-rc.2または0.2.1-alpha.3が必要です',
    ptcRuntime: 'PTC専用の公開には、既存のオリジナルDSH PTCランタイムが必要です',
    object: '{label}はオブジェクトにしてください',
    field: '{label}に未対応のフィールドがあります',
    exposure: '{label}はdirect・deferred・ptc-only・hiddenのいずれかにしてください',
    serverName: 'connection.serverNameが無効です',
    source: 'sourceは短い1行の設定ラベルにしてください',
    rules: 'toolExposureの順序付きルールは256件以下にしてください',
    namespace: 'toolExposureではオリジナルDSHの公開名前空間でこのサーバーを指定してください',
    exact: '完全一致のtoolExposure名は、重複のない有効な公開名にしてください',
    foreignName: 'MCPクライアントが予約された名前空間の外にある名前を返しました',
    servers: 'serversの接続数は1件以上64件以下にしてください',
    range: '{label}が対応範囲外です',
    duplicateServer: 'このバンドル内でserverNameを重複させないでください',
    liveName: 'このツール名は現在のMCP登録で既に使用されています',
    search: 'MCP検索の引数が対応範囲外です',
    load: 'MCP読み込みには、重複のない公開名を64件以下で指定してください',
  },
  'zh-CN': {
    guardedNative: '受保护的rdsh启动器专用经过审核的Native工具集；此包需要已有且获得授权的原版DSH配置',
    version: 'rdsh-mcp-exposure需要版本一致的DSH 0.2.0-rc.2或0.2.1-alpha.3',
    ptcRuntime: '仅PTC公开需要已有的原版DSH PTC运行时',
    object: '{label}必须是对象',
    field: '{label}包含不支持的字段',
    exposure: '{label}必须是direct、deferred、ptc-only或hidden之一',
    serverName: 'connection.serverName无效',
    source: 'source必须是简短的单行配置标签',
    rules: 'toolExposure最多可包含256条有序规则',
    namespace: 'toolExposure必须使用原版DSH的公共命名空间指定此服务器',
    exact: '精确toolExposure名称必须是有效且不重复的公共名称',
    foreignName: 'MCP客户端返回了其保留命名空间以外的名称',
    servers: 'servers必须包含1到64个连接',
    range: '{label}超出了支持范围',
    duplicateServer: '此包内的serverName必须唯一',
    liveName: '当前MCP实例已占用此工具名称',
    search: 'MCP搜索参数超出了支持范围',
    load: 'MCP加载需要最多64个不重复的公共名称',
  },
};

export function diagnosticLocale() {
  let saved;
  try { saved = JSON.parse(readFileSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json'), 'utf8')).general?.language; }
  catch { /* Settings may not exist before the first application launch. */ }
  if (typeof saved === 'string' && Object.hasOwn(messages, saved)) return saved;
  const system = [process.env.RDSH_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]
    .find(value => value?.trim()) || Intl.DateTimeFormat().resolvedOptions().locale;
  return system.toLowerCase().startsWith('ja') ? 'ja' : system.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** Translate only owned diagnostics; configuration keys, IDs and upstream errors stay unchanged. */
export function diagnostic(key, values = {}) {
  return messages[diagnosticLocale()][key].replace(/\{(\w+)\}/g, (_match, name) => values[name]);
}
