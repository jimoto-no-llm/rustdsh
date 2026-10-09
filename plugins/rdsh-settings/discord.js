import net from 'node:net';
import { homedir, tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

export const defaultDiscordApplicationId = '1557873849280888903';
export const defaultDiscordImage = 'https://cdn.discordapp.com/app-icons/1557873849280888903/3abd404070c831dcaa59310cc29982df.png?size=256';

// Public application metadata only. Updating its App Icon needs no client-side ID edit.
export function createApplicationImageResolver({ fetchImpl = fetch, refreshMs = 60000, now = Date.now } = {}) {
  let image = defaultDiscordImage, until = 0;
  return async () => {
    if (now() < until) return image;
    until = now() + refreshMs;
    try {
      const response = await fetchImpl(`https://discord.com/api/v10/oauth2/applications/${defaultDiscordApplicationId}/rpc`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const application = await response.json();
        if (/^[a-f0-9]{32}$/.test(application.icon)) image = `https://cdn.discordapp.com/app-icons/${defaultDiscordApplicationId}/${application.icon}.png?size=256`;
      }
    } catch { /* Offline metadata must never disable local Discord presence. */ }
    return image;
  };
}

export const discordDefaults = {
  enabled: true, application_id: defaultDiscordApplicationId, details: 'dshで作業中',
  show_agent_status: true, show_elapsed: true, show_image: true,
  status_display: 'details', large_image: '', large_text: '', button_label: '', button_url: '',
};
export function normalizeDiscord(value = {}) {
  const string = (key, max, fallback = '') => typeof value?.[key] === 'string'
    ? Array.from(value[key]).slice(0, max).join('') : fallback;
  const bool = (key) => typeof value?.[key] === 'boolean' ? value[key] : discordDefaults[key];
  const details = string('details', 128);
  return {
    enabled: bool('enabled'), application_id: string('application_id', 20).trim() || defaultDiscordApplicationId,
    details: details.trim() ? details : discordDefaults.details,
    show_agent_status: bool('show_agent_status'), show_elapsed: bool('show_elapsed'), show_image: bool('show_image'),
    status_display: ['name', 'state', 'details'].includes(value?.status_display) ? value.status_display : 'details',
    large_image: string('large_image', 512).trim(), large_text: string('large_text', 128),
    button_label: string('button_label', 32).trim(), button_url: string('button_url', 512).trim(),
  };
}

export function ipcPaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);
  const roots = [...new Set([
    env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, tmpdir(),
    typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null,
  ].filter(Boolean))];
  return roots.flatMap(root => ['', 'app/com.discordapp.Discord', 'snap.discord']
    .flatMap(sub => Array.from({ length: 10 }, (_, i) => join(root, sub, `discord-ipc-${i}`))));
}

export function isWsl(platform = process.platform, env = process.env, kernelRelease = release()) {
  return platform === 'linux' && (!!env.WSL_DISTRO_NAME || /microsoft/i.test(kernelRelease));
}

export function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

// Keep the IPC decoder and ACK handling identical across native and WSL paths.
export async function windowsBridgeSocket({ script, spawnImpl = spawn } = {}) {
  script ??= await readFile(new URL('./discord-wsl.ps1', import.meta.url), 'utf8');
  // WSL system services often omit Windows executables from PATH.
  const systemPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const executable = isWsl() && existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe';
  const child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { child.stdin.write(chunk, callback); },
    destroy(error, callback) { child.stdin.destroy(); child.stdout.destroy(); child.kill(); callback(error); },
  });
  child.stdout.on('data', chunk => socket.push(chunk));
  child.stdout.on('end', () => socket.destroy());
  child.stdin.on('error', error => socket.destroy(error));
  child.on('error', error => socket.destroy(error));
  child.on('exit', () => socket.destroy());
  // Discord on Windows needs a Windows process id, not the Linux WSL pid.
  await new Promise((resolve, reject) => {
    let metadata = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Windows Discord bridge timed out')); }, 5000);
    const fail = error => { clearTimeout(timer); reject(error); };
    socket.once('error', fail);
    socket.once('close', () => fail(new Error('Windows Discord bridge unavailable')));
    child.stderr.on('data', chunk => {
      metadata = (metadata + chunk.toString()).slice(0, 128);
      const match = metadata.match(/RDSH_DISCORD_PID=([1-9][0-9]*)/);
      if (!match) return;
      socket.activityPid = Number(match[1]); clearTimeout(timer); resolve();
    });
  });
  return socket;
}

// Local IPC only: no bot token, OAuth token, or remote RPC server.
export class DiscordIpc {
  constructor(socket, timeout = 5000) {
    this.socket = socket; this.timeout = timeout; this.buffer = Buffer.alloc(0);
    this.pending = new Map(); this.closed = false;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // A socket can fail before the caller awaits READY.
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail(new Error('Discord handshake timed out')), timeout);
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Discord disconnected')));
  }
  static async connect(applicationId, { paths = ipcPaths(), timeout = 5000, wsl = isWsl(), bridge = windowsBridgeSocket } = {}) {
    for (const path of paths) {
      let socket;
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(path);
          const timer = setTimeout(() => { candidate.destroy(); reject(new Error('IPC connect timed out')); }, 300);
          candidate.once('error', error => { clearTimeout(timer); reject(error); });
          candidate.once('connect', () => { clearTimeout(timer); resolve(candidate); });
        });
      } catch { continue; }
      const rpc = new DiscordIpc(socket, timeout);
      socket.write(frame(0, { v: 1, client_id: applicationId }));
      try { await rpc.ready; return rpc; }
      catch (error) { rpc.destroy(); throw error; }
    }
    if (wsl) {
      const rpc = new DiscordIpc(await bridge(), timeout);
      rpc.socket.write(frame(0, { v: 1, client_id: applicationId }));
      try { await rpc.ready; return rpc; }
      catch (error) { rpc.destroy(); throw error; }
    }
    throw new Error('Discord desktop IPC is unavailable');
  }
  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 8) {
        const opcode = this.buffer.readUInt32LE(0), size = this.buffer.readUInt32LE(4);
        if (size > 65536) throw new Error('Oversized Discord IPC frame');
        if (this.buffer.length < size + 8) return;
        const payload = this.buffer.subarray(8, size + 8);
        this.buffer = this.buffer.subarray(size + 8);
        if (opcode === 3) { this.socket.write(frame(4, payload)); continue; }
        if (opcode === 4) continue;
        if (opcode === 2) throw new Error('Discord closed RPC');
        if (opcode !== 1) throw new Error('Unexpected Discord IPC opcode');
        const data = JSON.parse(payload.toString('utf8'));
        if (data.evt === 'READY') { clearTimeout(this.readyTimer); this.readyResolve(); }
        const request = this.pending.get(data.nonce);
        if (data.evt === 'ERROR') {
          // Reconnect instead of leaving a rejected activity marked as published.
          throw new Error('Discord rejected RPC activity or Application ID');
        }
        if (request) {
          this.pending.delete(data.nonce); clearTimeout(request.timer); request.resolve(data);
        }
      }
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.readyTimer); this.readyReject(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.socket.destroy();
  }
  setActivity(activity) {
    if (this.closed) return Promise.reject(new Error('Discord disconnected'));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Discord activity acknowledgement timed out')), this.timeout);
      this.pending.set(nonce, { resolve, reject, timer });
      this.socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: this.socket.activityPid || process.pid, activity }, nonce }));
    });
  }
  destroy() { this.fail(new Error('Discord RPC stopped')); }
}

function rpcText(text) {
  // Stay within the wire limit without splitting a UTF-8 character.
  let result = '';
  for (const char of text) { if (Buffer.byteLength(result + char) > 128) break; result += char; }
  return result;
}
export function activityFor(settings, running, started, commonImage = defaultDiscordImage) {
  // The installed Discord RPC uses the Developer Portal application name.
  const activity = { type: 0, details: rpcText(settings.details), instance: false,
    status_display_type: settings.status_display === 'name' ? 0 : settings.status_display === 'state' && settings.show_agent_status ? 1 : 2 };
  if (settings.show_agent_status) activity.state = running > 0 ? `agent稼働中 (${running})` : '待機中';
  if (settings.show_elapsed) activity.timestamps = { start: started };
  const image = settings.large_image || (settings.application_id === defaultDiscordApplicationId ? commonImage : '');
  if (settings.show_image && image && (/^[a-z0-9_-]+$/.test(image) || isPublicUrl(image))) {
    activity.assets = { large_image: image, large_text: rpcText(settings.large_text || 'dsh') };
  }
  if (settings.button_label && isPublicUrl(settings.button_url)) {
    activity.buttons = [{ label: settings.button_label, url: settings.button_url }];
  }
  return activity;
}

function isPublicUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

export function createDiscordPresence({ loadSettings, connect = id => DiscordIpc.connect(id), interval = 5000, throttle = 1000, minUpdateInterval = 5000, imageResolver = async () => defaultDiscordImage }) {
  let settings = { ...discordDefaults }, rpc, applicationId, lastActivity, stopped = false;
  let publishedActivity = null, updatedAt = null, lastSent = 0;
  let commonImage = defaultDiscordImage;
  let state = 'disabled', agents = new Map(), timer, scheduled, busy, dirty = false;
  const started = Math.floor(Date.now() / 1000);
  const status = () => ({ state: state === 'connected' && rpc?.closed ? 'disconnected' : state,
    running_agents: [...agents.values()].filter(s => s === 'running').length, started_at: started,
    updated_at: updatedAt, default_image: commonImage, published_activity: rpc?.closed ? null : publishedActivity });
  async function disconnect(clear = true) {
    const previous = rpc; rpc = undefined; applicationId = undefined; lastActivity = undefined;
    publishedActivity = null; updatedAt = null;
    if (!previous) return;
    if (clear && !previous.closed) {
      let deadline;
      await Promise.race([
        previous.setActivity(null).catch(() => {}),
        new Promise(resolve => { deadline = setTimeout(resolve, 500); }),
      ]).finally(() => clearTimeout(deadline));
    }
    previous.destroy();
  }
  async function update() {
    try { settings = normalizeDiscord((await loadSettings()).discord); }
    catch { state = 'invalid_settings'; await disconnect(); return; }
    if (stopped) return;
    if (!settings.enabled || !/^[1-9][0-9]{16,19}$/.test(settings.application_id)) {
      state = settings.enabled ? 'needs_application_id' : 'disabled'; await disconnect(); return;
    }
    if (rpc && (rpc.closed || applicationId !== settings.application_id)) await disconnect();
    try {
      if (!rpc) {
        state = 'connecting';
        rpc = await connect(settings.application_id); applicationId = settings.application_id;
        if (stopped) { await disconnect(); return; }
      }
      if (settings.show_image && !settings.large_image && settings.application_id === defaultDiscordApplicationId) commonImage = await imageResolver();
      if (stopped) { await disconnect(); return; }
      const activity = activityFor(settings, status().running_agents, started, commonImage);
      const serialized = JSON.stringify(activity);
      if (serialized !== lastActivity) {
        const remaining = minUpdateInterval - (Date.now() - lastSent);
        if (remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, remaining));
          if (!stopped) await update(); // Re-read settings and coalesce the newest agent state.
          return;
        }
        lastSent = Date.now();
        await rpc.setActivity(activity); lastActivity = serialized;
        publishedActivity = activity; updatedAt = Date.now();
      }
      state = 'connected';
    } catch { state = 'disconnected'; await disconnect(false); }
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    if (busy) { dirty = true; return busy; }
    busy = (async () => {
      do { dirty = false; await update(); } while (dirty && !stopped);
    })().finally(() => { busy = undefined; });
    return busy;
  }
  function changed() {
    if (stopped || scheduled) return;
    scheduled = setTimeout(() => { scheduled = undefined; void refresh(); }, throttle);
    scheduled.unref?.();
  }
  timer = setInterval(() => { void refresh(); }, interval); timer.unref?.();
  return {
    status, refresh,
    observe(agent, value = agent.status) { agents.set(agent, value); changed(); },
    forget(agent) { agents.delete(agent); changed(); },
    async stop() {
      stopped = true; clearInterval(timer); clearTimeout(scheduled);
      await busy; await disconnect(); agents.clear();
    },
  };
}

export function installDiscordPresence(ctx, options = {}) {
  const presence = createDiscordPresence({ loadSettings: async () => {
    try {
      const document = JSON.parse(await readFile(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json'), 'utf8'));
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid settings');
      return document;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }, imageResolver: createApplicationImageResolver(), ...options });
  // Keep object identities: separate agents can reuse a durable session id.
  const listeners = [
    ctx.on('agent/created', ({ agent }) => { presence.observe(agent); }),
    ctx.on('agent/status', ({ agent, status }) => { presence.observe(agent, status); }),
    ctx.on('agent/disposed', ({ agent }) => { presence.forget(agent); }),
  ];
  for (const agent of ctx.get?.('agents')?.list() ?? []) presence.observe(agent);
  void presence.refresh();
  return { ...presence, async stop() { for (const off of listeners) off(); await presence.stop(); } };
}
