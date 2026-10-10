import test from "node:test";
import assert from "node:assert/strict";
import {
  activateProjectProfile,
  createProjectProfile,
  previewProjectProfile,
  profileEnvironmentValues,
  profileVersion,
  resolveProfileLayers,
} from "../project-profiles.mjs";

const completeProfile = (extra = {}) => ({
  model_route: "openai/gpt-4.1",
  verification_commands: [["cargo", "test"]],
  permissions: {
    read_paths: ["src"],
    write_paths: ["target"],
    network_hosts: ["api.example.com"],
  },
  max_parallel: 4,
  notifications: "all",
  ...extra,
});

test("profile resolution applies the documented precedence and reports every overridden source", () => {
  const result = resolveProfileLayers({
    defaults: { max_parallel: 1, notifications: "actionable" },
    user: { max_parallel: 3, model_route: "openai/gpt-4.1" },
    project: { max_parallel: 4 },
    environment: { max_parallel: 6, notifications: "none" },
    invocation: { max_parallel: 2 },
  });
  assert.equal(result.effective_values.max_parallel, 2);
  assert.equal(result.effective_values.notifications, "none");
  assert.equal(result.effective_values.model_route, "openai/gpt-4.1");
  assert.deepEqual(result.sources.max_parallel, {
    selected: "invocation",
    overridden: ["defaults", "user", "project", "environment"],
  });
  assert.deepEqual(result.sources.notifications, {
    selected: "environment",
    overridden: ["defaults"],
  });
  assert.deepEqual(result.sources.model_route, {
    selected: "user",
    overridden: [],
  });
  assert.equal(result.version, profileVersion(result.effective_values));
  assert.throws(
    () => resolveProfileLayers({ defaults: { max_parallel: 2 } }),
    /cannot be overridden/,
  );
});

test("saved profile versions are immutable, content-addressed, and activated by exact version", () => {
  const state = {};
  const first = createProjectProfile(state, {
    id: "release-checks",
    name: "Release checks",
    values: completeProfile(),
    activate: true,
  });
  const second = createProjectProfile(state, {
    id: "release-checks",
    name: "Release checks",
    values: completeProfile({ max_parallel: 2 }),
  });
  const profile = state.profile_catalog.profiles["release-checks"];
  assert.notEqual(first.version, second.version);
  assert.equal(profile.versions.length, 2);
  assert.equal(profile.versions[0].values.max_parallel, 4);
  assert.deepEqual(state.profile_catalog.active, {
    id: "release-checks",
    version: first.version,
  });
  activateProjectProfile(state, { id: "release-checks", version: second.version });
  assert.deepEqual(state.profile_catalog.active, {
    id: "release-checks",
    version: second.version,
  });
  assert.throws(
    () => activateProjectProfile(state, { id: "release-checks", version: "missing" }),
    /does not exist/,
  );
  assert.equal(state.profile_catalog.profiles["release-checks"].versions.length, 2);
});

test("profile IDs that shadow JavaScript object names remain ordinary profile IDs", () => {
  const state = {};
  const saved = createProjectProfile(state, {
    id: "constructor",
    name: "Constructor",
    values: { notifications: "none" },
    activate: true,
  });
  assert.equal(
    previewProjectProfile(state, {}, {}).effective_values.notifications,
    "none",
  );
  activateProjectProfile(state, { id: "constructor", version: saved.version });
});

test("profiles reject unknown and credential-like fields before state changes", () => {
  const state = {};
  assert.throws(
    () =>
      createProjectProfile(state, {
        id: "unsafe",
        name: "Unsafe",
        values: { ...completeProfile(), api_key: "secret" },
      }),
    /credentials|Unknown/,
  );
  assert.throws(
    () =>
      createProjectProfile(state, {
        id: "unsafe",
        name: "Unsafe",
        values: completeProfile({ model_route: "api_key=secret" }),
      }),
    /credential-like/,
  );
  for (const argument of [
    "--token secret-value",
    "Authorization: Bearer secret-value",
    "--header=Cookie: session=secret-value",
    "Proxy-Authorization: Basic secret-value",
    "https://alice:secret-value@example.com/api",
  ]) {
    assert.throws(
      () =>
        createProjectProfile(state, {
          id: "unsafe",
          name: "Unsafe",
          values: completeProfile({ verification_commands: [["tool", argument]] }),
        }),
      /credential-like/,
    );
  }
  for (const command of [
    ["curl", "-u", "alice:secret-value"],
    ["curl", "--user=alice:secret-value"],
    ["curl", "--cookie", "session=secret-value"],
    ["curl", "-b", "session=secret-value"],
    ["curl", "--oauth2-bearer", "secret-value"],
    ["curl", "--proxy-bearer", "secret-value"],
  ]) {
    assert.throws(
      () =>
        createProjectProfile(state, {
          id: "unsafe",
          name: "Unsafe",
          values: completeProfile({ verification_commands: [command] }),
        }),
      /credential-bearing options/,
    );
  }
  assert.deepEqual(state, {});
});

test("environment resolution reads only the allowlisted RDSH_PROFILE variables", () => {
  assert.deepEqual(
    profileEnvironmentValues({
      RDSH_PROFILE_MODEL_ROUTE: "local/qwen",
      RDSH_PROFILE_MAX_PARALLEL: "8",
      RDSH_PROFILE_NOTIFICATIONS: "actionable",
      RDSH_PROFILE_VERIFICATION_COMMANDS_JSON: '[["npm","test"]]',
      RDSH_PROFILE_PERMISSIONS_JSON: '{"read_paths":["src"]}',
      OPENAI_API_KEY: "never copied",
      RDSH_TOKEN: "never copied",
    }),
    {
      model_route: "local/qwen",
      max_parallel: 8,
      notifications: "actionable",
      verification_commands: [["npm", "test"]],
      permissions: { read_paths: ["src"] },
    },
  );
  assert.throws(
    () =>
      profileEnvironmentValues({
        RDSH_PROFILE_PERMISSIONS_JSON: "{invalid",
      }),
    /valid JSON/,
  );
});

test("profile preview pins the saved version and marks invocation values as a non-executing preview", () => {
  const state = {};
  const saved = createProjectProfile(state, {
    id: "desktop",
    name: "Desktop",
    values: completeProfile(),
    activate: true,
  });
  createProjectProfile(state, {
    id: "desktop",
    name: "Desktop",
    values: completeProfile({ max_parallel: 3 }),
  });
  const preview = previewProjectProfile(
    state,
    { invocation: { notifications: "none" } },
    { RDSH_PROFILE_MAX_PARALLEL: "8" },
  );
  assert.equal(preview.profile_version, saved.version);
  assert.equal(preview.effective_values.max_parallel, 8);
  assert.equal(preview.effective_values.notifications, "none");
  assert.equal(preview.sources.notifications.selected, "invocation");
  assert.equal(preview.execution_effect, "none");
  assert.throws(
    () => previewProjectProfile(state, { id: "desktop", version: "missing" }, {}),
    /No saved version/,
  );
});
