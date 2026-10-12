import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../plugins/rdsh-settings/client.js', import.meta.url), 'utf8');

function mount(locale) {
  const disposers = [];
  let section;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) {
      const plugin = module.factory(() => ({}));
      assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
      plugin.apply({ locale,
        effect(install) { disposers.push(install()); },
        slots: {
          inject(_name, install) { install(); },
          register(options) { section = options.id; },
        },
      });
    } } },
  });
  assert.equal(section, 'rdsh');
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

function catalog(initial = []) {
  const languages = new Map(initial.map(language => [language.id, language]));
  const dictionaries = new Map();
  return {
    languages, dictionaries,
    getSnapshot: () => ({ active: 'en', locales: [...languages.values()] }),
    register(namespace, id, dictionary) {
      const key = `${namespace}:${id}`;
      assert.equal(dictionaries.has(key), false, 'Each dictionary has one owner');
      dictionaries.set(key, dictionary);
      return () => dictionaries.delete(key);
    },
    addLanguage(language) {
      assert.equal(languages.has(language.id), false, 'Each language has one owner');
      languages.set(language.id, language);
      return () => languages.delete(language.id);
    },
    setLocale() { assert.fail('Loading a settings plugin must not change the user preference'); },
  };
}

test('Japanese is selectable with settings translations, and unloading removes the pack', () => {
  const locale = catalog([{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]);
  const dispose = mount(locale);
  assert.deepEqual(JSON.parse(JSON.stringify(locale.languages.get('ja'))), {
    id: 'ja', label: '日本語', fallback: 'en',
  });
  assert.equal(locale.dictionaries.get('settings.locale:ja')['language.title'], '言語');
  assert.equal(locale.dictionaries.get('settings:ja')['general.nav'], '一般');
  assert.equal(locale.dictionaries.get('settings.theme:ja')['appearance.title'], '外観');
  assert.equal(locale.dictionaries.get('settings.permission:ja')['title'], '権限');
  assert.equal(locale.dictionaries.get('chat:ja')['settings.transcript.title'], '作業の詳細');
  assert.equal(locale.dictionaries.get('conversation:ja')['settings.enter.title'], '実行中の送信方法');
  dispose();
  assert.deepEqual([...locale.languages.keys()], ['zh', 'en']);
  assert.equal(locale.dictionaries.size, 0);
  mount(locale)(); // Hot reload can register again after disposal.
  assert.equal(locale.dictionaries.size, 0);
});

test('an existing Japanese pack keeps ownership of its language and dictionaries', () => {
  const locale = catalog([{ id: 'en', label: 'English' }, { id: 'JA', label: '既存の日本語' }]);
  const existing = { 'language.title': '既存の言語' };
  locale.dictionaries.set('settings.locale:ja', existing);
  mount(locale)();
  assert.equal(locale.languages.size, 2);
  assert.equal(locale.dictionaries.size, 1);
  assert.equal(locale.dictionaries.get('settings.locale:ja'), existing);
});

test('clients without the language-pack API still mount rdsh settings', () => {
  mount({})(); // Built-in locale service before addLanguage was introduced.
});
