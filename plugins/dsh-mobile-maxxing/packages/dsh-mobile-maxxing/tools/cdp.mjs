// Minimal Chrome DevTools Protocol helper (node: no deps).
// usage: node cdp.mjs <url> [--eval "expr"] [--shot out.png] [--mobile] [--dump-dom]
const PORT = process.env.CDP_PORT || 9222;
async function json(path, init) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function waitForChrome() {
  for (let i = 0; i < 100; i++) {
    try { return await json('/json/version'); } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('chrome not reachable on ' + PORT);
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = new Map(); ws.onmessage = (ev) => this.onMessage(ev.data); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
    } else if (msg.method) {
      for (const fn of this.events.get(msg.method) || []) fn(msg.params);
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, fn) { if (!this.events.has(method)) this.events.set(method, []); this.events.get(method).push(fn); }
  once(method) { return new Promise(res => this.on(method, res)); }
}
const args = process.argv.slice(2);
const url = args[0];
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : true; };
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
await waitForChrome();
const target = await json('/json/new?' + encodeURIComponent(url), { method: 'PUT' });
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
const logs = [];
cdp.on('Runtime.consoleAPICalled', ({ type, args }) => logs.push(`[console.${type}] ` + args.map(a => a.value ?? a.description ?? '').join(' ')));
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => logs.push('[exception] ' + (exceptionDetails.exception?.description || exceptionDetails.text)));
cdp.on('Log.entryAdded', ({ entry }) => logs.push(`[log.${entry.level}] ${entry.text}`));
if (opt('--viewport')) {
  const [width, height] = opt('--viewport').split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(opt('--scale') ?? 1), mobile: false });
}
if (flag('--mobile')) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: Number(opt('--scale') ?? 3), mobile: true });
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
}
if (opt('--preload')) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: opt('--preload') });
if (opt('--safe')) {
  const [top, bottom] = opt('--safe').split(',').map(Number);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, left: 0, bottom, right: 0 } });
}
if (flag('--offline')) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
await cdp.send('Page.navigate', { url });
await new Promise(r => setTimeout(r, Number(opt('--wait') ?? 4000)));
if (opt('--eval')) {
  const r = await cdp.send('Runtime.evaluate', { expression: opt('--eval'), awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.error('EVAL ERROR', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const value = r.result.value ?? r.result.description ?? null;
  if (opt('--save')) {
    const fs = await import('node:fs');
    fs.writeFileSync(opt('--save'), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    console.log('SAVED ' + opt('--save'));
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}
if (flag('--manifest')) {
  console.log('MANIFEST', JSON.stringify(await cdp.send('Page.getAppManifest'), null, 2));
}
if (flag('--installability')) {
  console.log('INSTALLABILITY', JSON.stringify(await cdp.send('Page.getInstallabilityErrors'), null, 2));
}
if (opt('--shot')) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  (await import('node:fs')).writeFileSync(opt('--shot'), Buffer.from(shot.data, 'base64'));
  console.log('SHOT ' + opt('--shot'));
}
if (logs.length) console.log('LOGS\n' + logs.join('\n'));
try { await json('/json/close/' + target.id); } catch {}
cdp.ws.close();
