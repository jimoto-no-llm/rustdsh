# Dashboard state migration

Project state remains on its current schema until an operator requests a
migration. `rdsh-dashboard state-migrate dry-run --project <directory>` validates
the source and reports the source/target hashes, byte sizes, and exact changes
without writing files. The supported migration is schema 1 to schema 2; it
requires the `changes` array and initializes it to an empty array only when it
is absent. Existing entries are preserved.

Stop the project dashboard before applying a migration. `apply` writes the exact
source bytes to `state-migrations/<migration-id>.before.json`, records the
source and target hashes, writes a synced temporary state file, then replaces
`state.json` atomically. Project state readers and writers refuse to run while
the migration lock exists. Unknown schemas, invalid nested state, a live
dashboard lock, or a source file that changed after planning leave `state.json`
untouched.

After interruption, `inspect` compares the current state hash with each
recorded target hash. A prepared record whose target hash is present is reported
as cut over; a schema 2 state is never transformed a second time. If the source
schema remains current, `apply` can reuse the checksum-verified snapshot and
retry the cutover.

`rollback --migration-id <id>` restores the exact schema 1 snapshot only when
the current state still matches the recorded schema 2 target hash. If the state
has changed since migration, rollback refuses to overwrite those changes; an
operator must preserve and reconcile the newer data separately. A stale
migration lock is never removed automatically. `inspect` reports its recorded
PID, and `clear-stale-lock --confirm-stale-lock` removes it only after the owner
process is confirmed gone and the lock contents are unchanged.

The migration commands are local maintenance operations. They do not convert
unknown schemas, migrate project files, or start/stop a dashboard on the
operator's behalf.
