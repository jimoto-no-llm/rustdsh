import { randomUUID, createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";
import { eventIdentifier } from "./annotation-identifiers.mjs";

const execFile = promisify(execFileCallback);
const MAX_NOTE_LENGTH = 1200;
const MAX_LINE_LENGTH = 400;
const EVENT_TYPES = new Set(["progress", "artifact", "note"]);
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export { eventIdentifier };

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function eventSnapshot(event) {
  return {
    sequence: event.sequence,
    type: event.type,
    title: event.title,
    detail: event.detail || "",
    artifact: event.artifact || "",
    created_at: event.created_at,
  };
}

function decisionSnapshot(state, question) {
  const contract = state.question_contracts?.cards?.[question.id];
  return {
    id: question.id,
    question: question.question,
    answer: question.answer,
    answered_at: question.answered_at || null,
    revision: contract?.revision ?? null,
    decision: contract?.snapshot?.decision ?? null,
  };
}

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} must be a non-empty string no longer than ${max} characters`);
  return value.trim();
}

function lineNumber(value, label = "line") {
  if (!Number.isInteger(value) || value < 1 || value > 1000000)
    throw new Error(`${label} must be a positive line number`);
  return value;
}

function splitLines(value) {
  if (!value) return [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function excerpt(value, maximum = MAX_LINE_LENGTH) {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

async function git(root, args, { maxBuffer = GIT_MAX_BUFFER } = {}) {
  const { stdout } = await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
  return stdout.trimEnd();
}

async function gitRaw(root, args, { maxBuffer = GIT_MAX_BUFFER } = {}) {
  const { stdout } = await execFile("git", ["-C", root, ...args], {
    encoding: null,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
  return stdout;
}

async function repositoryRoot(projectRoot) {
  const realProjectRoot = await fs.realpath(projectRoot);
  const realGitRoot = await fs.realpath(
    await git(realProjectRoot, ["rev-parse", "--show-toplevel"]),
  );
  const fromGitRoot = path.relative(realGitRoot, realProjectRoot);
  if (
    fromGitRoot === ".." ||
    fromGitRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromGitRoot)
  )
    throw new Error("Project directory is outside its Git repository");
  return { realProjectRoot, realGitRoot, projectPrefix: fromGitRoot };
}

function repoPathFor(projectPrefix, input) {
  const supplied = text(input, "path", 1000);
  if (
    supplied.includes("\\") ||
    supplied.includes("\0") ||
    /[\r\n]/.test(supplied) ||
    supplied.startsWith("/") ||
    /^[a-z]:/i.test(supplied)
  )
    throw new Error("path must be relative to this project and use forward slashes");
  const segments = supplied.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error("path must not contain empty, current, or parent segments");
  const prefix = projectPrefix.split(path.sep).filter(Boolean).join("/");
  return [prefix, ...segments].filter(Boolean).join("/");
}

async function createEventAnchor(state, input) {
  const id = text(input.event_id, "event_id", 200);
  const event = state.events.find((item) => eventIdentifier(item) === id);
  if (!event) throw new Error("The selected log event is no longer available");
  if (!EVENT_TYPES.has(event.type)) throw new Error("Unsupported log event type");
  const line = input.line === undefined || input.line === null || input.line === ""
    ? null
    : lineNumber(input.line);
  const detailLines = splitLines(event.detail || "");
  if (line !== null && line > detailLines.length)
    throw new Error("The selected log line is not present in this event");
  const targetText = line === null ? event.title : detailLines[line - 1];
  return {
    kind: "event",
    event_id: id,
    line,
    fingerprint: digest(eventSnapshot(event)),
    excerpt: excerpt(targetText || "(empty line)"),
    title: excerpt(event.title, 200),
    created_at: event.created_at,
  };
}

async function createDecisionAnchor(state, input) {
  const id = text(input.question_id, "question_id", 160);
  const question = state.questions.find(
    (item) => item.id === id && typeof item.answer === "string",
  );
  if (!question) throw new Error("Select an answered decision or conversation");
  const snapshot = decisionSnapshot(state, question);
  return {
    kind: "decision",
    question_id: id,
    revision: snapshot.revision,
    fingerprint: digest(snapshot),
    question_excerpt: excerpt(snapshot.question, 600),
    answer_excerpt: excerpt(snapshot.answer, 600),
    answered_at: snapshot.answered_at,
  };
}

async function createDiffAnchor(project, input) {
  const { realProjectRoot, realGitRoot, projectPrefix } = await repositoryRoot(
    project.root,
  );
  const commitInput = input.commit === undefined || input.commit === ""
    ? await git(realGitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
    : text(input.commit, "commit", 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitInput))
    throw new Error("commit must be a full 40- or 64-character Git object ID");
  const commit = await git(realGitRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commitInput}^{commit}`,
  ]);
  const repoPath = repoPathFor(projectPrefix, input.path);
  const blob = await git(realGitRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commit}:${repoPath}`,
  ]);
  const treeEntry = await git(realGitRoot, ["ls-tree", commit, "--", repoPath]);
  const mode = treeEntry.split(" ", 1)[0];
  if (!["100644", "100755"].includes(mode))
    throw new Error("The selected commit path is not a regular text file");
  const objectType = await git(realGitRoot, ["cat-file", "-t", blob]);
  if (objectType !== "blob") throw new Error("The selected commit path is not a file");
  const sourceBytes = await gitRaw(realGitRoot, ["cat-file", "blob", blob], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  if (source.includes("\0")) throw new Error("The selected commit path is not a text file");
  const line = lineNumber(input.line);
  const lines = splitLines(source);
  if (line > lines.length) throw new Error("The selected line is not present in this file version");
  const absolute = path.resolve(realGitRoot, ...repoPath.split("/"));
  const relative = path.relative(realProjectRoot, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("The selected path is outside this project");
  return {
    kind: "diff",
    commit,
    path: repoPath,
    line,
    blob,
    line_fingerprint: digest(lines[line - 1]),
    excerpt: excerpt(lines[line - 1]),
  };
}

function validateAnnotation(value) {
  const target = value?.target;
  const validFingerprint = (item) => /^[a-f0-9]{64}$/.test(item || "");
  const validLine = (item) => Number.isInteger(item) && item > 0;
  let validTarget = false;
  if (target?.kind === "event")
    validTarget =
      typeof target.event_id === "string" &&
      validFingerprint(target.fingerprint) &&
      (target.line === null || validLine(target.line)) &&
      typeof target.excerpt === "string" &&
      typeof target.title === "string";
  else if (target?.kind === "decision")
    validTarget =
      typeof target.question_id === "string" &&
      validFingerprint(target.fingerprint) &&
      (target.revision === null || Number.isInteger(target.revision)) &&
      typeof target.question_excerpt === "string" &&
      typeof target.answer_excerpt === "string";
  else if (target?.kind === "diff")
    validTarget =
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.commit || "") &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.blob || "") &&
      typeof target.path === "string" &&
      !target.path.includes("\\") &&
      !target.path.includes("\0") &&
      !/[\r\n]/.test(target.path) &&
      target.path.split("/").every((segment) => segment && segment !== "." && segment !== "..") &&
      validLine(target.line) &&
      validFingerprint(target.line_fingerprint) &&
      typeof target.excerpt === "string";
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    typeof value.task_id !== "string" ||
    typeof value.note !== "string" ||
    !value.id ||
    !value.task_id ||
    !value.note.trim() ||
    value.note.length > MAX_NOTE_LENGTH ||
    value.author !== "human" ||
    value.source !== "browser" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !validTarget
  )
    throw new Error("Corrupt human annotation record");
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class HumanAnnotationStore {
  constructor(project, value) {
    this.project = project;
    this.value = value;
    this.queue = Promise.resolve();
  }

  static async open(project) {
    const file = path.join(project.directory, "human-annotations.json");
    let value;
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      value = { schema: 1, project_id: project.id, revision: 0, annotations: [] };
    }
    if (
      value?.schema !== 1 ||
      value.project_id !== project.id ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.annotations)
    )
      throw new Error("Human annotations belong to a different project or version");
    for (const record of value.annotations) validateAnnotation(record);
    if (new Set(value.annotations.map((record) => record.id)).size !== value.annotations.length)
      throw new Error("Human annotation IDs are duplicated");
    return new HumanAnnotationStore(project, value);
  }

  serialize(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  add(input, state) {
    return this.serialize(async () => {
      const taskId = text(input.task_id, "task_id", 160);
      if (!state.tasks.some((task) => task.id === taskId))
        throw new Error("Select a task that is still present in this project");
      const note = text(input.note, "note", MAX_NOTE_LENGTH);
      let target;
      if (input.kind === "event") target = await createEventAnchor(state, input);
      else if (input.kind === "decision") target = await createDecisionAnchor(state, input);
      else if (input.kind === "diff") target = await createDiffAnchor(this.project, input);
      else throw new Error("Unknown annotation anchor type");
      const record = {
        id: randomUUID(),
        task_id: taskId,
        note,
        author: "human",
        source: "browser",
        created_at: new Date().toISOString(),
        target,
      };
      const next = structuredClone(this.value);
      next.revision++;
      next.annotations.push(record);
      await atomicWrite(path.join(this.project.directory, "human-annotations.json"), next);
      this.value = next;
      return structuredClone(record);
    });
  }

  remove(input) {
    return this.serialize(async () => {
      const id = text(input.id, "id", 80);
      const next = structuredClone(this.value);
      const index = next.annotations.findIndex((record) => record.id === id);
      if (index < 0) throw new Error("Human annotation not found");
      next.annotations.splice(index, 1);
      next.revision++;
      await atomicWrite(path.join(this.project.directory, "human-annotations.json"), next);
      this.value = next;
      return { removed: true, revision: next.revision };
    });
  }

  async inspect(state) {
    const annotations = await Promise.all(
      this.value.annotations.map(async (record) => ({
        ...structuredClone(record),
        reference_status: await referenceStatus(this.project, record, state),
      })),
    );
    let git_head = null;
    try {
      const { realGitRoot } = await repositoryRoot(this.project.root);
      git_head = await git(realGitRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {}
    return { revision: this.value.revision, git_head, annotations };
  }
}

async function referenceStatus(project, record, state) {
  const target = record.target;
  if (target.kind === "event") {
    const event = state.events.find((item) => eventIdentifier(item) === target.event_id);
    if (!event) return { code: "missing", label: "参照切れ・保持期限または削除" };
    return digest(eventSnapshot(event)) === target.fingerprint
      ? { code: "current", label: "現行のevent" }
      : { code: "changed", label: "旧版・event内容が変更" };
  }
  if (target.kind === "decision") {
    const question = state.questions.find((item) => item.id === target.question_id);
    if (!question || typeof question.answer !== "string")
      return { code: "missing", label: "参照切れ・決定記録がありません" };
    return digest(decisionSnapshot(state, question)) === target.fingerprint
      ? { code: "current", label: "現行の決定記録" }
      : { code: "changed", label: "旧版・決定内容が変更" };
  }
  let roots;
  try {
    roots = await repositoryRoot(project.root);
  } catch {
    return { code: "unknown", label: "参照状態を確認できません・Git repositoryが利用できません" };
  }
  const { realGitRoot } = roots;
  const pinnedBlob = await git(realGitRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${target.commit}:${target.path}`,
    ]).catch(() => null);
  if (!pinnedBlob || pinnedBlob !== target.blob)
    return { code: "missing", label: "参照切れ・固定したcommitを確認できません" };
  const absolute = path.resolve(realGitRoot, ...target.path.split("/"));
  const stats = await fs.lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") return null;
    return "unavailable";
  });
  if (stats === "unavailable")
    return { code: "unknown", label: "参照状態を確認できません・ファイルを読めません" };
  if (!stats?.isFile() || stats.isSymbolicLink())
    return { code: "missing", label: "参照切れ・現在のファイルがありません" };
  let head;
  try {
    head = await git(realGitRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    return { code: "unknown", label: "参照状態を確認できません・HEADを読めません" };
  }
  const currentBlob = await git(realGitRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${head}:${target.path}`,
  ]).catch(() => null);
  const dirty = await git(realGitRoot, [
    "status",
    "--porcelain",
    "--",
    `:(literal)${target.path}`,
  ]).catch(() => null);
  if (dirty === null)
    return { code: "unknown", label: "参照状態を確認できません・作業ツリーを読めません" };
  return currentBlob === target.blob && dirty === ""
    ? { code: "current", label: "固定したcommit・行と現行ファイルが一致" }
    : { code: "changed", label: "旧版・現行ファイルは別の内容" };
}
