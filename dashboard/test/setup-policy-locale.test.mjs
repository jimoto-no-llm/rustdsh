import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../../src/setup.html", import.meta.url), "utf8");
const helperStart = html.indexOf("function sharingPolicyError(");
const start = html.indexOf("function showSharing(");
const end = html.indexOf("\nasync function toggleExtra", start);
const source = html.slice(helperStart < 0 ? start : helperStart, end);

for (const [language, column] of [["en", 1], ["zh-CN", 2], ["ja", 0]]) {
  test(`setup renders owned policy failures in ${language} and preserves external text`, () => {
    for (const [raw, localized] of [
      ["credential sharing policy is unreadable; imports are disabled", ["認証情報の共有ポリシーを読み取れません。インポートは無効です", "credential sharing policy is unreadable; imports are disabled", "无法读取凭据共享策略；已禁用导入"]],
      ["credential sharing policy is oversized; imports are disabled", ["認証情報の共有ポリシーが大きすぎます。インポートは無効です", "credential sharing policy is oversized; imports are disabled", "凭据共享策略过大；已禁用导入"]],
      ["invalid credential sharing policy; imports are disabled", ["認証情報の共有ポリシーが無効です。インポートは無効です", "invalid credential sharing policy; imports are disabled", "凭据共享策略无效；已禁用导入"]],
      ["unsupported credential sharing policy; imports are disabled", ["認証情報の共有ポリシーは未対応です。インポートは無効です", "unsupported credential sharing policy; imports are disabled", "凭据共享策略不受支持；已禁用导入"]],
      ["external raw 日本語 {id}", ["external raw 日本語 {id}", "external raw 日本語 {id}", "external raw 日本語 {id}"]],
    ]) {
      const hint = { textContent: "" };
      const list = { replaceChildren() {} };
      const sharing = { policy_error: raw, persistent_destination: "日本語/path" };
      vm.runInNewContext(source + "\nshowSharing(sharing)", {
        document: { getElementById: id => id === "sharehint" ? hint : list },
        t: (...values) => values[column], sharing,
      });
      assert.ok(hint.textContent.endsWith(" " + localized[column]), hint.textContent);
      assert.ok(hint.textContent.includes("日本語/path"));
      assert.equal(sharing.policy_error, raw);
    }
  });
}
