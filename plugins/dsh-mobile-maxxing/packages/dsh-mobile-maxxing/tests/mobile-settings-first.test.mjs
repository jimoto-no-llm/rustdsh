import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const helper = source.match(/    function decorateMobileSettingsTabs\(modal\) \{[\s\S]*?\n    \}/)[0];

function fixture(label, active = label, mobileMode = true, closeLabel = "閉じる") {
  const tabs = [label, "モバイル", "Models"].map((textContent) => {
    const attrs = new Map(textContent === active ? [["aria-current", "true"]] : []);
    return { textContent, clicks: 0, focused: false,
      toggleAttribute(key, value) { if (value) attrs.set(key, ""); else attrs.delete(key); },
      getAttribute(key) { return attrs.get(key) ?? null; },
      hasAttribute(key) { return attrs.has(key); },
      click() { this.clicks++; for (const tab of tabs) tab.toggleAttribute("aria-current", false); attrs.set("aria-current", "true"); },
      focus() { this.focused = true; },
    };
  });
  function button(textContent, svg = true, span = true) {
    const attrs = new Map();
    return { tagName: "BUTTON", textContent, attrs,
      querySelector(selector) { return selector === ":scope > svg" && svg || selector === ":scope > span" && span ? {} : null; },
      setAttribute(key, value) { attrs.set(key, value); },
      removeAttribute(key) { attrs.delete(key); },
      hasAttribute(key) { return attrs.has(key); },
    };
  }
  const close = button(closeLabel);
  const action = button("Close", false);
  const contentButton = button("Close");
  const header = { children: [{ tagName: "DIV", children: [action] }, close] };
  const modal = { headers: [header],
    querySelectorAll(selector) {
      if (selector === ":scope > nav + div > div:first-child") return this.headers;
      if (selector === "nav button") return tabs;
      if (selector === "[data-rdsh-settings-close]") return [close, action, contentButton, ...tabs].filter((item) => item.hasAttribute("data-rdsh-settings-close"));
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  const decorate = vm.runInNewContext(`(${helper.trim()})`, {
    phone: () => mobileMode,
    t: () => "モバイル",
    labelOf: (element) => element.textContent,
    readGeneralSettingsLabel: () => label,
  });
  return { tabs, close, action, contentButton, header, modal, run: () => decorate(modal) };
}

for (const label of ["General", "一般", "一般設定", "通用设置"]) {
  test(`hides ${label} and switches its active content to Mobile`, () => {
    const f = fixture(label); f.run();
    assert(f.tabs[0].hasAttribute("data-rdsh-settings-tab-hidden"));
    assert.equal(f.tabs[1].clicks, 1);
    assert.equal(f.tabs[1].focused, true);
    assert(!f.tabs[1].hasAttribute("data-rdsh-settings-tab-hidden"));
    f.run(); assert.equal(f.tabs[1].clicks, 1, "must not repeatedly steal selection");
  });
}

for (const closeLabel of ["Close", "閉じる", "关闭", "Fermer", "未知言語"]) {
  test(`tags the ${closeLabel} Settings close button despite duplicate labels`, () => {
    const f = fixture("General", "Models", true, closeLabel);
    f.action.textContent = closeLabel; f.contentButton.textContent = closeLabel;
    f.close.className = "renamed_X91"; f.header.className = "renamed_P02";
    f.run();
    assert(f.close.hasAttribute("data-rdsh-settings-close"));
    assert(!f.action.hasAttribute("data-rdsh-settings-close"));
    assert(!f.contentButton.hasAttribute("data-rdsh-settings-close"));
    assert(!f.tabs.some((tab) => tab.hasAttribute("data-rdsh-settings-close")));
    f.action.setAttribute("data-rdsh-settings-close", "");
    f.run();
    assert(!f.action.hasAttribute("data-rdsh-settings-close"), "redecorating clears stale matches");
  });
}

test("fails closed on ambiguous or missing header close", () => {
  const f = fixture("General", "Models");
  f.run();
  f.header.children.push(f.contentButton); f.run();
  assert(!f.close.hasAttribute("data-rdsh-settings-close"));
  assert(!f.contentButton.hasAttribute("data-rdsh-settings-close"));
  f.header.children.pop(); f.header.children.pop(); f.run();
  assert(!f.close.hasAttribute("data-rdsh-settings-close"));
  f.header.children.push(f.close); f.modal.headers.push(f.header); f.run();
  assert(!f.close.hasAttribute("data-rdsh-settings-close"));
});

test("preserves an existing Models selection", () => {
  const f = fixture("General", "Models"); f.run();
  assert.equal(f.tabs[1].clicks, 0);
  assert.equal(f.tabs[2].getAttribute("aria-current"), "true");
});

test("does not touch desktop tabs", () => {
  const f = fixture("General", "General", false); f.run();
  assert(!f.tabs[0].hasAttribute("data-rdsh-settings-tab-hidden"));
  assert(!f.close.hasAttribute("data-rdsh-settings-close"));
  assert.equal(f.tabs[1].clicks, 0);
});

test("Mobile sorts before the stock General order of zero", () => {
  assert.match(source, /id: "mobile-ux",\s+order: -1,/);
});
