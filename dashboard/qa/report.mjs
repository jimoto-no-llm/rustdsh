import { cases } from "./catalog.mjs";

export const statuses = ["pass", "fail", "blocked", "not-run"];
export const levels = ["fixture", "browser", "real-connection"];
const own = (value, key) => Object.hasOwn(value, key);
function object(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error(`Invalid ${label}`);
}
function text(value, label, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
}
function time(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid tested_at; use UTC ISO time");
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction || "").padEnd(3, "0")}Z`);
  if (new Date(value).toISOString() !== canonical) throw new Error("Invalid tested_at calendar date");
}
export function evidencePath(value) {
  text(value, "evidence path", 512);
  // Evidence stays relative to the saved report. No credential URLs or active schemes.
  if (!/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*\.(?:png|jpg|jpeg|gif|txt|json|html|log|md)$/.test(value) || value.includes(".."))
    throw new Error("Evidence must be a relative file path without URL, query or traversal");
  return value;
}
export function validateReport(report) {
  object(report, ["schema", "target", "results"], "report");
  if (report.schema !== 1) throw new Error("Unsupported QA report schema");
  object(report.target, ["sha", "dirty", "note"], "target");
  if (typeof report.target.sha !== "string" || !/^[a-f0-9]{40}$/.test(report.target.sha) || typeof report.target.dirty !== "boolean") throw new Error("Invalid target SHA/dirty state");
  text(report.target.note, "target note");
  if (!Array.isArray(report.results) || report.results.length > cases.length) throw new Error("Invalid results");
  const seen = new Set();
  for (const result of report.results) {
    object(result, ["case_id", "status", "level", "observed_route", "tested_at", "environment", "command", "reason", "evidence", "observations"], "result");
    const definition = cases.find(item => item.id === result.case_id);
    if (!definition || seen.has(result.case_id)) throw new Error("Unknown or duplicate case_id");
    seen.add(result.case_id);
    if (!statuses.includes(result.status)) throw new Error("Invalid result status");
    text(result.reason, "reason");
    if (result.status === "not-run") {
      if (Object.keys(result).some(key => !["case_id", "status", "reason"].includes(key))) throw new Error("not-run cannot claim execution evidence");
      continue;
    }
    if (!levels.includes(result.level)) throw new Error("Invalid evidence level");
    if (result.observed_route !== definition.route) throw new Error("Observed route does not match case; do not reuse local evidence");
    time(result.tested_at);
    object(result.environment, ["os", "node", "browser", "device"], "environment");
    for (const key of ["os", "node", "browser", "device"]) text(result.environment[key], `environment.${key}`, 500);
    text(result.command, "command");
    if (!Array.isArray(result.evidence) || result.evidence.length > 20) throw new Error("Invalid evidence list");
    result.evidence.forEach(evidencePath);
    if (["pass", "fail"].includes(result.status)) {
      if (!result.evidence.length) throw new Error("pass/fail require evidence");
      if (levels.indexOf(result.level) < levels.indexOf(definition.minimumLevel)) throw new Error("Evidence level cannot verify this route");
      if (definition.device === "mobile" && result.level === "real-connection" && result.environment.device !== "physical-phone")
        throw new Error("Real mobile connection requires a physical-phone observation");
    }
    object(result.observations, ["input_lost", "duplicate_answers", "answer_requests", "feedback_count", "focus_preserved", "detail"], "observations");
    for (const key of ["input_lost", "focus_preserved"]) if (own(result.observations, key) && result.observations[key] !== null && typeof result.observations[key] !== "boolean") throw new Error(`Invalid ${key}`);
    for (const key of ["duplicate_answers", "answer_requests", "feedback_count"]) if (own(result.observations, key) && result.observations[key] !== null && (!Number.isSafeInteger(result.observations[key]) || result.observations[key] < 0)) throw new Error(`Invalid ${key}`);
    if (own(result.observations, "detail")) text(result.observations.detail, "observation detail");
    if (result.status === "pass" && (result.observations.input_lost === true || result.observations.duplicate_answers > 0 || result.observations.focus_preserved === false))
      throw new Error("A pass cannot report lost input/focus or duplicate answers");
    if (["pass", "fail"].includes(result.status) && ["sse-draft", "double-submit", "disconnect-before", "disconnect-after"].includes(definition.operation)) {
      if (typeof result.observations.input_lost !== "boolean" || !Number.isSafeInteger(result.observations.duplicate_answers) || !Number.isSafeInteger(result.observations.feedback_count))
        throw new Error("Critical answer routes require measured input loss, duplicates and feedback count");
      if (definition.operation !== "sse-draft" && !Number.isSafeInteger(result.observations.answer_requests)) throw new Error("Submit routes require measured answer request count");
    }
    if (result.status === "pass" && definition.surface === "Project dashboard" && definition.operation !== "api-regression") {
      const observations = result.observations;
      if (typeof observations.input_lost !== "boolean" ||
          !["duplicate_answers", "answer_requests", "feedback_count"].every(key => Number.isSafeInteger(observations[key])))
        throw new Error("Passing Project operations require measured input loss, duplicates, answer requests and feedback count");
      const submitted = ["answer", "keyboard", "double-submit", "disconnect-before", "disconnect-after"].includes(definition.operation);
      if (observations.feedback_count !== (submitted ? 1 : 0) || (submitted ? observations.answer_requests < 1 : observations.answer_requests !== 0))
        throw new Error("A pass requires one saved answer after submission, or no requests and no saved answers for an unsent draft");
      if (["sse-draft", "cancel"].includes(definition.operation) && observations.focus_preserved !== true)
        throw new Error("A pass requires measured focus preservation for this operation");
    }
  }
  return report;
}
export function reportRows(report) {
  validateReport(report);
  const results = new Map(report.results.map(result => [result.case_id, result]));
  return cases.map(definition => ({...definition, ...(results.get(definition.id) || {status:"not-run",reason:"この対象版で未実施"})}));
}
