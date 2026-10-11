import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const maxProjects = 32;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function counts(state) {
  const active = state.tasks.filter((task) => task.status === "doing").length;
  const waiting = state.tasks.filter((task) => task.status === "todo").length;
  const blocked = state.tasks.filter(
    (task) => task.status === "blocked",
  ).length;
  const unanswered = state.questions.filter(
    (question) => question.answer === null,
  ).length;
  const reviews = Object.values(state.instructions?.requests || {}).filter(
    (request) => request.status === "review_required",
  ).length;
  return { active, waiting, needs_attention: blocked + unanswered + reviews };
}

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

function validCache(value) {
  return (
    value?.schema === 1 &&
    value.entries &&
    typeof value.entries === "object" &&
    !Array.isArray(value.entries)
  );
}

async function readCache(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!validCache(value)) return {};
    return value.entries;
  } catch {
    return {};
  }
}

async function writeCache(file, entries) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, entries }), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function alive(pid, processApi) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function detailUrl(project, processApi) {
  try {
    const runtime = JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
    const lockedPid = Number(
      await fs.readFile(path.join(project.directory, "server.lock"), "utf8"),
    );
    if (
      runtime.kind !== "project" ||
      runtime.project_id !== project.id ||
      lockedPid !== runtime.pid ||
      !alive(runtime.pid, processApi) ||
      typeof runtime.local_url !== "string" ||
      typeof runtime.browser_url !== "string"
    )
      return null;
    const local = new URL(runtime.local_url);
    const browser = new URL(runtime.browser_url);
    if (
      local.protocol !== "http:" ||
      !loopbackHosts.has(local.hostname) ||
      browser.origin !== local.origin ||
      browser.pathname !== "/" ||
      browser.search !== "" ||
      !/^#key=[0-9a-f]{64}$/.test(browser.hash)
    )
      return null;
    // A remote phone cannot open this PC's loopback address. If the project
    // already has a private Tailscale Serve URL, reuse it without changing the
    // per-project browser credential or route.
    try {
      const share = new URL(runtime.share?.url);
      if (
        share.protocol === "https:" &&
        share.hostname.endsWith(".ts.net") &&
        !share.username &&
        !share.password
      ) {
        browser.host = share.host;
        browser.protocol = share.protocol;
      }
    } catch {
      // Local-only dashboards retain their loopback detail link.
    }
    // A summary grant does not grant access to project details. The link opens
    // the owning dashboard without its bearer key; that origin must already
    // have its own human session.
    browser.hash = "";
    return browser.href;
  } catch {
    return null;
  }
}

export async function projectDashboardUrl(
  project,
  processApi = process,
  fragment = "",
) {
  if (
    fragment &&
    !/^(?:task|question|event)-[A-Za-z0-9._~%-]{1,2048}$/.test(fragment)
  )
    return null;
  const href = await detailUrl(project, processApi);
  if (!href) return null;
  const url = new URL(href);
  url.hash = fragment ? `#${fragment}` : "";
  return url.href;
}

export function createProjectCrossOverview(
  projects,
  cacheFile,
  { now = Date.now, processApi = process, readState } = {},
) {
  if (
    !Array.isArray(projects) ||
    projects.length < 2 ||
    projects.length > maxProjects ||
    projects.some((project) => !validProject(project)) ||
    new Set(projects.map((project) => project.id)).size !== projects.length
  )
    throw new Error("Cross-project overview requires 2–32 distinct projects");
  if (typeof cacheFile !== "string" || !path.isAbsolute(cacheFile))
    throw new Error("Cross-project overview cache path must be absolute");
  const allowlisted = projects.map((project) => ({
    id: project.id,
    name: project.name,
    root: project.root,
    directory: project.directory,
  }));

  let queue = Promise.resolve();
  async function snapshot() {
    const previous = await readCache(cacheFile);
    const nextCache = Object.create(null);
    const observedAt = new Date(now()).toISOString();
    const rows = await Promise.all(
      allowlisted.map(async (project) => {
        let summary;
        try {
          const state = readState
            ? await readState(project)
            : JSON.parse(
                await fs.readFile(
                  path.join(project.directory, "state.json"),
                  "utf8",
                ),
              );
          if (
            state.schema !== 1 ||
            state.project?.id !== project.id ||
            !Array.isArray(state.tasks) ||
            !Array.isArray(state.questions)
          )
            throw new Error("Project state is unavailable");
          summary = counts(state);
        } catch {
          const cached = previous[project.id];
          if (cached && typeof cached.last_observed_at === "string")
            nextCache[project.id] = cached;
          return {
            project_id: project.id,
            name: project.name,
            status: "unknown",
            last_observed_at:
              typeof cached?.last_observed_at === "string"
                ? cached.last_observed_at
                : null,
            counts: null,
            detail_url: null,
          };
        }
        nextCache[project.id] = { last_observed_at: observedAt };
        return {
          name: project.name,
          status: "observed",
          last_observed_at: observedAt,
          counts: summary,
          project_id: project.id,
          detail_url: await projectDashboardUrl(project, processApi),
        };
      }),
    );
    await writeCache(cacheFile, nextCache).catch(() => {});
    return { observed_at: observedAt, projects: rows };
  }

  return {
    snapshot() {
      const current = queue.then(snapshot, snapshot);
      queue = current.catch(() => {});
      return current;
    },
  };
}
