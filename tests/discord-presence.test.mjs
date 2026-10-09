import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscordIpc, frame, ipcPaths, discordDefaults, normalizeDiscord, activityFor, createDiscordPresence, defaultDiscordImage, createApplicationImageResolver, isWsl } from '../plugins/rdsh-settings/discord.js';

const applicationId = '123456789012345678';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('WSL system services detect the Windows bridge without inherited WSL environment variables', () => {
  assert.equal(isWsl('linux', {}, '6.6.87.2-microsoft-standard-WSL2'), true);
  assert.equal(isWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, 'custom-kernel'), true);
  assert.equal(isWsl('linux', {}, '6.8.0-generic'), false);
  assert.equal(isWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' }, 'microsoft'), false);
});
async function eventually(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'expected state did not arrive');
}
async function fakeDiscord(t, { acknowledge = true, rejectActivity = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-discord-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\rdsh-discord-${process.pid}-${Date.now()}` : join(root, 'discord-ipc-0');
  const commands = [], handshakes = [], sockets = new Set(), pongs = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4) + 8) {
        const op = buffer.readUInt32LE(0), size = buffer.readUInt32LE(4);
        const raw = buffer.subarray(8, size + 8); buffer = buffer.subarray(size + 8);
        if (op === 4) { pongs.push(raw.toString()); continue; }
        const command = JSON.parse(raw);
        if (op === 0) {
          handshakes.push(command);
          const ready = frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
          socket.write(ready.subarray(0, 3));
          setTimeout(() => socket.write(Buffer.concat([ready.subarray(3), frame(3, Buffer.from('ping'))])), 2);
        } else {
          commands.push(command);
          if (acknowledge) socket.write(frame(1, rejectActivity
            ? { cmd: command.cmd, nonce: command.nonce, evt: 'ERROR', data: { code: 4000 } }
            : { cmd: command.cmd, nonce: command.nonce, data: command.args }));
        }
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { path, commands, handshakes, pongs, sockets };
}

test('real IPC handshake, fragmented/coalesced frames, ping, ACK and clear', async t => {
  const fake = await fakeDiscord(t);
  const rpc = await DiscordIpc.connect(applicationId, { paths: [join(tmpdir(), 'missing-discord-pipe'), fake.path], timeout: 200 });
  t.after(() => rpc.destroy());
  const activity = activityFor(discordDefaults, 2, 12345);
  await rpc.setActivity(activity); await rpc.setActivity(null);
  await eventually(() => fake.pongs.length === 1);
  assert.deepEqual(fake.handshakes, [{ v: 1, client_id: applicationId }]);
  assert.equal(fake.commands[0].cmd, 'SET_ACTIVITY');
  assert.equal(fake.commands[0].args.pid, process.pid);
  assert.deepEqual(fake.commands[0].args.activity, { type: 0, status_display_type: 2, details: 'dshで作業中', instance: false, state: 'agent稼働中 (2)', timestamps: { start: 12345 }, assets: { large_image: defaultDiscordImage, large_text: 'dsh' } });
  assert.equal(fake.commands[1].args.activity, null);
  assert.notEqual(fake.commands[0].nonce, fake.commands[1].nonce);
  assert.deepEqual(fake.pongs, ['ping']);
});

test('rejected activity and acknowledgement timeout close the connection', async t => {
  for (const options of [{ rejectActivity: true }, { acknowledge: false }]) {
    const fake = await fakeDiscord(t, options);
    const rpc = await DiscordIpc.connect(applicationId, { paths: [fake.path], timeout: 50 });
    await assert.rejects(rpc.setActivity({ details: 'dsh' }), /rejected|timed out/);
    assert.equal(rpc.closed, true);
  }
});

test('malformed and oversized frames reject outstanding work without leaking sockets', async t => {
  for (const packet of [frame(1, Buffer.from('{broken')), (() => { const b = Buffer.alloc(8); b.writeUInt32LE(1); b.writeUInt32LE(65537, 4); return b; })()]) {
    const fake = await fakeDiscord(t, { acknowledge: false });
    const rpc = await DiscordIpc.connect(applicationId, { paths: [fake.path], timeout: 100 });
    const pending = rpc.setActivity({ details: 'dsh' });
    const rejected = assert.rejects(pending, /JSON|Oversized/);
    for (const socket of fake.sockets) socket.write(packet);
    await rejected; assert.ok(rpc.closed);
  }
});

test('settings gate actual connections; multiple agents, privacy, edits and disable reach IPC', async t => {
  const fake = await fakeDiscord(t);
  let config = { discord: { ...discordDefaults, enabled: false } }, connections = 0;
  const presence = createDiscordPresence({ loadSettings: async () => config, minUpdateInterval: 0, interval: 1e6, throttle: 1,
    connect: id => { connections++; return DiscordIpc.connect(id, { paths: [fake.path], timeout: 100 }); } });
  t.after(() => presence.stop());
  await presence.refresh(); assert.equal(connections, 0); assert.equal(presence.status().state, 'disabled');
  config.discord.enabled = true; config.discord.application_id = "invalid";
  await presence.refresh(); assert.equal(connections, 0); assert.equal(presence.status().state, 'needs_application_id');
  config.discord.application_id = applicationId;
  await presence.refresh(); assert.equal(presence.status().state, 'connected');
  assert.equal(fake.commands.at(-1).args.activity.state, '待機中');
  const a = { id: 'same', prompt: 'PRIVATE', status: 'running' }, b = { id: 'same', status: 'running' };
  presence.observe(a); presence.observe(b); await presence.refresh();
  assert.equal(fake.commands.at(-1).args.activity.state, 'agent稼働中 (2)');
  presence.observe(a, 'idle'); presence.forget(b); await presence.refresh();
  assert.equal(fake.commands.at(-1).args.activity.state, '待機中');
  const count = fake.commands.length; await presence.refresh(); assert.equal(fake.commands.length, count);
  config.discord = { ...config.discord, details: 'コードを書いています', show_agent_status: false, show_elapsed: false };
  await presence.refresh();
  assert.deepEqual(fake.commands.at(-1).args.activity, { type: 0, status_display_type: 2, details: 'コードを書いています', instance: false });
  assert.ok(!JSON.stringify(fake.commands).includes('PRIVATE'));
  config.discord.enabled = false; await presence.refresh();
  assert.equal(fake.commands.at(-1).args.activity, null); assert.equal(presence.status().state, 'disabled');
});

test('disconnect reconnects and republishes current state; changing Application ID clears old presence', async t => {
  const fake = await fakeDiscord(t);
  let config = { discord: { ...discordDefaults, enabled: true, application_id: applicationId } };
  const presence = createDiscordPresence({ loadSettings: async () => config, minUpdateInterval: 0, interval: 1e6, throttle: 1,
    connect: id => DiscordIpc.connect(id, { paths: [fake.path], timeout: 100 }) });
  t.after(() => presence.stop());
  await presence.refresh();
  for (const socket of fake.sockets) socket.destroy();
  await eventually(() => fake.sockets.size === 0); await delay(10);
  presence.observe({}, 'running'); await presence.refresh();
  assert.equal(fake.handshakes.length, 2); assert.equal(fake.commands.at(-1).args.activity.state, 'agent稼働中 (1)');
  config.discord.application_id = '987654321098765432'; await presence.refresh();
  assert.equal(fake.handshakes.at(-1).client_id, '987654321098765432');
  assert.ok(fake.commands.some(c => c.args.activity === null));
  await presence.stop(); assert.equal(fake.commands.at(-1).args.activity, null);
});

test('unavailable Discord and corrupt settings never fail agent work or retain published state', async t => {
  let config = { discord: { ...discordDefaults, enabled: true, application_id: applicationId } }, broken = false;
  const presence = createDiscordPresence({ loadSettings: async () => { if (broken) throw new Error('corrupt'); return config; }, minUpdateInterval: 0, interval: 1e6,
    connect: async () => { throw new Error('not running'); } });
  t.after(() => presence.stop());
  await presence.refresh(); assert.equal(presence.status().state, 'disconnected');
  broken = true; await presence.refresh(); assert.equal(presence.status().state, 'invalid_settings');
});

test('shutdown during connection prevents a late READY from restoring activity', async () => {
  let release;
  const activity = [];
  const presence = createDiscordPresence({ loadSettings: async () => ({ discord: { enabled: true, application_id: applicationId } }), minUpdateInterval: 0, interval: 1e6,
    connect: () => new Promise(resolve => { release = () => resolve({ setActivity: async value => activity.push(value), destroy() {} }); }) });
  const update = presence.refresh(); await eventually(() => release);
  const stopping = presence.stop(); release(); await update; await stopping;
  assert.deepEqual(activity, [null]);
  await presence.refresh(); assert.deepEqual(activity, [null]);
});

test('platform paths and text limits preserve Unicode and omit disabled fields', () => {
  assert.equal(ipcPaths('win32').length, 10);
  assert.equal(ipcPaths('win32')[0], '\\\\.\\pipe\\discord-ipc-0');
  assert.ok(ipcPaths('linux', { XDG_RUNTIME_DIR: '/custom' }).includes('/custom/app/com.discordapp.Discord/discord-ipc-0'));
  assert.deepEqual(normalizeDiscord({ enabled: 'true', details: ' ', show_elapsed: null }), discordDefaults);
  const settings = normalizeDiscord({ details: 'あ'.repeat(200), show_elapsed: false, show_agent_status: false });
  assert.equal(Array.from(settings.details).length, 128);
  const activity = activityFor(settings, 10, 999);
  assert.ok(Buffer.byteLength(activity.details) <= 128); assert.ok(!activity.details.includes('�'));
  assert.ok(!('state' in activity)); assert.ok(!('timestamps' in activity));
});


test('unconfigured presence connects by default; missing or blank ID uses the bundled dsh application', async t => {
  const fake = await fakeDiscord(t);
  for (const config of [{}, { discord: {} }, { discord: { application_id: '' } }, { discord: { application_id: '  ' } }]) {
    const presence = createDiscordPresence({
      loadSettings: async () => config, minUpdateInterval: 0, interval: 1e6,
      connect: id => DiscordIpc.connect(id, { paths: [fake.path], timeout: 200 }),
    });
    try {
      await presence.refresh(); assert.equal(presence.status().state, 'connected');
      assert.equal(fake.handshakes.at(-1).client_id, '1557873849280888903');
    } finally { await presence.stop(); }
  }
});

test('RPC presentation selects a valid status field and gates optional assets and buttons', () => {
  const config = normalizeDiscord({ status_display: 'state', large_image: 'dsh_logo', large_text: '作業中', button_label: '詳しく見る', button_url: 'https://example.com/dsh' });
  const activity = activityFor(config, 3, 100);
  assert.equal(activity.type, 0);
  assert.equal(activity.status_display_type, 1);
  assert.deepEqual(activity.assets, { large_image: 'dsh_logo', large_text: '作業中' });
  assert.deepEqual(activity.buttons, [{ label: '詳しく見る', url: 'https://example.com/dsh' }]);
  assert.equal(activityFor({ ...config, show_agent_status: false }, 3, 100).status_display_type, 2);
  assert.equal(activityFor({ ...config, show_image: false }, 3, 100).assets, undefined);
  for (const url of ['javascript:alert(1)', 'file:///private/file', 'https://user:secret@example.com']) {
    const rejected = activityFor({ ...config, large_image: url, button_url: url }, 0, 100);
    assert.equal(rejected.assets, undefined); assert.equal(rejected.buttons, undefined);
  }
  assert.equal(activityFor({ ...config, large_image: 'https://example.com/logo.png' }, 0, 100).assets.large_image, 'https://example.com/logo.png');
});

test('rate limiting coalesces agents and reports only acknowledged activity; disabling clears during a delayed update', async () => {
  const sent = [], times = [];
  let enabled = true;
  const presence = createDiscordPresence({ loadSettings: async () => ({ discord: { enabled } }), interval: 1e6, throttle: 1, minUpdateInterval: 60,
    connect: async () => ({ setActivity: async value => { sent.push(value); times.push(Date.now()); }, destroy() {} }) });
  try {
    await presence.refresh(); const a = {}, b = {};
    presence.observe(a, 'running'); const updating = presence.refresh();
    await delay(10); presence.observe(b, 'running');
    assert.equal(presence.status().published_activity.state, '待機中');
    await updating;
    assert.equal(sent.length, 2); assert.equal(sent[1].state, 'agent稼働中 (2)');
    assert.ok(times[1] - times[0] >= 59); assert.ok(presence.status().updated_at);
    presence.observe(a, 'idle'); const pending = presence.refresh();
    await delay(10); enabled = false; await pending;
    assert.equal(sent.at(-1), null); assert.equal(presence.status().published_activity, null);
    assert.equal(presence.status().state, 'disabled');
  } finally { await presence.stop(); }
});

test('public App Icon changes refresh through the cache; offline metadata keeps the last usable image', async () => {
  let clock = 0, hash = 'a'.repeat(32), calls = 0, offline = false;
  const image = createApplicationImageResolver({ now: () => clock, refreshMs: 100,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://discord.com/api/v10/oauth2/applications/1557873849280888903/rpc');
      assert.ok(options.signal); if (offline) throw new Error('offline');
      return { ok: true, json: async () => ({ icon: hash }) };
    } });
  const first = await image(); assert.ok(first.includes(hash));
  hash = 'b'.repeat(32); assert.equal(await image(), first); assert.equal(calls, 1);
  clock = 101; const second = await image(); assert.ok(second.includes(hash)); assert.equal(calls, 2);
  clock = 202; offline = true; assert.equal(await image(), second);
  clock = 303; offline = false; hash = 'https://untrusted.example/icon'; assert.equal(await image(), second);
});
