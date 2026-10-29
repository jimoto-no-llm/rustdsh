/**
 * #80: the probe vocabularies carry the reviewed Japanese labels.
 *
 * The full ja dictionaries are translated upstream of this package: this
 * plugin only matches their rendered labels. These tests pin the labels that
 * the #59 More menu, the Automation detail, New session, Fullscreen and the
 * activity chips depend on, against the reviewed outputs in
 * `packages/dsh-locale-ja` work/out (namespace:key in the comments). They
 * also keep the en and zh vocabularies that existing shells still need.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROBES } from "../lib/copy.js";

/** One committed ja namespace, as the full translation ships it. */
function ja(name) {
	return JSON.parse(readFileSync(new URL(`../../dsh-locale-ja/locale/namespaces/ja/${name}.json`, import.meta.url), "utf8"));
}

/** One count template from the committed catalogue, rendered. */
function countLabel(template, count = 3) {
	return template.replace("{count}", String(count));
}

/**
 * label source: the reviewed ja output and the en snapshot key it translates.
 * `en`/`zh` are the values the installed 0.2.1 shell renders today.
 */
const CASES = [
  {
    probe: "navPlugins",
    en: "Plugins",
    zh: "插件",
    ja: "プラグイン",
    source: "pluginManager:panel / pluginManager:title",
  },
  {
    probe: "navAutomation",
    en: "Automation tasks",
    zh: "自动化任务",
    ja: "自動化タスク",
    source: "schedule.manager:panel / schedule.manager:title",
  },
  {
    probe: "closeTaskDetail",
    en: "Close details",
    zh: "关闭详情",
    ja: "詳細を閉じる",
    source: "schedule.manager:detail.close",
  },
  {
    probe: "newSession",
    en: "new session",
    zh: "新建会话",
    ja: "新しいセッション",
    source: "sidebar:session.new.label / workspace:actions.newSession.aria",
  },
  {
    probe: "fullscreen",
    en: "Fullscreen",
    zh: "全屏",
    ja: "全画面表示",
    source: "sidebarRight:chrome.toFullscreen",
  },
  {
    probe: "fullscreenExit",
    en: "Exit fullscreen",
    ja: "全画面表示を終了",
    source: "sidebarRight:chrome.exitFullscreen",
  },
  {
    probe: "activityRunning",
    en: "running",
    zh: "运行中",
    ja: "実行中",
    source: "subagent:count.running / job:count.live",
  },
  {
    probe: "activitySubagentChip",
    en: "subagent",
    zh: "子智能体",
    ja: "サブエージェント",
    source: "subagent:count.running / subagent:count.total",
  },
  {
    probe: "activityChip",
    en: "subagents",
    zh: "个子智能体",
    ja: "件のサブエージェント",
    source: "subagent:count.running.other",
  },
  {
    probe: "split",
    en: "Split",
    ja: "分割",
    source: "sidebarRight:dock.splitPane",
  },
  {
    probe: "accountMenu",
    en: "Account menu",
    ja: "アカウントメニュー",
    source: "settings.account:menu",
  },
  {
    probe: "cacheHit",
    en: "cache hit",
    ja: "キャッシュヒット",
    source: "chat:stats.cacheHit",
  },
];

test("#80 every affected probe keeps en and zh and gains the reviewed ja label", () => {
  for (const item of CASES) {
    const values = PROBES[item.probe];
    assert.ok(Array.isArray(values), `PROBES.${item.probe} exists`);
    assert.ok(values.includes(item.en), `${item.probe} lost ${JSON.stringify(item.en)} (en)`);
    if (item.zh !== undefined) assert.ok(values.includes(item.zh), `${item.probe} lost ${JSON.stringify(item.zh)} (zh)`);
    assert.ok(values.includes(item.ja), `${item.probe} is missing the reviewed ja label (${item.source})`);
  }
});

test("#80 the activity catalogue covers the committed ja count shapes", () => {
  // Read the reviewed catalogue itself, not a hand-written approximation:
  // the subagent total is noun-first, while its running form and both job
  // forms put the number (and 件) first.
  const subagent = ja("subagent");
  const job = ja("job");
  const idleSubagents = countLabel(subagent["count.total.other"]);
  const runningSubagents = countLabel(subagent["count.running.other"]);
  const idleJobs = countLabel(job["count.idle.other"]);
  const runningJobs = countLabel(job["count.live.other"]);

  for (const [label, phrase] of [
    [runningSubagents, "件のサブエージェント"],
    [idleJobs, "件のバックグラウンドジョブ"],
    [runningJobs, "件のバックグラウンドジョブ"],
  ]) {
    assert.ok(label.startsWith("3"), `${label} is not a count-first label`);
    assert.ok(PROBES.activityChip.includes(phrase), `activityChip lost ${phrase}`);
    assert.ok(label.includes(`3${phrase}`) || label.includes(`3 ${phrase}`), `${label} does not render ${phrase} after its count`);
  }

  // The noun-first idle label is matched by its own probes, and the trailing
  // counter closes it.
  assert.ok(PROBES.activityChipCountLast.some((noun) => idleSubagents.startsWith(`${noun} 3 `)), `${idleSubagents} has no count-last noun probe`);
  assert.ok(PROBES.activityChipCounter.some((counter) => idleSubagents.endsWith(` 3 ${counter}`)), `${idleSubagents} has no trailing counter probe`);
  assert.equal(PROBES.activityChip.includes("サブエージェント"), false, "a bare noun would match sentences, not count chips");
});

test("#80 the phone hide list carries the committed ja leaves", () => {
  // The English names stay in client.js as HIDE_DEFAULT; these are the ja
  // renderings of the same controls, read from the reviewed catalogue.
  const settings = ja("settings");
  const shortcuts = ja("shortcuts");
  const account = ja("settings.account");
  const plugins = ja("settings.plugins");
  const command = ja("command");
  const sessionLog = ja("session-log-download");
  const expected = [
    settings.openDocument,
    sessionLog["header.more"],
    command["label.feedback"],
    account.signIn,
    shortcuts.settings,
    settings["developerTools.title"],
    plugins.title,
  ];
  assert.deepEqual([...PROBES.hideControls].sort(), [...expected].sort());
  // Every entry is the whole control label; no bare fragment can hide a
  // settings page or a chat action that merely mentions the word.
  for (const label of PROBES.hideControls) {
    assert.ok(label.length >= 4, `${label} is too broad for a hide entry`);
    assert.equal(label, label.trim());
  }
});

test("#80 no probe value is empty or duplicated, and no broad ja fragment sneaks in", () => {
  for (const [key, values] of Object.entries(PROBES)) {
    assert.equal(values.some((value) => typeof value !== "string" || value.trim() === ""), false, `${key} has an empty value`);
    assert.equal(new Set(values).size, values.length, `${key} repeats a value`);
  }
  // The injected Settings row is labelled 設定; it is not the account menu.
  assert.equal(PROBES.accountMenu.includes("設定"), false, "the account probe would match the injected Settings row");
  // The reviewed usage chip says キャッシュヒット, not the bare noun.
  assert.equal(PROBES.cacheHit.includes("キャッシュ"), false, "the cache probe is a misleading fragment again");
  // "全画面表示を終了" is the exit control, never the enter control.
  assert.equal(PROBES.fullscreen.includes("全画面表示を終了"), false, "the fullscreen probe would click the exit control");
  // The menu item inside the account menu is still Settings / 設定.
  assert.ok(PROBES.settingsMenu.includes("設定"), "the settings-menu probe lost its ja label");
});
