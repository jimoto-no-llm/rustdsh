#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReport } from "./report.mjs";
import { renderReport } from "./view.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [command, input, output] = process.argv.slice(2);
try {
  if (command === "init" && input && !output) {
    const git = (...args) => execFileSync("git", args, {cwd:root,encoding:"utf8"}).trim();
    const dirty = Boolean(git("status", "--porcelain"));
    const report = {schema:1,target:{sha:git("rev-parse","HEAD"),dirty,note:dirty ? "未コミットの変更を含む。SHAは基点であり、試験した差分も証拠へ保存すること。" : "記載SHAのcheckoutを対象とする。"},results:[]};
    await fs.mkdir(path.dirname(path.resolve(input)), {recursive:true});
    await fs.writeFile(input, JSON.stringify(report,null,2)+"\n", {flag:"wx"});
    console.log(`Created ${path.resolve(input)}; all routes are not-run.`);
  } else if (["validate", "report"].includes(command) && input && (command !== "report" || output)) {
    const report = validateReport(JSON.parse(await fs.readFile(input,"utf8")));
    const directory = path.dirname(path.resolve(input));
    for (const result of report.results) for (const reference of result.evidence || []) {
      const evidence = path.join(directory, reference);
      const real = await fs.realpath(evidence);
      const relative = path.relative(await fs.realpath(directory), real);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !(await fs.stat(real)).isFile()) throw new Error(`Evidence is outside the report directory or not a file: ${reference}`);
    }
    if (command === "report") {
      if (path.dirname(path.resolve(output)) !== directory || path.resolve(output) === path.resolve(input)) throw new Error("HTML must be a different file beside its JSON and evidence");
      // Exclusive creation also protects Windows case aliases and hard/symbolic
      // links to the input or evidence. Regenerate to a fresh HTML filename.
      await fs.writeFile(output, renderReport(report), {flag:"wx"});
      console.log(`Created ${path.resolve(output)}`);
    } else console.log(`Valid report: ${report.results.length} recorded results; other routes remain not-run.`);
  } else {
    console.log("Usage: node dashboard/qa/cli.mjs init <results.json>\n       node dashboard/qa/cli.mjs validate <results.json>\n       node dashboard/qa/cli.mjs report <results.json> <report.html>\nStore synthetic/manual evidence beside the JSON; see dashboard/qa/README.md.");
    if (command && command !== "--help") process.exitCode = 1;
  }
} catch (error) { console.error(`QA: ${error.message}`); process.exitCode = 1; }
