import fs from "node:fs/promises";
import path from "node:path";
import { projectDashboardUrl } from "./project-cross-overview.mjs";

const maxProjects = 32;
const maxQueryLength = 160;
const maxTerms = 10;
const maxResults = 100;
const maxSnippetLength = 240;
const kinds = new Set(["task", "decision", "log", "artifact"]);

function validProject(project) {
  return (
    project &&
    typeof project.id === "string" &&
    /^[0-9a-f]{16}$/.test(project.id) &&
    typeof project.name === "string" &&
    project.name.length > 0 &&
    typeof project.root === "string" &&
    typeof project.directory === "string"
  );
}

function within(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function termsFor(query) {
  if (typeof query !== "string" || query.length > maxQueryLength)
    throw new Error("Search query must be at most 160 characters");
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error("Enter a search term");
  if (terms.length > maxTerms)
    throw new Error("Search supports up to 10 terms");
  return terms.map((term) => term.toLowerCase());
}

function dateValue(value, field, end = false) {
  if (value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return end ? time + 24 * 60 * 60 * 1000 : time;
}

function safeText(value, maximum = 12000) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function includesTerms(text, terms) {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function snippetFor(text, terms) {
  const normalized = text.toLowerCase();
  const positions = terms
    .map((term) => normalized.indexOf(term))
    .filter((position) => position >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - Math.floor(maxSnippetLength / 3));
  const end = Math.min(text.length, start + maxSnippetLength);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}

function recordTime(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function matchesDate(time, since, until) {
  if (since === null && until === null) return true;
  if (!time) return false;
  const value = Date.parse(time);
  return (since === null || value >= since) && (until === null || value < until);
}

function referenceMetadata(raw, project) {
  const value = safeText(raw, 2000).trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value))
    return { display: "", status: "unknown" };

  const windowsAbsolute = path.win32.isAbsolute(value);
  if (windowsAbsolute && process.platform !== "win32")
    return { display: "", status: "unknown" };

  if (!windowsAbsolute && /^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol))
        return { display: "", status: "unknown" };
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return {
        display: `${url.host}${url.pathname}`.slice(0, 1000),
        status: "external",
      };
    } catch {
      return { display: "", status: "unknown" };
    }
  }

  const root = path.resolve(project.root);
  const target = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, value);
  if (!within(root, target))
    return { display: "", status: "unknown" };

  const relative = path.relative(root, target).split(path.sep).join("/");
  const display = (relative || ".").slice(0, 1000);
  return { display, status: "pending", root, target };
}

async function checkedReference(raw, project) {
  const reference = referenceMetadata(raw, project);
  if (reference.status !== "pending") return reference;
  try {
    const [root, realTarget] = await Promise.all([
      fs.realpath(reference.root),
      fs.realpath(reference.target),
    ]);
    if (!within(root, realTarget))
      return { display: reference.display, status: "unknown" };
    const stat = await fs.stat(realTarget);
    return {
      display: reference.display,
      status: stat.isFile() ? "available" : "unknown",
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      return { display: reference.display, status: "stale" };
    return { display: reference.display, status: "unknown" };
  }
}

function anchorFor(kind, recordId) {
  const prefix =
    kind === "task" ? "task-" : kind === "decision" ? "question-" : "event-";
  return `${prefix}${encodeURIComponent(recordId)}`;
}

function recordCandidates(state) {
  const records = [];
  for (const task of state.tasks || []) {
    if (!task || typeof task.id !== "string") continue;
    const text = [
      safeText(task.title),
      safeText(task.status, 80),
      safeText(task.milestone, 1000),
      safeText(task.blocker, 2000),
    ]
      .filter(Boolean)
      .join(" · ");
    records.push({
      kind: "task",
      id: task.id,
      title: safeText(task.title, 1000) || task.id,
      text,
      at: task.updated_at,
      scope: "record_text",
    });
  }
  for (const question of state.questions || []) {
    if (!question || typeof question.id !== "string") continue;
    const text = [
      safeText(question.question),
      safeText(question.answer),
      safeText(question.default_action, 2000),
    ]
      .filter(Boolean)
      .join(" · ");
    records.push({
      kind: "decision",
      id: question.id,
      title: safeText(question.question, 1000) || question.id,
      text,
      at: question.answered_at || question.created_at,
      scope: "record_text",
    });
  }
  for (const event of state.events || []) {
    if (!event || !Number.isSafeInteger(event.sequence)) continue;
    const isArtifact = event.type === "artifact" || Boolean(event.artifact);
    records.push({
      kind: isArtifact ? "artifact" : "log",
      id: String(event.sequence),
      title: safeText(event.title, 1000) || `event ${event.sequence}`,
      text: isArtifact
        ? safeText(event.title, 1000)
        : [safeText(event.title, 1000), safeText(event.detail)]
            .filter(Boolean)
            .join(" · "),
      artifact: isArtifact ? event.artifact : null,
      at: event.created_at,
      scope: isArtifact ? "reference_only" : "record_text",
    });
  }
  return records;
}

export function createProjectCrossSearch(
  projects,
  { processApi = process, readState } = {},
) {
  if (
    !Array.isArray(projects) ||
    projects.length < 2 ||
    projects.length > maxProjects ||
    projects.some((project) => !validProject(project)) ||
    new Set(projects.map((project) => project.id)).size !== projects.length
  )
    throw new Error("Cross-project search requires 2–32 distinct projects");

  const allowlisted = projects.map((project) => ({ ...project }));
  const links = new Map();

  async function sourceUrl(project, kind, id) {
    if (!links.has(project.id))
      links.set(project.id, projectDashboardUrl(project, processApi));
    const base = await links.get(project.id);
    if (!base) return null;
    const url = new URL(base);
    url.hash = `#${anchorFor(kind, id)}`;
    return url.href;
  }

  async function load(project) {
    try {
      const value = readState
        ? await readState(project)
        : JSON.parse(
            await fs.readFile(path.join(project.directory, "state.json"), "utf8"),
          );
      if (
        value?.schema !== 1 ||
        value.project?.id !== project.id ||
        (value.tasks !== undefined && !Array.isArray(value.tasks)) ||
        (value.questions !== undefined && !Array.isArray(value.questions)) ||
        (value.events !== undefined && !Array.isArray(value.events))
      )
        throw new Error("Project state is unavailable");
      return {
        state: {
          ...value,
          tasks: value.tasks || [],
          questions: value.questions || [],
          events: value.events || [],
        },
        status: "observed",
      };
    } catch {
      return { state: null, status: "unknown" };
    }
  }

  async function search(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Search filters must be an object");
    const terms = termsFor(input.query);
    const kind = input.kind || "all";
    if (kind !== "all" && !kinds.has(kind))
      throw new Error("Unknown search kind");
    const selected = input.project_ids;
    if (
      selected !== undefined &&
      (!Array.isArray(selected) ||
        selected.length > maxProjects ||
        selected.some(
          (id) => typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id),
        ))
    )
      throw new Error("project_ids must contain at most 32 project IDs");
    const projectIds = selected ? new Set(selected) : null;
    const since = dateValue(input.since, "since");
    const until = dateValue(input.until, "until", true);
    if (since !== null && until !== null && since >= until)
      throw new Error("since must be on or before until");
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxResults)
      throw new Error("limit must be an integer from 1 to 100");

    const projectsToSearch = allowlisted.filter(
      (project) => !projectIds || projectIds.has(project.id),
    );
    const loaded = await Promise.all(
      projectsToSearch.map(async (project) => ({
        project,
        ...(await load(project)),
      })),
    );
    const unavailable = loaded
      .filter((entry) => entry.status !== "observed")
      .map(({ project }) => ({ project_id: project.id, name: project.name }));
    const results = [];

    for (const { project, state } of loaded) {
      if (!state) continue;
      for (const record of recordCandidates(state)) {
        if (kind !== "all" && record.kind !== kind) continue;
        const time = recordTime(record.at);
        if (!matchesDate(time, since, until)) continue;
        let text = record.text;
        let referenceStatus = null;
        let reference = null;
        if (record.kind === "artifact") {
          reference = referenceMetadata(record.artifact, project);
          referenceStatus = reference.status;
          text = [text, reference.display].filter(Boolean).join(" · ");
        }
        if (!includesTerms(text, terms)) continue;
        if (reference?.status === "pending") {
          const checked = await checkedReference(record.artifact, project);
          referenceStatus = checked.status;
        }
        results.push({
          project_id: project.id,
          project_name: project.name,
          kind: record.kind,
          source: `${record.kind}:${record.id}`,
          record_id: record.id,
          title: record.title,
          snippet: snippetFor(text, terms),
          time,
          search_scope: record.scope,
          ...(referenceStatus ? { reference_status: referenceStatus } : {}),
          source_url: await sourceUrl(project, record.kind, record.id),
        });
      }
    }

    results.sort((a, b) => {
      const time =
        (Date.parse(b.time || "") || 0) - (Date.parse(a.time || "") || 0);
      return (
        time ||
        a.project_name.localeCompare(b.project_name) ||
        a.record_id.localeCompare(b.record_id)
      );
    });
    return {
      results: results.slice(0, limit),
      matched_count: results.length,
      truncated: results.length > limit,
      unavailable_projects: unavailable,
    };
  }

  return { search };
}
