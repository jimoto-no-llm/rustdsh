import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cases, operations } from "../qa/catalog.mjs";
import { validateReport, reportRows } from "../qa/report.mjs";
import { renderReport } from "../qa/view.mjs";

const empty = () => ({schema:1,target:{sha:"a".repeat(40),dirty:true,note:"Uncommitted QA change"},results:[]});
const result = (extra={}) => ({case_id:"project-desktop-local-sse-draft",status:"pass",level:"browser",observed_route:"local",tested_at:"2026-10-08T04:00:00Z",environment:{os:"Windows",node:"24.13.0",browser:"IAB / version unknown",device:"desktop"},command:"node dashboard/qa/fixture.mjs",reason:"Draft survived the event",evidence:["evidence/sse.png"],observations:{input_lost:false,duplicate_answers:0,answer_requests:0,feedback_count:0,focus_preserved:true},...extra});

test("evidence paths reject repeated hyphens without blocking report validation", () => {
  const url = new URL("../qa/report.mjs", import.meta.url).href;
  const source = `import { evidencePath } from ${JSON.stringify(url)};
    try { evidencePath('a' + '-'.repeat(450) + '.exe'); process.exitCode = 1; }
    catch (error) { if (!error.message.includes('Evidence must')) throw error; }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    timeout: 3000, encoding: "utf8",
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
});

test("catalogue includes every declared operation/device/route without pretending to test them", () => {
  assert.equal(new Set(cases.map(item=>item.id)).size,cases.length);
  for (const route of ["local","wsl","tailscale"]) for (const device of ["desktop","mobile"]) for (const [operation] of operations)
    assert.ok(cases.some(item=>item.route===route && item.device===device && item.operation===operation));
  const rows=reportRows(empty());
  assert.equal(rows.length,cases.length);
  assert.ok(rows.every(item=>item.status==="not-run"));
  const report=empty(); report.results.push(result());
  assert.equal(reportRows(report).filter(item=>item.status==="pass").length,1);
  assert.ok(reportRows(report).filter(item=>item.route!=="local").every(item=>item.status==="not-run"));
});

test("a local fixture or mobile viewport cannot certify an untested real connection", () => {
  for (const patch of [
    {level:"fixture"},
    {case_id:"project-desktop-wsl-sse-draft"},
    {case_id:"project-desktop-wsl-sse-draft",observed_route:"wsl"},
    {case_id:"project-mobile-tailscale-sse-draft",observed_route:"tailscale",level:"real-connection",environment:{os:"Windows",node:"24.13.0",browser:"IAB",device:"viewport"}},
  ]) assert.throws(()=>validateReport({...empty(),results:[result(patch)]}),/level|route|physical-phone/);
  const report={...empty(),results:[result({case_id:"project-mobile-tailscale-sse-draft",observed_route:"tailscale",level:"real-connection",environment:{os:"Android",node:"24.13.0",browser:"Chrome",device:"physical-phone"}})]};
  assert.equal(validateReport(report),report);
});

test("failed observations, missing evidence and malformed records cannot become passes", () => {
  for (const patch of [
    {case_id:"unknown"},{status:"success"},{evidence:[]},{observations:{}},
    {observations:{input_lost:true,duplicate_answers:0,feedback_count:0}},
    {observations:{input_lost:false,duplicate_answers:2,feedback_count:2}},
    {tested_at:"2026-02-30T12:00:00Z"},{tested_at:"tomorrow"},{reason:""},
    {case_id:"project-desktop-local-double-submit",observations:{input_lost:false,duplicate_answers:0,feedback_count:1}},
    {evidence:["https://example.com/#key=credential"]},{evidence:["../private.txt"]},{evidence:["javascript:alert(1)"]},{evidence:["/absolute.txt"]},
  ]) assert.throws(()=>validateReport({...empty(),results:[result(patch)]}));
  assert.throws(()=>validateReport({...empty(),results:[result(),result()]}),/duplicate/);
  assert.throws(()=>validateReport({...empty(),results:[result({status:"not-run"})]}),/not-run/);
  assert.equal(validateReport({...empty(),results:[result({status:"fail",observations:{input_lost:true,duplicate_answers:0,feedback_count:0}})]}).results[0].status,"fail");
});

test("target SHA must be a string rather than a coercible JSON value", () => {
  const report = empty();
  report.target.sha = [report.target.sha];
  assert.throws(()=>validateReport(report), /target SHA/);
});

test("rendered report includes untested rows and escapes all reported text", () => {
  const injection='</script><img src=x onerror=alert(1)>';
  const report={...empty(),results:[result({reason:injection})]};
  const html=renderReport(report);
  assert.ok(html.includes("project-mobile-tailscale-disconnect-after"));
  assert.ok(html.includes("not-run"));
  assert.ok(!html.includes(injection));
  assert.equal(renderReport(report),html);
});

test("duplicate summary counts affected cells without adding shared observations as separate answers", () => {
  const shared = {status:"fail",reason:"One keyboard submission also covers the basic answer case; shared observation.",
    evidence:["evidence/shared-answer.json"],observations:{input_lost:false,duplicate_answers:1,answer_requests:2,feedback_count:2}};
  const report = {...empty(),results:[
    result({...shared,case_id:"project-desktop-local-answer"}),
    result({...shared,case_id:"project-desktop-local-keyboard"}),
    result(),
  ]};
  const html = renderReport(report);
  assert.ok(html.includes("重複回答: 2セルで発生 / 3セルを観測"));
  assert.ok(!html.includes("重複回答: 2件 / 3セルを観測"));
  assert.ok(html.includes("重複回答: 1件"), "each cell retains its actual measured answer count");
  assert.ok(renderReport(empty()).includes("重複回答: 未取得"), "unmeasured cells do not imply zero duplicates");
});

test("every passing Project operation requires its observed answer outcome", () => {
  const submitted = new Set(["answer", "keyboard", "double-submit", "disconnect-before", "disconnect-after"]);
  for (const [operation] of operations) {
    const observations = {input_lost:false, duplicate_answers:0, answer_requests:submitted.has(operation) ? 1 : 0,
      feedback_count:submitted.has(operation) ? 1 : 0, focus_preserved:true};
    const measured = result({case_id:`project-desktop-local-${operation}`, observations});
    assert.equal(validateReport({...empty(),results:[measured]}).results[0], measured, operation);
    for (const field of ["input_lost", "duplicate_answers", "answer_requests", "feedback_count"]) {
      for (const value of [undefined, null]) {
        const missing = {...observations, [field]:value};
        if (value === undefined) delete missing[field];
        assert.throws(()=>validateReport({...empty(),results:[{...measured, observations:missing}]}), undefined, `${operation}: ${field} must be measured`);
      }
    }
  }
});

test("a pass distinguishes saved answers from unsent drafts and requires specified focus checks", () => {
  for (const operation of ["answer", "keyboard", "double-submit", "disconnect-before", "disconnect-after"]) {
    const observations = {input_lost:false, duplicate_answers:0, answer_requests:1, feedback_count:1, focus_preserved:true};
    const measured = result({case_id:`project-desktop-local-${operation}`, observations});
    for (const patch of [{feedback_count:0}, {feedback_count:2}, {answer_requests:0}])
      assert.throws(()=>validateReport({...empty(),results:[{...measured, observations:{...observations,...patch}}]}), undefined, `${operation}: incomplete or duplicate save cannot pass`);
    assert.doesNotThrow(()=>validateReport({...empty(),results:[{...measured, observations:{...observations,answer_requests:3}}]}), "transport retry alone is not a duplicate answer");
  }
  for (const operation of ["sse-draft", "reload", "back", "cancel"]) {
    const measured = result({case_id:`project-desktop-local-${operation}`});
    for (const patch of [{feedback_count:1}, {answer_requests:1}])
      assert.throws(()=>validateReport({...empty(),results:[{...measured, observations:{...measured.observations,...patch}}]}), undefined, `${operation}: an unsent draft must remain unsent`);
  }
  for (const operation of ["sse-draft", "cancel"]) for (const focus of [undefined, null, false]) {
    const observations = {input_lost:false, duplicate_answers:0, answer_requests:0,
      feedback_count:0, focus_preserved:focus};
    if (focus === undefined) delete observations.focus_preserved;
    assert.throws(()=>validateReport({...empty(),results:[result({case_id:`project-desktop-local-${operation}`,observations})]}), undefined, `${operation}: focus must be checked`);
  }
  assert.doesNotThrow(()=>validateReport({...empty(),results:[result({case_id:"project-desktop-local-keyboard",
    observations:{input_lost:false, duplicate_answers:0, answer_requests:1, feedback_count:1, focus_preserved:null,
      detail:"Keyboard submission completed; the submitted form disappeared and focus returned to the document."}})]}));
});

test("failure and unavailable evidence remain distinct from a passing Project operation", () => {
  for (const operation of ["sse-draft", "double-submit", "disconnect-before", "disconnect-after"]) {
    const measured = result({case_id:`project-desktop-local-${operation}`,status:"fail",
      observations:{input_lost:true, duplicate_answers:2, answer_requests:3, feedback_count:3, focus_preserved:false}});
    assert.equal(validateReport({...empty(),results:[measured]}).results[0].status,"fail");
    measured.observations = {input_lost:false, duplicate_answers:0, answer_requests:1, feedback_count:0};
    assert.doesNotThrow(()=>validateReport({...empty(),results:[measured]}), "a failed send may save zero answers");
  }
  const blocked = result({status:"blocked",level:"fixture",evidence:[],observations:{}});
  assert.equal(validateReport({...empty(),results:[blocked]}).results[0].status,"blocked");
  assert.doesNotThrow(()=>validateReport({...empty(),results:[result({case_id:"project-api-fixture",level:"fixture",observed_route:"fixture",observations:{}})]}));
  assert.doesNotThrow(()=>validateReport({...empty(),results:[result({case_id:"harness-desktop-wsl-tailscale",level:"real-connection",observed_route:"wsl-tailscale",observations:{}})]}));
});

test("CLI validates evidence existence and produces an adjacent offline report", async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"rdsh-qa-report-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const input=path.join(directory,"results.json"), output=path.join(directory,"report.html");
  const cli=fileURLToPath(new URL("../qa/cli.mjs",import.meta.url));
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:"utf8"});
  assert.equal(run("init",input).status,0);
  assert.equal(run("init",input).status,1,"do not overwrite an existing record");
  await fs.writeFile(input,JSON.stringify({...empty(),results:[result({evidence:["proof.txt"]})]}));
  assert.equal(run("validate",input).status,1,"missing evidence is not accepted");
  await fs.writeFile(path.join(directory,"proof.txt"),"actual test log");
  assert.equal(run("report",input,output).status,0);
  assert.ok((await fs.readFile(output,"utf8")).includes("project-desktop-local-sse-draft"));
  assert.equal(run("report",input,input).status,1,"never replace JSON with HTML");
  assert.equal(run("report",input,path.join(directory,"proof.txt")).status,1,"never replace evidence with HTML");
  assert.equal(await fs.readFile(path.join(directory,"proof.txt"),"utf8"),"actual test log");
  const alias=path.join(directory,"alias.html"); await fs.link(input,alias);
  assert.equal(run("report",input,alias).status,1,"never overwrite the record through a hard link");
  if (process.platform === "win32") assert.equal(run("report",input,path.join(directory,"RESULTS.JSON")).status,1,"case aliases are the same input on Windows");
  assert.ok(JSON.parse(await fs.readFile(input,"utf8")).results.length);
  const outside=path.join(directory,"nested"); await fs.mkdir(outside);
  assert.equal(run("report",input,path.join(outside,"report.html")).status,1,"keep relative proof links alongside JSON");
});
