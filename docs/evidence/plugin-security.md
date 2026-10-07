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
GET and save responses contain only fields supported by the form, so large
unmodeled sections stay on disk instead of entering the next POST body.

Clearing Working Files was verified through an authenticated settings save
followed by `rdsh settings get context.working_files`. It returns `[]` even
when the original document has an older `context.files` list, or a separate
`rdsh-context.json` contains old files. The save migrates `context.files` into
`working_files` and removes the alias. The Rust reader uses the `files` alias
only when `working_files` is missing or null, and reads the separate legacy
file only when the canonical context section is absent or null. Explicit
empty/default context settings remain authoritative.

When canonical context is absent or null, the GUI loads the active legacy
values and migrates them on a full save. An unrelated partial save leaves
context absent/null rather than generating a default context that shadows
the legacy file. A partial context edit starts from the active legacy values;
an explicit empty Working Files list clears only that selection.

Authenticated real DSH saves followed by Rust CLI reloads verified the
missing-context partial save, null-context partial save, GUI-shaped full
round-trip, and explicit Working Files clear. All retained the previously
effective context except for the requested clear; the legacy file stayed
unchanged. These paths failed regression checks at `d5bf393` before repair.

The actual production React component was also rendered on an isolated
component host with real DSH APIs and synthetic settings. Changing only
`search.max` to 42 and clicking Save retained/migrated the legacy goal, files,
and decisions. This is component verification, not a full DSH shell capture.
The warning now requires confirming migration before deleting the old file.
Both warning captures use the repaired API and the same synthetic fixture.
Screenshots belong in the PR conversation rather than the source tree.

Review regression checks reproduced two oversized round-trip failures at
`5e16a77`: 50 Japanese paths of 300 characters produced a 91,074-byte POST,
and a 1 MiB unmodeled section produced a 1,049,376-byte POST. Both returned
400. After restricting responses to form fields, real authenticated DSH
round-trips returned 200 with 45,814-byte and 676-byte bodies respectively;
the disk retained the unmodeled data. Fixtures differed between the handler
regression and real DSH runs, so these sizes are examples rather than exact
before/after size deltas.

The canonical settings save has a bounded 1 MiB request limit, sufficient
for all supported fields at their current maximum lengths and list sizes,
including JSON escaping. The real DSH API accepted the 654,200-byte maximum
escaped form and rejected a body over 1 MiB with 400 without writing the
settings file. Regression checks cover both cases. The legacy context save
retains its 64 KiB limit.

## Regression check

```sh
node --test tests/plugin-security.test.mjs
```

The dependency-free check covers all six handlers, GET/HEAD/POST rejection,
missing/incompatible authentication, refusal before body consumption and
file/subprocess effects, authorized operations, settings round-trips, partial
saves, clamping, unknown-field injection, explicit empty Working Files with
legacy aliases, oversized disk metadata, the maximum supported form body,
oversized request rejection, active legacy context migration, unrelated partial
saves with absent/null context, and malformed disk documents. Rust regression
checks cover alias precedence and clearing context while the separate
legacy file exists.
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
profile and restart the GUI. Applying the source change requires updating
the Rust launcher and reloading the installed bundles; it does not repair
already overwritten settings or legacy context. Restore those from a
known-good backup if needed.
