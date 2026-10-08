// Read-only interpretation of pinned DSH routing; never configures a provider.
import { createHash } from "node:crypto";
export const routeHash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const exactRouteObject = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const label = (value, max = 256) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  /^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/.test(value);
export class RoutingError extends Error {
  constructor(code) {
    super("Model routing: " + code);
    this.code = code;
  }
}
export function routeCheck(value, code) {
  if (!value) throw new RoutingError(code);
}
export function validSelection(value) {
  return (
    exactRouteObject(value, ["provider", "model", "effort"]) &&
    label(value.provider, 80) &&
    label(value.model) &&
    (value.effort === null || label(value.effort, 80))
  );
}
export function selected(value) {
  routeCheck(validSelection(value), "invalid_model_selection");
  return { provider: value.provider, model: value.model, effort: value.effort };
}
export const sameSelection = (before, after) =>
  validSelection(before) &&
  validSelection(after) &&
  ["provider", "model", "effort"].every((key) => before[key] === after[key]);
const roles = ["scout", "worker", "reviewer", "architect"];
export function requestedSelection(
  input,
  env = {},
  persisted = { version: 1, routes: {} },
) {
  if (validSelection(input))
    return {
      selection: selected(input),
      provenance: {
        source: "explicit_operator_request",
        role: null,
        effort_source: "explicit",
        warning: null,
        source_hash: routeHash(input),
      },
    };
  routeCheck(
    exactRouteObject(input, ["role", "parent"]) &&
      roles.includes(input.role) &&
      validSelection(input.parent),
    "invalid_role_request",
  );
  routeCheck(
    exactRouteObject(persisted, ["version", "routes"]) &&
      persisted.version === 1 &&
      object(persisted.routes) &&
      Object.keys(persisted.routes).every((role) => roles.includes(role)),
    "invalid_persisted_routes",
  );
  const routes = {};
  for (const [role, value] of Object.entries(persisted.routes)) {
    routeCheck(
      object(value) &&
        Object.keys(value).every((key) =>
          ["provider", "model", "effort"].includes(key),
        ) &&
        typeof value.provider === "string" &&
        typeof value.model === "string" &&
        (value.effort === undefined || typeof value.effort === "string"),
      "invalid_persisted_routes",
    );
    routes[role] = {
      provider: value.provider.trim(),
      model: value.model.trim(),
      effort: value.effort?.trim() || null,
    };
    routeCheck(validSelection(routes[role]), "invalid_persisted_routes");
  }
  const prefix = "OMDSH_" + input.role.toUpperCase();
  const provider = env[prefix + "_PROVIDER"],
    model = env[prefix + "_MODEL"],
    effort = env[prefix + "_EFFORT"];
  const overridden = provider !== undefined || model !== undefined;
  let chosen = null,
    source = "parent_request",
    warning = null;
  if (overridden) {
    if (provider && model) {
      chosen = selected({ provider, model, effort: effort || null });
      source = "environment";
    } else warning = "partial_environment_suppressed_saved_route";
  } else if (routes[input.role]) {
    chosen = routes[input.role];
    source = "persisted_role";
  }
  let selection = selected(input.parent),
    effort_source = "parent_request";
  if (chosen) {
    selection = { ...chosen };
    if (chosen.effort !== null) effort_source = source;
    else if (
      chosen.provider === input.parent.provider &&
      chosen.model === input.parent.model
    ) {
      selection.effort = input.parent.effort;
      effort_source = "parent_request";
    } else effort_source = "provider_default_unverified";
  }
  return {
    selection,
    provenance: {
      source,
      role: input.role,
      effort_source,
      warning,
      source_hash: routeHash({
        input,
        selected: selection,
        source,
        effort_source,
        warning,
      }),
    },
  };
}

// DSH 0.2.0-rc.2 encodes the model selector as JSON [provider, model].
// Missing reasoning options are unknown, not invented provider-default values.
export function nativeSelection(options, source, cliVersion) {
  const observation = {
    status: "unknown",
    selection: null,
    reason: "config_options_unavailable",
    source,
    cli_version: cliVersion,
    observed_at: new Date().toISOString(),
    actual_execution_verified: false,
  };
  if (options == null || (Array.isArray(options) && options.length === 0))
    return observation;
  try {
    routeCheck(
      Array.isArray(options) && options.length <= 100,
      "invalid_config_options",
    );
    const model = options.filter((item) => item?.id === "model"),
      reasoning = options.filter((item) => item?.id === "reasoning_effort");
    routeCheck(
      model.length === 1 && reasoning.length <= 1,
      "ambiguous_model_selection",
    );
    const choices = (option) => {
      routeCheck(
        object(option) &&
          option.type === "select" &&
          typeof option.currentValue === "string" &&
          option.currentValue.length <= 1024 &&
          Array.isArray(option.options) &&
          option.options.length <= 1000,
        "invalid_config_options",
      );
      const values = [];
      for (const item of option.options) {
        if (object(item) && Object.hasOwn(item, "group")) {
          routeCheck(
            Array.isArray(item.options) && item.options.length <= 1000,
            "invalid_config_options",
          );
          values.push(...item.options.map((entry) => entry?.value));
        } else values.push(item?.value);
      }
      routeCheck(
        values.length <= 5000 &&
          values.every(
            (value) => typeof value === "string" && value.length <= 1024,
          ) &&
          new Set(values).size === values.length &&
          values.includes(option.currentValue),
        "invalid_config_options",
      );
    };
    choices(model[0]);
    const pair = JSON.parse(model[0].currentValue);
    routeCheck(
      Array.isArray(pair) &&
        pair.length === 2 &&
        label(pair[0], 80) &&
        label(pair[1]),
      "invalid_model_selection",
    );
    if (reasoning.length === 0)
      return {
        ...observation,
        selection: { provider: pair[0], model: pair[1], effort: null },
        reason: "reasoning_selection_unavailable",
      };
    choices(reasoning[0]);
    const selection = selected({
      provider: pair[0],
      model: pair[1],
      effort:
        reasoning[0].currentValue === "" ? null : reasoning[0].currentValue,
    });
    return { ...observation, status: "observed", selection, reason: null };
  } catch {
    return { ...observation, reason: "invalid_native_model_selection" };
  }
}
export function compareSelection(expected, observation) {
  if (
    observation?.status !== "observed" ||
    !validSelection(observation.selection)
  )
    return {
      status: "unknown",
      reason: observation?.reason || "native_selection_unavailable",
      matches: false,
    };
  const mismatched = ["provider", "model", "effort"].filter(
    (key) => expected[key] !== observation.selection[key],
  );
  if (
    mismatched.length === 1 &&
    mismatched[0] === "effort" &&
    expected.effort === null
  )
    return {
      status: "unknown",
      reason: "provider_default_resolution_unverified",
      mismatched_fields: [],
      matches: false,
    };
  return {
    status: mismatched.length ? "mismatch" : "matches_native_configuration",
    reason: mismatched.length ? "native_selection_differs" : null,
    mismatched_fields: mismatched,
    matches: mismatched.length === 0,
  };
}
