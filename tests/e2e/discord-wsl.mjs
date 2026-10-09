// Isolated Windows named pipe fixture: never connects to a user's Discord.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { windowsBridgeSocket, DiscordIpc } from '../../plugins/rdsh-settings/discord.js';
const prefix = `rdsh-discord-qa-${randomBytes(8).toString('hex')}`;
const script = await readFile(new URL('fixtures/discord-pipe.ps1', import.meta.url), 'utf8');
const encoded = Buffer.from(`& {\n${script}\n} -PipeName '${prefix}-0'`, 'utf16le').toString('base64');
const systemPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const server = spawn(existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', errors = '', rpc;
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { errors += chunk; });
const timeout = setTimeout(() => { server.kill(); throw new Error(`Windows IPC fixture timed out: ${errors}`); }, 20000);
try {
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (output.includes('READY')) { clearInterval(poll); resolve(); } }, 20);
    server.once('error', error => { clearInterval(poll); reject(error); });
    server.once('exit', () => { clearInterval(poll); reject(new Error(errors || 'fixture exited')); });
  });
  const bridgeScript = (await readFile(new URL('../../plugins/rdsh-settings/discord-wsl.ps1', import.meta.url), 'utf8')).replace('discord-ipc-$index', `${prefix}-$index`);
  rpc = await DiscordIpc.connect('123456789012345678', { paths: [], wsl: true, bridge: async () => {
    const socket = await windowsBridgeSocket({ script: bridgeScript });
    // Exercise fragmentation at the WSL stdio boundary as well as RPC decoding.
    const write = socket.write.bind(socket);
    socket.write = packet => { write(packet.subarray(0, 3)); setTimeout(() => write(packet.subarray(3)), 10); return true; };
    return socket;
  } });
  await rpc.setActivity({ details: 'dshで作業中', state: 'agent稼働中 (2)' });
  await rpc.setActivity(null);
  await new Promise(resolve => setTimeout(resolve, 100));
  const commands = output.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].args.activity, { details: 'dshで作業中', state: 'agent稼働中 (2)' });
  assert.equal(commands[0].args.pid, rpc.socket.activityPid);
  assert.ok(Number.isSafeInteger(rpc.socket.activityPid));
  assert.equal(commands[1].args.activity, null);
  console.log('PASS: WSL -> Windows named pipe handshake, Japanese activity, Windows PID, ACK and clear');
} finally { clearTimeout(timeout); rpc?.destroy(); server.kill(); }
