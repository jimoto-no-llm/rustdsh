import { createHash } from "node:crypto";

export const profilePrecedence = [
  "defaults",
  "user",
  "project",
  "environment",
  "invocation",
];

export function emptyProfileCatalog() {
  return { schema: 1, active: null, profiles: {} };
}

const profileKeys = [
  "model_route",
  "verification_commands",
  "permissions",
  "max_parallel",
  "notifications",
];
const notificationModes = ["all", "actionable", "none"];
const secretMarker =
  /(?:api[_-]?key|access[_-]?token|bearer|credential|password|secret|token)\s*[:=]/i;
const secretFlag =
  /(?:^|\s)--(?:api[_-]?key|access[_-]?token|bearer|credential|password|secret|token)(?:=|\s+)/i;
const credentialHeader =
  /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*\S+/i;
const credentialUrl = /\b[a-z][a-z\d+.-]*:\/\/[^/\s@]+@/i;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (/(?:api[_-]?key|credential|password|secret|token)/i.test(key))
      throw new Error(`${label} must not contain credentials`);
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function findProfile(catalog, id) {
  return typeof id === "string" && Object.hasOwn(catalog?.profiles || {}, id)
    ? catalog.profiles[id]
    : undefined;
}

function string(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`${label} must be a non-empty string (max ${maximum})`);
  if (
    secretMarker.test(value) ||
    secretFlag.test(value) ||
    credentialHeader.test(value) ||
    credentialUrl.test(value)
  )
    throw new Error(`${label} must not contain credential-like values`);
  return value.trim();
}

function stringList(value, label, maximumItems, maximumLength) {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    value.some((item) => typeof item !== "string")
  )
    throw new Error(`${label} must be a string array (max ${maximumItems})`);
  return [...new Set(value.map((item) => string(item, label, maximumLength)))].sort();
}

export function normalizeProfileValues(input, { partial = true } = {}) {
  const value = object(input, "profile values");
  exactKeys(value, profileKeys, "profile");
  const result = {};
  if ("model_route" in value)
    result.model_route = string(value.model_route, "model_route", 160);
  if ("verification_commands" in value) {
    const commands = value.verification_commands;
    if (!Array.isArray(commands) || commands.length > 16)
      throw new Error("verification_commands must be an array (max 16)");
    result.verification_commands = commands.map((command, index) => {
      if (!Array.isArray(command) || command.length < 1 || command.length > 32)
        throw new Error(`verification_commands[${index}] must be an argv array`);
      return command.map((argument) =>
        string(argument, `verification_commands[${index}] argument`, 1000),
      );
    });
  }
  if ("permissions" in value) {
    const permissions = object(value.permissions, "permissions");
    exactKeys(
      permissions,
      ["read_paths", "write_paths", "network_hosts"],
      "permissions",
    );
    result.permissions = {};
    for (const key of ["read_paths", "write_paths", "network_hosts"])
      if (key in permissions)
        result.permissions[key] = stringList(
          permissions[key],
          `permissions.${key}`,
          128,
          512,
        );
  }
  if ("max_parallel" in value) {
    if (
      !Number.isSafeInteger(value.max_parallel) ||
      value.max_parallel < 1 ||
      value.max_parallel > 64
    )
      throw new Error("max_parallel must be an integer from 1 to 64");
    result.max_parallel = value.max_parallel;
  }
  if ("notifications" in value) {
    if (!notificationModes.includes(value.notifications))
      throw new Error("notifications must be all, actionable, or none");
    result.notifications = value.notifications;
  }
  if (!partial && Object.keys(result).length !== profileKeys.length)
    throw new Error("A complete profile must define every profile field");
  return result;
}

export function profileVersion(values) {
  const normalized = normalizeProfileValues(values);
  return `sha256:${createHash("sha256")
    .update("rdsh-project-profile-v1\0")
    .update(JSON.stringify(normalized))
    .digest("hex")}`;
}

export function validateProfileCatalog(catalog) {
  object(catalog, "project profile catalog");
  exactKeys(catalog, ["schema", "active", "profiles"], "profile catalog");
  if (catalog.schema !== 1) throw new Error("Unsupported project profile catalog");
  object(catalog.profiles, "profile catalog profiles");
  const ids = Object.keys(catalog.profiles);
  if (ids.length > 64) throw new Error("A project can store at most 64 profiles");
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id))
      throw new Error("Invalid profile id in project profile catalog");
    const profile = catalog.profiles[id];
    object(profile, "project profile");
    exactKeys(profile, ["id", "name", "versions", "latest_version"], "profile");
    if (profile.id !== id) throw new Error("Profile key and id do not match");
    string(profile.name, "profile name", 120);
    if (
      !Array.isArray(profile.versions) ||
      profile.versions.length < 1 ||
      profile.versions.length > 128
    )
      throw new Error("Invalid profile versions");
    const seen = new Set();
    for (const entry of profile.versions) {
      object(entry, "profile version");
      exactKeys(entry, ["version", "created_at", "values"], "profile version");
      if (typeof entry.created_at !== "string" || !Number.isFinite(Date.parse(entry.created_at)))
        throw new Error("Invalid profile version timestamp");
      const normalized = normalizeProfileValues(entry.values);
      if (profileVersion(normalized) !== entry.version || seen.has(entry.version))
        throw new Error("Invalid or duplicated profile version");
      seen.add(entry.version);
    }
    if (!seen.has(profile.latest_version))
      throw new Error("Latest profile version is missing");
  }
  if (catalog.active !== null) {
    object(catalog.active, "active profile");
    exactKeys(catalog.active, ["id", "version"], "active profile");
    const profile = findProfile(catalog, catalog.active.id);
    if (!profile?.versions.some((entry) => entry.version === catalog.active.version))
      throw new Error("Active profile version is missing");
  }
  return true;
}

export function createProjectProfile(state, input) {
  object(input, "profile input");
  exactKeys(input, ["id", "name", "values", "activate"], "profile input");
  const id = string(input.id, "profile id", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id))
    throw new Error("profile id must use letters, numbers, and hyphens");
  const name = string(input.name, "profile name", 120);
  if (typeof input.activate !== "undefined" && typeof input.activate !== "boolean")
    throw new Error("activate must be a boolean");
  const values = normalizeProfileValues(input.values);
  const version = profileVersion(values);
  state.profile_catalog ||= emptyProfileCatalog();
  const catalog = state.profile_catalog;
  validateProfileCatalog(catalog);
  let profile = findProfile(catalog, id);
  if (profile && profile.name !== name)
    throw new Error("A profile id cannot be reused with another name");
  if (!profile) {
    if (Object.keys(catalog.profiles).length >= 64)
      throw new Error("A project can store at most 64 profiles");
    profile = { id, name, versions: [] };
    catalog.profiles[id] = profile;
  }
  let saved = profile.versions.find((entry) => entry.version === version);
  if (!saved) {
    if (profile.versions.length >= 128)
      throw new Error("A profile can store at most 128 versions");
    saved = {
      version,
      created_at: new Date().toISOString(),
      values,
    };
    profile.versions.push(saved);
  }
  profile.latest_version = version;
  if (input.activate) catalog.active = { id, version };
  validateProfileCatalog(catalog);
  return structuredClone({ profile_id: id, version, active: catalog.active });
}

export function activateProjectProfile(state, input) {
  object(input, "profile activation");
  exactKeys(input, ["id", "version"], "profile activation");
  const id = string(input.id, "profile id", 64);
  const version = string(input.version, "profile version", 80);
  const profile = findProfile(state.profile_catalog, id);
  if (!profile?.versions?.some((entry) => entry.version === version))
    throw new Error("The requested profile version does not exist");
  state.profile_catalog.active = { id, version };
  validateProfileCatalog(state.profile_catalog);
  return structuredClone(state.profile_catalog.active);
}

export function profileEnvironmentValues(env = process.env) {
  const result = {};
  const simple = {
    RDSH_PROFILE_MODEL_ROUTE: "model_route",
    RDSH_PROFILE_MAX_PARALLEL: "max_parallel",
    RDSH_PROFILE_NOTIFICATIONS: "notifications",
  };
  for (const [name, key] of Object.entries(simple)) {
    if (env[name] === undefined) continue;
    result[key] = key === "max_parallel" ? Number(env[name]) : env[name];
  }
  for (const [name, key] of [
    ["RDSH_PROFILE_VERIFICATION_COMMANDS_JSON", "verification_commands"],
    ["RDSH_PROFILE_PERMISSIONS_JSON", "permissions"],
  ]) {
    if (env[name] === undefined) continue;
    try {
      result[key] = JSON.parse(env[name]);
    } catch {
      throw new Error(`${name} must contain valid JSON`);
    }
  }
  return normalizeProfileValues(result);
}

export function resolveProfileLayers(layers) {
  object(layers, "profile layers");
  exactKeys(layers, profilePrecedence, "profile layer");
  const defaults = { max_parallel: 1, notifications: "actionable" };
  if ("defaults" in layers) {
    const supplied = normalizeProfileValues(layers.defaults);
    if (
      Object.keys(supplied).length !== Object.keys(defaults).length ||
      Object.entries(defaults).some(([key, value]) => supplied[key] !== value)
    )
      throw new Error("Built-in profile defaults cannot be overridden");
  }
  const values = { ...defaults };
  const sources = Object.fromEntries(
    Object.keys(defaults).map((key) => [key, { selected: "defaults", overridden: [] }]),
  );
  for (const source of profilePrecedence.slice(1)) {
    if (!(source in layers)) continue;
    const layer = normalizeProfileValues(layers[source]);
    for (const [key, next] of Object.entries(layer)) {
      const previous = sources[key];
      sources[key] = {
        selected: source,
        overridden: previous
          ? [...previous.overridden, previous.selected]
          : [],
      };
      values[key] = next;
    }
  }
  const normalized = normalizeProfileValues(values);
  return {
    precedence: [...profilePrecedence],
    effective_values: normalized,
    sources,
    version: profileVersion(normalized),
  };
}

export function previewProjectProfile(state, input, env = process.env) {
  object(input, "profile preview");
  exactKeys(input, ["id", "version", "user", "invocation"], "profile preview");
  const active = state.profile_catalog?.active;
  const id = input.id ?? active?.id;
  const version = input.version ?? active?.version;
  const profile = findProfile(state.profile_catalog, id);
  const saved = profile?.versions?.find((entry) => entry.version === version);
  if (!saved) throw new Error("No saved version is available for this preview");
  const invocation = normalizeProfileValues(input.invocation || {});
  return {
    profile_id: id,
    profile_name: profile.name,
    profile_version: saved.version,
    ...resolveProfileLayers({
      user: normalizeProfileValues(input.user || {}),
    project: saved.values,
      environment: profileEnvironmentValues(env),
      invocation,
    }),
    execution_effect: "none",
  };
}
