# Review evidence UI fixtures

These screenshots come from `tests/e2e/review-evidence.mjs`, which creates a disposable local Git project and records a synthetic report through the authenticated MCP endpoint.

- `review-evidence-before.png` shows the empty panel before a report is submitted.
- `review-evidence-current.png` shows the reported result while its task and source target still match.
- `review-evidence-stale.png` shows the same report after a later source commit invalidates it.

The fixture uses no provider, model, credentials, or remote project. It verifies the report and stale-state flow; it does not claim that a reviewer was actually invoked, that the submitter is authenticated, or that an OS sandbox enforced the worker's read-only declaration.
