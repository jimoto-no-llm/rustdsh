# Issue #52: QA route evidence

規模: 中（既存のProject dashboardを隔離環境で試し、経路別JSONから絞込可能なHTMLへつなぐ。製品の実行・権限・状態APIは変更しない）。

## Purpose and boundary

[#52](https://github.com/sahenjp/rustdsh/issues/52) asks for a truthful comparison
of tested and untested interaction routes, not an all-green dashboard or a new
agent controller. `rdsh` delegates the agent loop/profile boot to DSH; Node
`project` exposes MCP-reported tasks and human answers, while `harness` launches
the original DSH Web UI. Rust `rdsh serve` is another surface. These are not
interchangeable test targets.

The QA entry point belongs under `dashboard/qa`, linked from dashboard Validation.
It tests the actual existing project server, HTML and browser script. It does not
add QA state to project records, expose another MCP tool, change phone pairing,
or import unmerged #40/#41/#42/#43/#13 implementations. Harness/WSL/Tailscale
connections retain their own untested rows unless actually exercised.

## Observable acceptance

- Catalogue desktop/mobile, keyboard, reload, back, cancel, double submit,
  network loss before acceptance and after persistence, and local/WSL/Tailscale.
- Show every defined cell, including absent results as `not-run`; filter status
  (including all unverified), device, operation, route and evidence level.
- Record target SHA and dirty identity, environment, time, command, evidence,
  observed route and source (fixture/browser/real connection). Local or viewport
  success cannot count as a real phone/WSL/Tailscale connection pass.
- Use actual browser interactions for SSE while drafting, double submit, the two
  interrupted-submit cases, reconnect/retry, navigation and cancellation.
- Keep failures visible. Lost reload drafts may be reported as failures; this
  task does not silently add the separate offline-draft feature (#71).

## Minimal implementation

`catalog.mjs` defines stable cells and instructions. `report.mjs` validates a
report with one target revision and produces rows, defaulting missing cells to
not-run. `cli.mjs` initializes a record from Git and builds standalone HTML from
validated JSON; the rendered result is viewable without a live service. Relative
evidence references are explicit, not a directory scan or a credential export.
`fixture.mjs` starts the real local project server with synthetic state behind a
loopback-only fault proxy controlled from stdin. It holds/drops answer traffic
and disconnects SSE without adding a production fault endpoint. The report
distinguishes this browser-with-fixture run from external real connections.

## Validation

Baseline: main `f2a7dc6`, Node 24.13.0, `npm test --prefix dashboard`: 8 passed.
Unit tests cover catalogue coverage, truthful status/evidence validation, unknown
fields/IDs, unsafe evidence links, HTML injection and deterministic rendering.
The fixture has HTTP-level control tests; these do not claim browser coverage.
CUA real-browser checks supply screenshots plus DOM/durable-feedback observations.
Independent code and requirements reviews run after implementation. Existing
required repository checks and a changed-file secscan precede completion.

## 2026-10-08: acceptance and evidence audit

規模: 中（QA記録の判定契約、既存利用経路、複数OSの実行証拠を照合する。新しい製品機能は追加しない）。

- Recheck each #52 requirement against the catalogue, validator, HTML, CLI and
  evidence. Separate required work, unverified routes and optional extensions.
- Reject a Project `pass` that omits necessary observations or reports zero
  persisted answers after a completed submission. Preserve genuine failures and
  historical records; transport retries alone do not imply duplicate answers.
- Keep keyboard navigation observation distinct from draft focus preservation:
  after submission the input form legitimately disappears. Do not invent a
  `focus_preserved: true` observation for that route.
- Rerun the local desktop/mobile-viewport routes on the fixed product, build a
  new report, and retain the old pre-fix report as history.
- Verify Node 22 on Windows/Linux using isolated portable runtimes. Exercise
  Windows-browser-to-WSL-server routes where the environment permits. Record
  physical-phone, Tailscale and original Harness routes as unverified unless
  actually exercised; a narrow viewport does not substitute for a phone.
- Finish with independent code/requirements reviews, exact commands and
  measured evidence. No external publication is part of this audit.
