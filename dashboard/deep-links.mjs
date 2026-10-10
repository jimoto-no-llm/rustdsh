const kinds = new Set(["task", "question", "session", "event"]);
const urlFields = ["rdsh_project", "rdsh_kind", "rdsh_id"];
const storageKey = "rdsh_pending_project_deep_link_v1";
const storageTtlMs = 10 * 60 * 1000;

function validText(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value;
}

function validTarget(value) {
  try {
    if (!value || value.status !== "target") throw new Error("Invalid target");
    const projectId = validText(value.projectId, "project id", 160);
    const kind = validText(value.kind, "target kind", 16);
    const id = validText(value.id, "target id");
    if (!kinds.has(kind)) throw new Error("Unknown target kind");
    const runId = value.runId === undefined
      ? undefined
      : validText(value.runId, "run id", 256);
    if (kind === "session" && !runId) throw new Error("Session links require a run id");
    if (kind !== "session" && runId !== undefined) throw new Error("Unexpected run id");
    return {
      status: "target",
      projectId,
      kind,
      id,
      ...(runId ? { runId } : {}),
    };
  } catch {
    return null;
  }
}

export function createProjectDeepLink(href, projectId, kind, id, runId) {
  const value = validTarget({
    status: "target",
    projectId,
    kind,
    id,
    ...(runId === undefined ? {} : { runId }),
  });
  if (!value) throw new Error("Unsupported project deep link");
  const url = new URL(href);
  // Deep links are navigation hints. Never copy auth fragments, query tokens,
  // or unrelated parameters from the current browser address.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.searchParams.set("rdsh_project", value.projectId);
  url.searchParams.set("rdsh_kind", value.kind);
  url.searchParams.set("rdsh_id", value.id);
  if (value.runId) url.searchParams.set("rdsh_run", value.runId);
  return url.href;
}

export function parseProjectDeepLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return { status: "invalid" };
  }
  const params = url.searchParams;
  if (![...urlFields, "rdsh_run"].some((key) => params.has(key)))
    return { status: "none" };
  if ([...urlFields, "rdsh_run"].some((key) => params.getAll(key).length > 1))
    return { status: "invalid" };
  return validTarget({
    status: "target",
    projectId: params.get("rdsh_project"),
    kind: params.get("rdsh_kind"),
    id: params.get("rdsh_id"),
    ...(params.has("rdsh_run") ? { runId: params.get("rdsh_run") } : {}),
  }) || { status: "invalid" };
}

export function resolveProjectDeepLink(target, state) {
  const value = validTarget(target);
  if (!value) return { status: "invalid" };
  if (state?.project?.id !== value.projectId) return { status: "wrong_project" };
  if (value.kind === "task") {
    const item = state.tasks?.find((candidate) => candidate.id === value.id);
    return item
      ? {
          status: "found",
          kind: value.kind,
          id: value.id,
          elementId: `task-${item.id}`,
        }
      : { status: "not_found", kind: value.kind };
  }
  if (value.kind === "question") {
    const item = state.questions?.find((candidate) => candidate.id === value.id);
    return item
      ? {
          status: "found",
          kind: value.kind,
          id: value.id,
          elementId: `question-${item.id}`,
        }
      : { status: "not_found", kind: value.kind };
  }
  if (value.kind === "event") {
    const item = state.events?.find((candidate) => String(candidate.sequence) === value.id);
    return item
      ? {
          status: "found",
          kind: value.kind,
          id: value.id,
          elementId: `event-${item.sequence}`,
        }
      : { status: "not_found", kind: value.kind };
  }
  const matches = Object.values(state.answer_applications?.consumers || {}).filter(
    (consumer) => consumer.session_id === value.id && consumer.run_id === value.runId,
  );
  if (matches.length !== 1) return { status: matches.length ? "ambiguous" : "not_found", kind: value.kind };
  return { status: "found", kind: value.kind, id: value.id, consumerId: matches[0].consumer_id };
}

export function rememberProjectDeepLink(storage, target, now = Date.now()) {
  const value = validTarget(target);
  if (!value) return false;
  try {
    storage.setItem(storageKey, JSON.stringify({ target: value, expiresAt: now + storageTtlMs }));
    return true;
  } catch {
    return false;
  }
}

export function pendingProjectDeepLink(storage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(storageKey) || "null");
    if (!saved || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= now) {
      storage.removeItem(storageKey);
      return { status: "none" };
    }
    return validTarget(saved.target) || { status: "none" };
  } catch {
    return { status: "none" };
  }
}

export function clearPendingProjectDeepLink(storage) {
  try {
    storage.removeItem(storageKey);
  } catch {}
}

export function clearProjectDeepLinkUrl(href) {
  const url = new URL(href, "http://rdsh.invalid");
  for (const key of [...urlFields, "rdsh_run"]) url.searchParams.delete(key);
  for (const key of [...url.searchParams.keys()])
    if (/^(?:key|token|auth|secret)$/i.test(key)) url.searchParams.delete(key);
  return url.pathname + url.search + url.hash;
}
