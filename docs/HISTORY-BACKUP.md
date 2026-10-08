# Selective history backup

`dashboard/cli.mjs backup` exports portable **historical records** for #46.
It does not copy the project directory or the dashboard state directory.
Restoration preserves task → decision revision → question → answer associations
and acceptance evidence IDs in a separate, read-only `history_backups` collection.
`backup history` and the existing authenticated state resource expose those
records. The current task board, pending inbox, feedback consumer and original
agent sessions are not recreated from an archive.

## Select and review

Start the source project's local dashboard, then write a selection file:

```json
{
  "types": ["tasks", "answers", "decisions", "evidence"],
  "task_ids": ["task-1"]
}
```

`types` must be explicit. Optional `task_ids`, `question_ids`, `evidence_ids`
restrict their respective entities; omitted/null means all, `[]` means none.
Task and question filters both apply to typed answers/decisions. A legacy
question has no task binding, so select it by question ID with no task filter.
Dependencies needed by an answer or evidence reference are included even when
their type is not selected. A selected historical answer retains its actual
question revision rather than silently using the current revision.

Optional inclusive `since`/`until` use canonical UTC timestamps, for example
`2026-10-06T00:00:00.000Z`. They filter task update, answer creation and decision
update times; required dependencies can fall outside the range. Evidence index
references have no timestamps, so evidence selection with a date range is
rejected. Select evidence by task/evidence ID instead. The source state and
acceptance index each have their revision recorded.

```sh
node dashboard/cli.mjs backup preview --project /path/to/source --selection-file selection.json
```

Preview returns counts, selected records, source revisions, selection digest,
and every held text-field path. **All source free text is withheld by default**:
titles, questions, answers, choice labels, diffs and conditions become `null`.
No regex guesses which source prose is safe to publish. No code, logs, images,
command arguments, filesystem paths, tokens, credentials, native session/run
bindings, runtime URLs, consumer grants or event subscription secrets are copied.
Evidence uses a portable `rdsh-evidence:<source-project-id>/<evidence-id>`
reference, with `freshness: "unverified"`; it is not a copied or validated asset.

To retain useful prose, independently review it and supply **replacement text**
for specific preview paths. Use the exact `source` and `selection_digest` from
preview in a local review file:

```json
{
  "source": {
    "project_id": "0123456789abcdef",
    "revision": 12,
    "acceptance_revision": 3
  },
  "selection_digest": "COPY_THE_PREVIEW_SELECTION_DIGEST",
  "replacements": [
    { "path": "tasks/task-1/title", "value": "Reviewed task title" },
    { "path": "answers/answer_1/answer", "value": "Proceed with that change" }
  ]
}
```

Changes to either source revision or selection invalidate that review. Unknown
paths, duplicate paths, recognized credential prefixes/assignments, bearer/basic
headers, JWT/private keys, 64-hex credential-like strings, code fences/common
code declarations and URLs with userinfo, query or fragment are rejected.
This is a guard against common mistakes, not universal secret detection: the
operator must review replacement prose and opaque IDs for sensitive information.
An unrecognized secret deliberately placed in reviewed prose cannot be identified
reliably by this feature. Keep the review file private as well.

```sh
node dashboard/cli.mjs backup export --project /path/to/source --selection-file selection.json --review-file review.json --output-file history.json
node dashboard/cli.mjs backup inspect --archive-file history.json
```

Omit `--review-file` to export only structural history with held prose. Inspect
shows the exact exported text and held-field manifest before sharing the file.
The output must be a new file; existing files are never overwritten. It is
created with mode `0600` where supported. Windows uses the containing directory's
ACL, so choose a private directory. No automatic upload or publication occurs.

## Restore using the target's own authentication

Start a dashboard for an empty target project. Its new runtime issues fresh
administrator, MCP and browser keys, independently of the source. Get the current
target revision, inspect the archive, then restore:

```sh
node dashboard/cli.mjs backup history --project /path/to/target
node dashboard/cli.mjs backup restore --project /path/to/target --archive-file history.json --expected-revision 0
node dashboard/cli.mjs backup history --project /path/to/target
```

Preview/export/history/restore require the target/source's **local administrator**
credential and loopback access. MCP, browser, budget-producer and reply-consumer
keys cannot import archives or grant themselves backup access. Offline inspection
requires no runtime. Native sessions and credential configuration are never read
or changed. Existing target runtime keys and subscriptions keep their own identity;
the archive cannot reactivate source credentials or subscriptions.

Before any state write, restoration checks the schema, bounds, field whitelist,
canonical SHA-256, reviewed/held paths, all entity references, current revision and
ID conflicts. Live task/question IDs, existing restored task/question/decision/
evidence IDs, acceptance task IDs and evidence IDs cause rejection. No overwrite,
ID remapping or automatic merge occurs. Answer sequences remain scoped to their
archive and original project. Subsequent dashboard updates cannot reuse restored
task/question IDs. Other tools writing their own acceptance files outside the
dashboard must likewise choose distinct IDs; their database is only observed at
the time of restoration.

One serialized dashboard mutation writes the complete imported collection by
the existing private temporary-file/atomic-rename mechanism. Corrupt archives,
stale revisions and collisions leave the target state file unchanged. Imported
approval decisions always remain historical, with `execution_authorized: false`.
There are no imported commands, pending replies, native resume grants, budget
policies, event delivery cursors or callbacks. Imported evidence cannot make a
current task's acceptance checks pass; reread/recheck the source evidence and
target inputs separately.

History is validated in full on import/open and frozen recursively in memory.
Ordinary state updates retain that immutable history and check cached IDs for
conflicts, avoiding repeated prose/checksum scans on each model-call reservation.
Replacing the collection invokes full validation again before any state write.

Re-export a restored archive without changing its original provenance/checksum:

```sh
node dashboard/cli.mjs backup export --project /path/to/target --archive-id backup_UUID --output-file another-new-history.json
```

## Format and limits

The archive is UTF-8 JSON, `format: "rdsh-history"`, `schema: 1`, with a UUID,
creation timestamp, source revisions, normalized selection, historical-only
policy, five record arrays, content-review manifests and canonical SHA-256.
It is neither a ZIP nor a filesystem extraction: references cannot write files.
The checksum detects accidental corruption, not source authenticity or a
malicious author who recomputes it. Even resealed input receives structural and
authority checks. Keep archives in trusted storage if provenance matters.

Maximum file size is 2 MiB, each entity array 2,000 records, and retained history
100 archives / 8 MiB. Larger inputs fail without dropping older history. Exported
entity IDs must use 1–128 ASCII letters/digits/dots/underscores/hyphens, beginning
with a letter/digit; reserved object names and credential-like IDs are rejected.
Incompatible legacy IDs stop export rather than being silently remapped. Regular
UTF-8 files are required; directories, final symlinks, devices and malformed JSON
are refused. An interrupted export may leave a partial, exclusively-created file;
inspection/restoration rejects it. Restoration does not migrate unsupported
schemas or restore full agent/session execution state.
