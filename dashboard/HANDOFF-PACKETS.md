# Source-linked handoff packets

`dashboard_create_handoff({"task_id":"..."})` saves one latest packet in the
project's private dashboard state directory. `dashboard_get_handoff` and the
`dashboard://handoff` resource return that snapshot with a live freshness
comparison. `dashboard://acceptance` exposes the current acceptance inspection
for the task in the latest packet. The MCP resource links use selectors into
`dashboard://state`, `dashboard://feedback`, and `dashboard://acceptance`.

Every packet has seven sections: purpose, remaining work, constraints,
decisions, deliverables, verification, and next step. Each recorded item links
to its source URI and selector, carries its source timestamp when one exists,
and includes a SHA-256 fingerprint of the recorded facts. The packet also keeps
its creation time and project-state revision.

The packet is a source-backed snapshot, not generated prose or a formal session
resume. Task status is reported as task status and is not treated as proof of
completion. Only typed decisions explicitly targeted at the task are included;
unlinked answers are not assigned to it. Artifact paths from progress events
remain references and are not opened. The current AcceptanceStore inspection
reads registered evidence for integrity and freshness; the packet contains only
evidence IDs, result state, target hashes, and artifact integrity, while
omitting private record paths, command arguments, and file contents. The packet
does not rerun tests. Missing task data, acceptance criteria, artifacts,
decisions, or next actions remain explicitly unknown; it never fills those
gaps with a success claim.

On every read, the server re-reads current task and decision data and inspects
the acceptance store. `freshness.status` becomes `stale` when a referenced fact
changes or disappears, or when a new relevant source appears. The response
identifies each stale/new source and includes both the packet creation time and
the current project revision. A revision change without a change to a referenced
fact is shown separately as `state_revision_changed`.

Creating a packet advances the project revision so disconnected MCP clients can
observe the resource update. This snapshot operation does not change task status
or authorize execution.
