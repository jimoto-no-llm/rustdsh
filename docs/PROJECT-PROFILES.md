# Project profile versions and precedence

The project dashboard can save a versioned, project-scoped operation profile and
preview its effective values. It does not start a task, run a verification
command, enforce a permission, or silently change an active run.

## Resolution order

Values resolve in this order, with each later source overriding only the fields
it supplies:

1. Built-in defaults: `max_parallel: 1` and `notifications: "actionable"`.
2. User/common values entered for the current preview. This layer is not saved
   by the project dashboard.
3. The selected project profile, stored in that project's local dashboard state.
4. Allowlisted process environment variables beginning with `RDSH_PROFILE_`.
5. Values entered as invocation overrides for the current preview. These are
   also not saved.

The preview lists the selected source and every overridden source per field.
This layer report describes settings only; it is not an execution or permission
decision.

## Saved project profiles

Profiles are stored with the project's local dashboard state, outside the Git
checkout. A profile ID uses letters, numbers and hyphens. Saving an edited
profile appends a content-addressed `sha256:` version; previous values remain
available. Activation records the exact profile ID and version. Re-selecting an
old version does not rewrite it.

Supported fields are:

- `model_route`: a descriptive route string.
- `verification_commands`: up to 16 argument arrays, each with up to 32 strings.
  The dashboard stores and displays these arrays but never executes them.
- `permissions`: `read_paths`, `write_paths` and `network_hosts` arrays. These
  are declarations only and do not grant or enforce access.
- `max_parallel`: an integer from 1 to 64.
- `notifications`: `all`, `actionable` or `none`.

Unknown fields are rejected. Credential-named fields, common credential-like
`key=value` strings, credential command-line flags, and URLs containing user
information are rejected; credentials should never be placed in profile values.
The preview reads only these explicit environment names:

- `RDSH_PROFILE_MODEL_ROUTE`
- `RDSH_PROFILE_MAX_PARALLEL`
- `RDSH_PROFILE_NOTIFICATIONS`
- `RDSH_PROFILE_VERIFICATION_COMMANDS_JSON`
- `RDSH_PROFILE_PERMISSIONS_JSON`

Other process environment values, including provider credentials, are not
copied into profiles or previews. Invalid JSON and out-of-range values fail the
preview instead of being ignored.

This slice does not persist a user-wide profile, read a repository profile file,
or bind a resolved profile version to a launched task/run. Those integrations
must be completed before issue #60 can be considered done.
