import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The decisions are unit-tested in logic.test.mjs; this test proves the DOM
// wiring against a real Chromium: the shipped bundle is loaded as-is, the
// keyboard is driven through the browser, and a fixture shell with the same
// handler shape as the Web client records what reached it.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

const FIXTURE = `<!doctype html>
<html lang="en">
<body>
<div id="app">
  <div data-composer-card>
    <div id="composer" data-composer-input contenteditable="true" role="textbox" aria-multiline="true"></div>
  </div>
  <div data-goal-bar>
    <div>
      <input id="goal" type="text" aria-label="objective">
      <button type="button" id="goal-save">save</button>
      <button type="button" id="goal-cancel">cancel</button>
    </div>
  </div>
</div>
<script>
  window.__app = { sent: 0, broke: 0, menuSelects: 0, goalSaves: 0, otherKeys: 0, escapes: 0 };
  // Stands in for Lexical in the composer: plain Enter sends, Shift+Enter
  // breaks the line, and an open completion menu owns Enter.
  document.getElementById('composer').addEventListener('keydown', (event) => {
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
    // Upstream consumes an IME confirmation without sending or breaking.
    if (event.isComposing) { event.preventDefault(); return; }
    if (event.key !== 'Enter') { window.__app.otherKeys++; return; }
    if (event.shiftKey) { window.__app.broke++; event.preventDefault(); return; }
    if (document.querySelector('[data-trigger-menu]') !== null) { window.__app.menuSelects++; event.preventDefault(); return; }
    window.__app.sent++; event.preventDefault();
  });
  // Stands in for React's delegated listener on the shell root: the goal
  // editor's onKeyDown commits on Enter, as upstream does.
  document.getElementById('app').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'goal') window.__app.goalSaves++;
    if (event.key === 'Escape' && event.target.id === 'goal') window.__app.escapes++;
  });
  window.__ModuleLoader__ = { load(definition) { window.__rdshUiComfortDefinition = definition; } };
</script>
</body>
</html>`;

function importPlaywright() {
  const roots = [
    process.env.RDSH_PLAYWRIGHT_CORE,
    join(homedir(), '.local/lib/node_modules/@playwright/cli/node_modules/playwright-core'),
  ].filter(Boolean);
  for (const root of roots) {
    for (const entry of ['index.mjs', 'index.js']) {
      const file = join(root, entry);
      if (existsSync(file)) return import(pathToFileURL(file).href).catch(() => null);
    }
  }
  return import('playwright-core').catch(() => null);
}

// Prefer an explicit executable; otherwise newest installed Playwright chromium.
function findChromium() {
  if (process.env.RDSH_CHROMIUM) return process.env.RDSH_CHROMIUM;
  const root = join(homedir(), '.cache/ms-playwright');
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const version of versions) {
    const executable = join(root, version, 'chrome-linux64', 'chrome');
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

const playwright = await importPlaywright();
const executablePath = findChromium();

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the shipped bundle turns Enter into break-then-send and guards the goal editor', async (t) => {
  if (playwright === null) {
    t.skip('playwright-core is not installed');
    return;
  }
  let browser;
  try {
    browser = executablePath === undefined
      ? await playwright.chromium.launch({ headless: true })
      : await playwright.chromium.launch({ headless: true, executablePath });
  } catch (error) {
    t.skip('no launchable Chromium: ' + String(error.message).split('\n')[0]);
    return;
  }
  t.after(() => browser.close());

  // Serve the fixture from a real origin: localStorage is opaque on
  // about:blank, and the plugin reads its settings from it.
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  await page.addScriptTag({ content: source });
  const wired = await page.evaluate(() => {
    const React = {
      createElement: () => null,
      useState: (initial) => [initial, () => {}],
      useCallback: (callback) => callback,
    };
    const plugin = window.__rdshUiComfortDefinition.factory(() => React);
    const sections = [];
    plugin.apply({
      effect: (callback) => callback(),
      slots: {
        inject: (name, callback) => callback(),
        register: (options) => { sections.push(options.id); return () => {}; },
      },
    });
    return { sections, store: typeof window.__rdshUiComfort === 'object' && window.__rdshUiComfort !== null };
  });
  assert.equal(wired.store, true, 'the console store is published');
  assert.deepEqual(wired.sections, ['rdsh-ui-comfort'], 'the settings section is registered');

  const app = () => page.evaluate(() => ({ ...window.__app }));
  const composingEnter = () => page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true,
    });
    document.activeElement.dispatchEvent(event);
  });

  // Composer: the first Enter is a line break, the second inside the window sends.
  await page.focus('#composer');
  await page.keyboard.press('Enter');
  assert.deepEqual(await app(), { sent: 0, broke: 1, menuSelects: 0, goalSaves: 0, otherKeys: 0, escapes: 0 }, 'the first Enter breaks the line without sending');
  await page.keyboard.press('Enter');
  assert.deepEqual(await app(), { sent: 1, broke: 1, menuSelects: 0, goalSaves: 0, otherKeys: 0, escapes: 0 }, 'the second Enter sends');
  await settle(1600);
  await page.keyboard.press('Enter');
  assert.deepEqual(await app(), { sent: 1, broke: 2, menuSelects: 0, goalSaves: 0, otherKeys: 0, escapes: 0 }, 'an Enter after the window breaks again');

  await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await app(), { sent: 1, broke: 3, menuSelects: 0, goalSaves: 0, otherKeys: 0, escapes: 0 }, 'Shift+Enter keeps its stock break');
  await page.keyboard.press('Control+Enter');
  assert.deepEqual(await app(), { sent: 2, broke: 3, menuSelects: 0, goalSaves: 0, otherKeys: 0, escapes: 0 }, 'Ctrl+Enter keeps its stock send');

  await composingEnter();
  assert.equal((await app()).sent, 2, 'an IME confirmation never sends');
  assert.equal((await app()).broke, 3, 'an IME confirmation never breaks the line');

  await page.keyboard.press('a');
  assert.equal((await app()).otherKeys, 1, 'typing is untouched');

  // An open completion menu owns Enter: the plugin must not break or send.
  await page.evaluate(() => {
    const menu = document.createElement('div');
    menu.id = 'menu';
    menu.setAttribute('data-trigger-menu', '');
    document.getElementById('composer').append(menu);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.deepEqual(await app(), { sent: 2, broke: 3, menuSelects: 2, goalSaves: 0, otherKeys: 1, escapes: 0 }, 'the completion menu keeps both Enters');
  await page.evaluate(() => document.getElementById('menu').remove());

  // Goal editor: Enter never commits; Ctrl+Enter and Escape stay stock.
  await page.focus('#goal');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Enter');
  await composingEnter();
  assert.deepEqual(await app(), { sent: 2, broke: 3, menuSelects: 2, goalSaves: 0, otherKeys: 1, escapes: 0 }, 'no goal commit on Enter, Shift+Enter or an IME confirmation');
  await page.keyboard.press('Control+Enter');
  assert.equal((await app()).goalSaves, 1, 'Ctrl+Enter commits the goal edit');
  await page.keyboard.press('Escape');
  assert.equal((await app()).escapes, 1, 'Escape still reaches the editor');

  // Switches restore the stock behaviour and the console store controls them.
  await page.evaluate(() => window.__rdshUiComfort.set({ doubleEnter: false }));
  await page.focus('#composer');
  await page.keyboard.press('Enter');
  assert.equal((await app()).sent, 3, 'doubleEnter=false restores Enter-to-send');
  await page.evaluate(() => window.__rdshUiComfort.set({ doubleEnter: true, goalGuard: false }));
  await page.focus('#goal');
  await page.keyboard.press('Enter');
  assert.equal((await app()).goalSaves, 2, 'goalGuard=false restores the upstream commit');

  const reset = await page.evaluate(() => {
    const value = window.__rdshUiComfort.reset();
    return { value, stored: localStorage.getItem('rdsh-ui-comfort:v1') };
  });
  assert.equal(reset.value.doubleEnter, true);
  assert.equal(reset.value.goalGuard, true);
  assert.equal(reset.value.windowMs, 1500);
  assert.equal(reset.stored, null, 'reset clears the stored entry');
});
