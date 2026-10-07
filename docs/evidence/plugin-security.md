# Plugin API security verification

Verified on 2026-10-07 against main `d537230`, using the installed DSH
`@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-client-connection`, and
Cordis packages from DSH 0.2.0-rc.2. Each run used a fresh loopback port,
temporary `DSH_HOME`, synthetic settings, and an in-memory credential provider.
The updater's `execFile` was replaced with a counter before importing the
plugin; no update script, downloaded executable, or real credential was used.

## Observed before/after responses

| Request | Before | After |
| --- | --- | --- |
| GUI root without credentials | 401 | 401 |
| GET `/api/rdsh-settings` without credentials | 200 | 401 |
| GET `/api/rdsh-context` without credentials | 200 | 401 |
| GET `/api/rdsh-update` without credentials | 200 | 401 |
| POST `/api/rdsh-settings/save` without credentials | 200 | 401 |
| POST `/api/rdsh-context/save` without credentials | 200 | 401 |
| POST `/api/rdsh-update/run` without credentials | 200 | 401 |
| All six routes with valid cookie and hostile Origin | 200 | 403 |
| All three reads with valid GUI session | 200 | 200 |
| Settings save with valid GUI session | 200 | 200 |

Excerpt from the wire-test output diff:

```diff
-Updater mock calls after unauthenticated requests: 1
+Updater mock calls after unauthenticated requests: 0
-Authenticated settings save: 200; extras.enable DELETED
+Authenticated settings save: 200; extras.enable preserved
```

The saved settings retained `extras.enable: ["serve", "setup"]`, an unknown
top-level section, and an unknown nested search key while applying the edited
`search.max`. The plugin merges only fields it models into the current disk
document. Unknown fields supplied by a client cannot change those disk values.
Malformed existing settings refuse a save without replacing the file.

## Regression check

```sh
node --test tests/plugin-security.test.mjs
```

The dependency-free check covers all six handlers, GET/HEAD/POST rejection,
missing/incompatible authentication, refusal before body consumption and
file/subprocess effects, authorized operations, settings round-trips, partial
saves, clamping, unknown-field injection, and malformed disk documents.
CI runs it on Node 22.

## Impact and limits

The authentication bypass and settings-key loss are confirmed. An attacker
who can reach the unpatched GUI listener can read and modify plugin settings
and legacy context, and request the fixed updater command. This PR applies
the GUI's native authentication and request-trust boundary to those routes.

The report's arbitrary-code-execution, downgrade, and persistent-compromise
claims were not demonstrated. The update handler accepts no command/path
input. In demo mode its timestamp is generated on each GET, so a changing
timestamp alone does not prove updater execution. The subprocess counter
confirms the unauthenticated trigger without running the updater.

Until the patched bundles are loaded, disable these two plugins in the web
profile and restart the GUI. Applying the source change requires reloading
the installed bundles; it does not repair already overwritten settings or
legacy context. Restore those from a known-good backup if needed.
