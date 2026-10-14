import test from "node:test";
import { execFileSync } from "node:child_process";

for (const language of ["en", "zh-CN", "ja"])
  test(`observed CLI status uses ${language} and keeps received identifiers`, () => {
    const source = `
      import assert from "node:assert/strict";
      function element() {
        return { children: [], ownText: "", value: "", addEventListener() {},
          append(...nodes) { this.children.push(...nodes); },
          replaceChildren(...nodes) { this.children = nodes; },
          get textContent() { return this.ownText + this.children.map(child => child.textContent).join(" "); },
          set textContent(value) { this.ownText = value; this.children = []; }
        };
      }
      const nodes = new Map();
      globalThis.document = {
        documentElement: { dataset: { rdshLocale: ${JSON.stringify(language)} } },
        createElement: element,
        getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
      };
      globalThis.window = { addEventListener() {} };
      globalThis.setInterval = () => 0;
      const { text } = await import(${JSON.stringify(new URL("../locale.mjs", import.meta.url).href)});
      const { setupObservedCli } = await import(${JSON.stringify(new URL("../observed-cli-ui.mjs", import.meta.url).href)});
      const statuses = ["alive", "gone", "pid_reused", "owner_mismatch", "unknown", "future-status"];
      const processes = statuses.map((status, index) => ({ status, status_label: "API原文_" + status,
        id: "ID_日本語_" + index, pid: 1234 + index, cli_kind: "CLI_中文",
        task_id: "TASK_日本語", task_present: false, registered_at: "2026-10-14T01:02:03Z", observed_at: "2026-10-14T01:02:04Z" }));
      const before = JSON.stringify(processes);
      await setupObservedCli({ api: async () => ({ processes }) }).refresh();
      const items = nodes.get("observed-cli-list").children;
      assert.equal(items.length, statuses.length);
      for (const [index, status] of statuses.entries()) {
        const expected = status === "future-status" ? "API原文_" + status : text("observed.status." + status);
        assert.equal(items[index].children[0].textContent, "CLI_中文 · PID " + (1234 + index) + " · " + expected);
        assert.ok(items[index].children[1].textContent.includes(text("observed.task", { id: "TASK_日本語" })));
        assert.ok(items[index].textContent.includes(text("observed.removed")));
      }
      assert.equal(JSON.stringify(processes), before);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  });
