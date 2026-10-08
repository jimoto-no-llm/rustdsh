// Run-scoped assertions and operator-authorized changes; no native route mutation.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  routeHash,
  routeCheck as check,
  exactRouteObject as exact,
  RoutingError,
  validSelection,
  selected,
  sameSelection,
  compareSelection,
} from "./model-selection.mjs";

const runId = (value) =>
  typeof value === "string" && /^run_[0-9a-f-]{36}$/.test(value);
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const contextHash = (record) =>
  routeHash({
    project_id: record.project_id,
    run_id: record.run_id,
    session_id: record.cli_session_id,
    cwd: record.cwd,
    branch: record.branch,
    launch: record.launch,
    scope: record.scope,
  });
const provenance = (value) =>
  exact(value, ["source", "role", "effort_source", "warning", "source_hash"]) &&
  [
    "explicit_operator_request",
    "parent_request",
    "environment",
    "persisted_role",
  ].includes(value.source) &&
  (value.role === null ||
    ["scout", "worker", "reviewer", "architect"].includes(value.role)) &&
  [
    "explicit",
    "parent_request",
    "environment",
    "persisted_role",
    "provider_default_unverified",
  ].includes(value.effort_source) &&
  (value.warning === null ||
    value.warning === "partial_environment_suppressed_saved_route") &&
  digest(value.source_hash);
const observed = (value) =>
  exact(value, [
    "status",
    "selection",
    "reason",
    "source",
    "cli_version",
    "observed_at",
    "actual_execution_verified",
  ]) &&
  ["unknown", "observed"].includes(value.status) &&
  (value.selection === null || validSelection(value.selection)) &&
  (value.reason === null || identifier(value.reason)) &&
  [
    "acp_session_new",
    "acp_session_resume",
    "acp_config_update",
    "native_selection_unavailable",
  ].includes(value.source) &&
  (value.cli_version === null ||
    (typeof value.cli_version === "string" &&
      value.cli_version.length <= 80)) &&
  timestamp(value.observed_at) &&
  value.actual_execution_verified === false;
function permit(value) {
  check(
    exact(value, [
      "authorization_id",
      "source",
      "run_id",
      "session_id",
      "context_hash",
      "from",
      "to",
      "request_revision",
      "issued_at",
      "expires_at",
    ]) &&
      identifier(value.authorization_id) &&
      value.source === "explicit_operator_cli" &&
      runId(value.run_id) &&
      typeof value.session_id === "string" &&
      value.session_id.length > 0 &&
      value.session_id.length <= 256 &&
      digest(value.context_hash) &&
      validSelection(value.from) &&
      validSelection(value.to) &&
      Number.isSafeInteger(value.request_revision) &&
      value.request_revision >= 1 &&
      timestamp(value.issued_at) &&
      timestamp(value.expires_at),
    "invalid_route_authorization",
  );
  return value;
}
function validate(value, project, record) {
  check(
    exact(value, [
      "schema",
      "project_id",
      "run_id",
      "session_id",
      "context_hash",
      "revision",
      "requested",
      "active_route",
      "provenance",
      "active_authorization",
      "events",
      "record_hash",
    ]) &&
      value.schema === 1 &&
      value.project_id === project.id &&
      value.run_id === record.run_id &&
      value.session_id === record.cli_session_id &&
      value.context_hash === contextHash(record) &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 1 &&
      validSelection(value.requested) &&
      validSelection(value.active_route) &&
      provenance(value.provenance) &&
      (value.active_authorization === null ||
        permit(value.active_authorization)) &&
      Array.isArray(value.events) &&
      value.events.length > 0 &&
      value.events.length <= 500 &&
      digest(value.record_hash),
    "invalid_route_policy",
  );
  const eventIds = new Set();
  const authorizationIds = new Set();
  let active = value.requested;
  for (const [index, event] of value.events.entries()) {
    check(
      exact(event, [
        "sequence",
        "event_id",
        "type",
        "at",
        "observation",
        "authorization",
      ]) &&
        event.sequence === index + 1 &&
        identifier(event.event_id) &&
        !eventIds.has(event.event_id) &&
        [
          "request_bound",
          "native_selection_observed",
          "change_authorized",
        ].includes(event.type) &&
        timestamp(event.at) &&
        (event.observation === null || observed(event.observation)) &&
        (event.authorization === null || permit(event.authorization)),
      "invalid_route_history",
    );
    eventIds.add(event.event_id);
    if (event.type === "request_bound")
      check(
        index === 0 &&
          event.observation === null &&
          event.authorization === null,
        "invalid_route_history",
      );
    else if (event.type === "native_selection_observed")
      check(
        event.observation !== null && event.authorization === null,
        "invalid_route_history",
      );
    else {
      const auth = event.authorization;
      check(
        auth !== null &&
          event.observation === null &&
          auth.run_id === value.run_id &&
          auth.session_id === value.session_id &&
          auth.context_hash === value.context_hash &&
          sameSelection(auth.from, active) &&
          !authorizationIds.has(auth.authorization_id),
        "invalid_route_history",
      );
      authorizationIds.add(auth.authorization_id);
      active = auth.to;
    }
  }
  check(
    value.events[0].type === "request_bound" &&
      value.revision === value.events.length &&
      sameSelection(active, value.active_route),
    "invalid_route_history",
  );
  const { record_hash, ...body } = value;
  check(routeHash(body) === record_hash, "route_policy_checksum_mismatch");
  const approvals = value.events.filter(
    (event) => event.type === "change_authorized",
  );
  if (value.active_authorization === null)
    check(
      approvals.length === 0 &&
        sameSelection(value.requested, value.active_route),
      "invalid_route_history",
    );
  else
    check(
      approvals.length > 0 &&
        routeHash(approvals.at(-1).authorization) ===
          routeHash(value.active_authorization) &&
        sameSelection(value.active_authorization.to, value.active_route),
      "invalid_route_history",
    );
  return value;
}
export class ModelRouting {
  constructor(project) {
    this.project = { ...project };
    this.directory = path.join(project.directory, "model-routing");
  }
  static open(project) {
    check(
      project &&
        typeof project.id === "string" &&
        path.isAbsolute(project.directory),
      "invalid_routing_project",
    );
    return new ModelRouting(project);
  }
  file(record) {
    check(
      runId(record.run_id) &&
        record.project_id === this.project.id &&
        record.binding === "confirmed" &&
        record.cli === "dsh" &&
        typeof record.cli_session_id === "string",
      "confirmed_run_required",
    );
    return path.join(this.directory, record.run_id + ".json");
  }
  async required(record) {
    let handle;
    try {
      handle = await fs.open(this.file(record) + ".required", "r");
      check(
        (await handle.stat()).isFile() && (await handle.stat()).size <= 2048,
        "route_requirement_unconfirmed",
      );
      const bytes = await handle.readFile();
      check(bytes.length <= 2048, "route_requirement_unconfirmed");
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      check(
        exact(value, ["schema", "context_hash", "requested_hash"]) &&
          value.schema === 1 &&
          value.context_hash === contextHash(record) &&
          digest(value.requested_hash),
        "route_requirement_unconfirmed",
      );
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("route_requirement_unconfirmed");
    } finally {
      await handle?.close();
    }
  }
  async read(record) {
    const file = this.file(record);
    let handle;
    try {
      handle = await fs.open(file, "r");
      check(
        (await handle.stat()).isFile() &&
          (await handle.stat()).size <= 512 * 1024,
        "route_policy_too_large",
      );
      const bytes = await handle.readFile();
      check(bytes.length <= 512 * 1024, "route_policy_too_large");
      const value = validate(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.project,
        record,
      );
      const required = await this.required(record);
      check(
        required !== null &&
          required.requested_hash === routeHash(value.requested),
        "route_requirement_unconfirmed",
      );
      return value;
    } catch (error) {
      if (error.code === "ENOENT") {
        check((await this.required(record)) === null, "route_policy_missing");
        return null;
      }
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("route_policy_unreadable");
    } finally {
      await handle?.close();
    }
  }
  async mutate(record, operation) {
    const file = this.file(record),
      owner = randomUUID(),
      lock = file + ".lock";
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fs.open(lock, "wx", 0o600);
    } catch (error) {
      throw new RoutingError(
        error.code === "EEXIST"
          ? "route_policy_busy"
          : "route_lock_unavailable",
      );
    }
    try {
      await handle.writeFile(owner);
      await handle.sync();
      const { value, result } = await operation(await this.read(record));
      const { record_hash: ignored, ...body } = value;
      value.record_hash = routeHash(body);
      validate(value, this.project, record);
      const bytes = JSON.stringify(value, null, 2) + "\n";
      check(Buffer.byteLength(bytes) <= 512 * 1024, "route_policy_too_large");
      const temporary = file + "." + randomUUID() + ".tmp",
        writer = await fs.open(temporary, "wx", 0o600);
      try {
        await writer.writeFile(bytes);
        await writer.sync();
      } finally {
        await writer.close();
      }
      await fs.rename(temporary, file);
      return result;
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("route_write_unconfirmed");
    } finally {
      await handle.close();
      try {
        check(
          (await fs.readFile(lock, "utf8")) === owner,
          "route_lock_changed",
        );
        await fs.unlink(lock);
      } catch {
        throw new RoutingError("route_lock_cleanup_unconfirmed");
      }
    }
  }
  event(value, type, observation = null, authorization = null) {
    check(value.events.length < 500, "route_history_full");
    value.events.push({
      sequence: value.events.length + 1,
      event_id: "route_" + randomUUID(),
      type,
      at: new Date().toISOString(),
      observation,
      authorization,
    });
  }
  async bind(record, request) {
    check(
      exact(request, ["selection", "provenance"]) &&
        validSelection(request.selection) &&
        provenance(request.provenance),
      "invalid_routing_request",
    );
    return this.mutate(record, async (prior) => {
      check(prior === null, "route_request_immutable");
      const value = {
        schema: 1,
        project_id: this.project.id,
        run_id: record.run_id,
        session_id: record.cli_session_id,
        context_hash: contextHash(record),
        revision: 1,
        requested: selected(request.selection),
        active_route: selected(request.selection),
        provenance: structuredClone(request.provenance),
        active_authorization: null,
        events: [],
        record_hash: "0".repeat(64),
      };
      const required = await fs.open(
        this.file(record) + ".required",
        "wx",
        0o600,
      );
      try {
        await required.writeFile(
          JSON.stringify({
            schema: 1,
            context_hash: value.context_hash,
            requested_hash: routeHash(value.requested),
          }) + "\n",
        );
        await required.sync();
      } finally {
        await required.close();
      }
      this.event(value, "request_bound");
      return {
        value,
        result: {
          run_id: record.run_id,
          requested: value.requested,
          context_hash: value.context_hash,
          revision: value.revision,
          permission_expanded: false,
          native_route_changed: false,
        },
      };
    });
  }
  async allowChange(record, target, authorization) {
    target = selected(target);
    authorization = structuredClone(permit(authorization));
    return this.mutate(record, (value) => {
      check(value !== null, "route_request_not_bound");
      const now = Date.now();
      check(
        authorization.run_id === value.run_id &&
          authorization.session_id === value.session_id &&
          authorization.context_hash === value.context_hash &&
          authorization.request_revision === value.revision &&
          sameSelection(authorization.from, value.active_route) &&
          sameSelection(authorization.to, target) &&
          Date.parse(authorization.issued_at) <= now &&
          Date.parse(authorization.expires_at) > now &&
          Date.parse(authorization.expires_at) -
            Date.parse(authorization.issued_at) <=
            86400000,
        "route_authorization_scope_or_time_mismatch",
      );
      check(
        !value.events.some(
          (event) =>
            event.authorization?.authorization_id ===
            authorization.authorization_id,
        ),
        "route_authorization_already_recorded",
      );
      value.active_route = target;
      value.active_authorization = authorization;
      value.revision++;
      this.event(value, "change_authorized", null, authorization);
      return {
        value,
        result: {
          run_id: record.run_id,
          requested: value.requested,
          active_route: target,
          authorization,
          revision: value.revision,
          permission_expanded: false,
          native_route_changed: false,
        },
      };
    });
  }
  async observe(record, adapter) {
    const observation = adapter.routing(record.cli_session_id);
    check(observed(observation), "native_route_observation_invalid");
    return this.mutate(record, (value) => {
      check(value !== null, "route_request_not_bound");
      this.event(
        value,
        "native_selection_observed",
        structuredClone(observation),
      );
      value.revision++;
      return { value, result: this.view(value, observation) };
    });
  }
  view(value, observation) {
    const expired =
      value.active_authorization !== null &&
      Date.parse(value.active_authorization.expires_at) <= Date.now();
    const comparison = compareSelection(value.active_route, observation);
    return {
      run_id: value.run_id,
      session_id: value.session_id,
      context_hash: value.context_hash,
      revision: value.revision,
      requested: value.requested,
      active_route: value.active_route,
      provenance: value.provenance,
      observation,
      comparison,
      active_authorization: value.active_authorization,
      authorization_expired: expired,
      prompt_allowed_by_route_assertion: comparison.matches && !expired,
      actual_model_execution_verified: false,
      permission_expanded: false,
      native_route_changed: false,
    };
  }
  async inspect(record) {
    const value = await this.read(record);
    let writer_lock = "unknown";
    try {
      await fs.lstat(this.file(record) + ".lock");
      writer_lock = "present";
    } catch (error) {
      if (error.code === "ENOENT") writer_lock = "absent";
    }
    if (value === null)
      return {
        run_id: record.run_id,
        route_required: false,
        actual_model_execution_verified: false,
        writer_lock,
      };
    const observation =
      value.events.findLast((event) => event.observation !== null)
        ?.observation ?? null;
    return {
      ...this.view(value, observation),
      route_required: true,
      observation_is_historical: true,
      events: value.events,
      writer_lock,
    };
  }
  async guard(record, adapter) {
    if ((await this.read(record)) === null) return null;
    const result = await this.observe(record, adapter);
    check(!result.authorization_expired, "route_authorization_expired");
    check(
      result.comparison.matches,
      result.comparison.status === "unknown"
        ? "route_unverified"
        : "route_mismatch",
    );
    adapter.requireRouting(record.cli_session_id, result.active_route);
    return result;
  }
}
