import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { writeJson, stateHome } from "./state.mjs";
import {
  captureRelease,
  verifyRelease,
  releaseId,
  ReleaseError,
  readReleaseManifest,
  compatible,
} from "./release-artifacts.mjs";
import { qualifyRelease } from "./release-qualification.mjs";

const projectId = (id) => /^[a-f0-9]{16}$/.test(id || "");
const runId = (id) =>
  /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    id || "",
  );
const revision = (n) => Number.isSafeInteger(n) && n >= 0;
const time = (value) =>
  typeof value === "string" &&
  value.length <= 30 &&
  Number.isFinite(Date.parse(value));
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const selector = () => ({ revision: 0, default_release: null, history: [] });
function validate(value) {
  if (
    value?.schema !== 1 ||
    Object.keys(value).length !== 5 ||
    !revision(value.revision) ||
    !Array.isArray(value.releases) ||
    value.releases.length > 100 ||
    !Array.isArray(value.projects) ||
    value.projects.length > 5000 ||
    !Array.isArray(value.pins) ||
    value.pins.length > 10000
  )
    throw new ReleaseError("invalid_release_registry");
  const releases = new Set();
  for (const item of value.releases) {
    if (
      !object(item) ||
      Object.keys(item).length !== 5 ||
      !releaseId(item.release_id) ||
      releases.has(item.release_id) ||
      !["staged", "checking", "qualified", "failed"].includes(item.status) ||
      (item.canary_project !== null && !projectId(item.canary_project)) ||
      !Array.isArray(item.qualifications) ||
      item.qualifications.length > 100 ||
      (item.operation !== null && !/^[a-f0-9-]{36}$/.test(item.operation))
    )
      throw new ReleaseError("invalid_release_registry");
    if ((item.status === "checking") !== (item.operation !== null))
      throw new ReleaseError("invalid_release_registry");
    for (const q of item.qualifications) {
      if (
        !object(q) ||
        q.release_id !== item.release_id ||
        !projectId(q.project_id) ||
        !["passed", "failed"].includes(q.status) ||
        !["canary", "rollback"].includes(q.purpose) ||
        !time(q.checked_at) ||
        !object(q.checks) ||
        (q.status === "passed" &&
          (q.checks.start !== "acknowledged" ||
            q.checks.resume !== "same_native_id_acknowledged" ||
            q.checks.plugin_start !== "native_injection_observed" ||
            q.checks.plugin_resume !== "native_injection_observed" ||
            q.checks.stop !== "both_owned_exits_confirmed" ||
            q.cleanup !== "owned_exits_confirmed" ||
            q.authentication !== "not_verified" ||
            q.model_request !== "not_exercised" ||
            q.production_adoption !== "not_requested" ||
            typeof q.native_session_id !== "string" ||
            !q.native_session_id ||
            q.error !== null))
      )
        throw new ReleaseError("invalid_release_registry");
    }
    if (
      ["qualified", "failed"].includes(item.status) &&
      item.qualifications.at(-1)?.status !==
        (item.status === "qualified" ? "passed" : "failed")
    )
      throw new ReleaseError("invalid_release_registry");
    releases.add(item.release_id);
  }
  const projects = new Set();
  for (const item of value.projects) {
    if (
      !object(item) ||
      Object.keys(item).length !== 4 ||
      !projectId(item.project_id) ||
      projects.has(item.project_id) ||
      !revision(item.revision) ||
      !releases.has(item.default_release) ||
      !Array.isArray(item.history) ||
      item.history.length > 1000 ||
      item.history.length !== item.revision ||
      item.revision < 1
    )
      throw new ReleaseError("invalid_release_registry");
    let previous = null;
    for (const h of item.history) {
      if (
        !object(h) ||
        Object.keys(h).length !== 4 ||
        h.from !== previous ||
        !releases.has(h.to) ||
        h.to === h.from ||
        !time(h.at) ||
        ![
          "explicit_promotion",
          "canary_qualified",
          "rollback_requalified",
        ].includes(h.reason)
      )
        throw new ReleaseError("invalid_release_registry");
      previous = h.to;
    }
    if (previous !== item.default_release)
      throw new ReleaseError("invalid_release_registry");
    projects.add(item.project_id);
  }
  const pins = new Set();
  for (const pin of value.pins) {
    const key = pin.project_id + "/" + pin.run_id;
    if (
      !object(pin) ||
      Object.keys(pin).length !== 5 ||
      !projectId(pin.project_id) ||
      !runId(pin.run_id) ||
      pins.has(key) ||
      !releases.has(pin.release_id) ||
      !revision(pin.selection_revision) ||
      pin.selection_revision < 1 ||
      !time(pin.pinned_at) ||
      !projects.has(pin.project_id) ||
      pin.selection_revision >
        value.projects.find((p) => p.project_id === pin.project_id).revision
    )
      throw new ReleaseError("invalid_release_registry");
    pins.add(key);
  }
  return value;
}
export class Releases {
  constructor(home = path.join(stateHome(), "managed-releases")) {
    this.home = path.resolve(home);
    this.file = path.join(this.home, "registry.json");
    this.lock = path.join(this.home, "registry.lock");
  }
  async read() {
    let handle;
    try {
      handle = await fs.open(this.file, "r");
      if (
        !(await handle.stat()).isFile() ||
        (await handle.stat()).size > 4 * 1024 * 1024
      )
        throw new ReleaseError("invalid_release_registry");
      return validate(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (error.code === "ENOENT")
        return { schema: 1, revision: 0, releases: [], projects: [], pins: [] };
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError("invalid_release_registry");
    } finally {
      await handle?.close();
    }
  }
  async mutate(operation) {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fs.open(this.lock, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        throw new ReleaseError("release_registry_busy_wait");
      throw error;
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, owner: randomUUID() }),
      );
      const next = await this.read();
      const result = await operation(next);
      next.revision++;
      validate(next);
      if (Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024)
        throw new ReleaseError("release_registry_full");
      await writeJson(this.file, next);
      return structuredClone(result);
    } finally {
      await handle.close();
      await fs.unlink(this.lock);
    }
  }
  async stage(input) {
    const artifact = await captureRelease(this.home, input);
    await this.mutate((state) => {
      if (
        !state.releases.some(
          (r) => r.release_id === artifact.manifest.release_id,
        )
      )
        state.releases.push({
          release_id: artifact.manifest.release_id,
          status: "staged",
          canary_project: null,
          operation: null,
          qualifications: [],
        });
    });
    return artifact.manifest;
  }
  async inspect(project) {
    const state = await this.read();
    const selected =
      state.projects.find((p) => p.project_id === project.id) || selector();
    const releases = [];
    for (const item of state.releases) {
      let manifest;
      let compatibility = "artifact_manifest_unavailable_or_changed";
      try {
        ({ manifest } = await readReleaseManifest(this.home, item.release_id));
        compatibility = "incompatible_tuple_wait_for_compatible_runtime";
        compatible(manifest);
        compatibility = "supported_tuple_full_bytes_not_yet_checked";
      } catch {
        manifest ??= null;
      }
      releases.push({
        ...item,
        tuple: manifest?.tuple ?? null,
        changes: manifest?.changes ?? null,
        rollback: manifest?.rollback ?? null,
        provenance: manifest?.provenance ?? null,
        compatibility,
        integrity: "full_bytes_checked_on_launch_or_selection",
      });
    }
    return {
      project_id: project.id,
      selection: selected,
      releases,
      pins: state.pins.filter((p) => p.project_id === project.id),
      recovery:
        "Restore the exact missing/tampered slot or wait for a compatible runtime; a run pin is never migrated. Use release rollback with a prior release ID and current selection revision.",
      legacy_runs:
        "Unpinned runs retain their existing ledger command; no version guarantee is invented.",
    };
  }
  async verify(id) {
    if (!(await this.read()).releases.some((r) => r.release_id === id))
      throw new ReleaseError("release_not_staged");
    return verifyRelease(this.home, id);
  }
  async promote(project, id, expectedRevision) {
    await this.verify(id);
    return this.mutate((state) => {
      const release = state.releases.find((r) => r.release_id === id);
      if (
        release.status !== "qualified" ||
        release.operation !== null ||
        !release.qualifications.some((q) => q.status === "passed")
      )
        throw new ReleaseError("candidate_not_qualified_no_rollout");
      return this.select(
        state,
        project,
        id,
        expectedRevision,
        "explicit_promotion",
      );
    });
  }
  select(state, project, id, expectedRevision, reason) {
    let current = state.projects.find((p) => p.project_id === project.id);
    if (
      !revision(expectedRevision) ||
      (current?.revision ?? 0) !== expectedRevision
    )
      throw new ReleaseError("selection_changed_refresh_revision");
    if (!current) {
      current = { project_id: project.id, ...selector() };
      state.projects.push(current);
    }
    if (current.default_release === id)
      throw new ReleaseError("release_already_selected");
    current.history.push({
      from: current.default_release,
      to: id,
      reason,
      at: new Date().toISOString(),
    });
    current.default_release = id;
    current.revision++;
    return current;
  }
  async check(
    project,
    id,
    expectedRevision,
    { rollback = false, requestTimeout, stopTimeout } = {},
  ) {
    const operation = randomUUID();
    await this.mutate((state) => {
      const release = state.releases.find((r) => r.release_id === id);
      if (!release) throw new ReleaseError("release_not_staged");
      const selected =
        state.projects.find((p) => p.project_id === project.id) || selector();
      if (!revision(expectedRevision) || selected.revision !== expectedRevision)
        throw new ReleaseError("selection_changed_refresh_revision");
      if (selected.default_release === id)
        throw new ReleaseError("release_already_selected");
      if (release.operation !== null)
        throw new ReleaseError("qualification_running_wait");
      if (rollback) {
        if (
          !selected.history.some((h) => h.from === id) ||
          selected.default_release === id
        )
          throw new ReleaseError("previous_project_release_required");
      } else if (
        release.canary_project !== null &&
        release.canary_project !== project.id
      )
        throw new ReleaseError("candidate_is_reserved_for_one_canary_project");
      else release.canary_project = project.id;
      release.operation = operation;
      release.status = "checking";
    });
    let result;
    try {
      result = await qualifyRelease(await this.verify(id), project, {
        requestTimeout,
        stopTimeout,
      });
    } catch (error) {
      result = {
        status: "failed",
        release_id: id,
        project_id: project.id,
        checked_at: new Date().toISOString(),
        checks: {
          start: "not_dispatched",
          plugin_start: "not_dispatched",
          resume: "not_dispatched",
        },
        error:
          error instanceof ReleaseError
            ? error.code
            : "artifact_unavailable_wait_restore_pinned_bytes",
      };
    }
    return this.mutate((state) => {
      const release = state.releases.find((r) => r.release_id === id);
      if (release.operation !== operation)
        throw new ReleaseError("qualification_owner_changed");
      release.qualifications.push({
        ...result,
        purpose: rollback ? "rollback" : "canary",
      });
      release.operation = null;
      release.status = result.status === "passed" ? "qualified" : "failed";
      const selected =
        state.projects.find((p) => p.project_id === project.id) || selector();
      if (result.status !== "passed")
        return { qualification: result, selection: selected, changed: false };
      if (selected.revision !== expectedRevision)
        return {
          qualification: result,
          selection: selected,
          changed: false,
          waiting: "selection_changed_refresh_revision",
        };
      return {
        qualification: result,
        selection: this.select(
          state,
          project,
          id,
          expectedRevision,
          rollback ? "rollback_requalified" : "canary_qualified",
        ),
        changed: true,
      };
    });
  }
  async plan(project, run_id = null) {
    const state = await this.read();
    const selected = state.projects.find((p) => p.project_id === project.id);
    const pin =
      run_id === null
        ? null
        : state.pins.find(
            (p) => p.project_id === project.id && p.run_id === run_id,
          );
    if (run_id !== null && !pin) return null;
    if (run_id === null && !selected) return null;
    const id = pin?.release_id || selected.default_release;
    const release = state.releases.find((r) => r.release_id === id);
    if (!pin && (release.status !== "qualified" || release.operation !== null))
      throw new ReleaseError("candidate_not_qualified_new_runs_wait");
    return {
      ...(await this.verify(id)),
      pin,
      selection_revision: pin?.selection_revision ?? selected.revision,
    };
  }
  async attach(project, plan, options = {}) {
    const env = options.env || process.env;
    if (env.NODE_OPTIONS || env.NODE_PATH)
      throw new ReleaseError(
        "external_node_injection_wait_explicit_resolution",
      );
    if ((plan.pin?.run_id ?? null) !== (options.run_id ?? null))
      throw new ReleaseError("exact_run_pin_required");
    const artifact = await this.verify(plan.manifest.release_id);
    if (process.version !== artifact.manifest.tuple.node)
      throw new ReleaseError("adapter_runtime_changed_use_pinned_cli");
    const module = await import(
      pathToFileURL(
        path.join(artifact.slot, "adapter/dashboard/session-ledger.mjs"),
      ).href
    );
    const ledger = await module.SessionLedger.open(project);
    const attached = await module.attachRecordedSession({
      ...options,
      ledger,
      command: artifact.command,
      onRecord: async (record) => {
        await this.mutate((state) => {
          const old = state.pins.find(
            (p) => p.project_id === project.id && p.run_id === record.run_id,
          );
          if (options.run_id) {
            if (!old || old.release_id !== artifact.manifest.release_id)
              throw new ReleaseError("run_pin_changed");
            return;
          }
          const selected = state.projects.find(
            (p) => p.project_id === project.id,
          );
          const release = state.releases.find(
            (r) => r.release_id === artifact.manifest.release_id,
          );
          if (
            !selected ||
            selected.default_release !== artifact.manifest.release_id ||
            selected.revision !== plan.selection_revision
          )
            throw new ReleaseError("selection_changed_before_native_dispatch");
          if (release.status !== "qualified" || release.operation !== null)
            throw new ReleaseError("candidate_not_qualified_new_runs_wait");
          if (old) throw new ReleaseError("run_pin_immutable");
          state.pins.push({
            project_id: project.id,
            run_id: record.run_id,
            release_id: artifact.manifest.release_id,
            selection_revision: plan.selection_revision,
            pinned_at: new Date().toISOString(),
          });
        });
      },
    });
    return {
      ...attached,
      release: {
        release_id: artifact.manifest.release_id,
        tuple: artifact.manifest.tuple,
        selection_revision: plan.selection_revision,
        use: options.run_id ? "existing_run_pin" : "new_run_project_default",
      },
    };
  }
}
