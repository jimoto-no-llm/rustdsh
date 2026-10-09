# Metric freshness and main integration evidence

Issue: [#16](https://github.com/sahenjp/rustdsh/issues/16).
PR: [#90](https://github.com/sahenjp/rustdsh/pull/90).
Captured on 2026-10-06 JST after integrating main
`190dd7ce60ec051cdc5e52cd15950b182f820baa`.

## Before and after

Both screenshots are actual browser captures with the same synthetic project
reports. The before server loads the tracked dashboard modules from the main
commit above. The after server runs this PR. Each server has its own temporary
state, loopback port and credentials, with Tailscale disabled.

| Main before | This PR after |
| --- | --- |
| ![Main before](metric-freshness-before.png) | ![PR after](metric-freshness-after.png) |

A day-old $90.71 cost changes from a current numeric card to an old report with
its observation time. Three `done` reports change to one fresh completion report:
the other two are old or have no observation time. The overview uses the same
freshness rule as the detailed cards.

## Updates and interaction

![Actual partial update and idle expiry](metric-freshness-update.gif)

The three captured steps are [initial](metric-freshness-frame-1.png),
[partial update](metric-freshness-frame-2.png) and
[idle expiry](metric-freshness-frame-3.png). A fresh cache report initially shows
80.0%. Updating only the cached counter changes the ratio to `比較不可`, since
the numerator and denominator no longer belong to one snapshot. The new report
has an eight-second lifetime; the next periodic check, without another state
update, shows `古い情報`. None of these updates refreshes the old cost.

At each step the unsent answer draft, textarea focus and expanded source details
remain intact. The latest main's command palette opens and closes correctly.
All four provenance labels render. A source containing an HTML image tag remains
text, with zero images inserted in the event feed. Browser error/warning logs
are empty. The 1280px viewport has document width 1265px and no horizontal overflow.

## Validation

- Windows Node 24.18.0: `npm ci && npm test`, 18 tests passed, none skipped.
- WSL: `cargo fmt --check`, release clippy with warnings denied, release tests
  (62 passed), release build and `tests/regress.sh` (41 checks passed).
- JavaScript syntax and Git whitespace checks passed.

These captures verify local rendering and interaction using declared reports.
They do not establish independent provider measurements, acceptance approval,
physical-phone/Tailscale access or Production adoption. The unrelated local
Windows setup files are outside this change.

## Current-main re-review, 2026-10-08

Source `b17358ca2968f57f1f53f292c65b88ab3e2ddf0f` integrates main
`98abc67d7e5c5d3f2a5321d9a56adb6a83ff93e2`. It retains the current typed
question cards, reply application, input queue, budget and source-specific cost
ledger, and extends freshness checks into main's project/task overview.
The legacy cumulative report is clearly separate from the cost ledger.
Removed main's tracked host-specific `dashboard/node_modules` symlink.

The exact current source passed all 193 dashboard tests on Linux Node 24,
with zero skips. Windows Node 22 passed 192 dashboard tests on the prior
`418508c` integration and 15 focused observation/overview tests for the added
overview logic. These are separate source-pinned runs; current platform and
browser CI remain merge gates.

Installed Windows Chrome used the production HTTP server and durable state in
a disposable fixture at 1440 and 390 px. The before proxy serves main's actual
HTML, app and overview modules against the same fixture/backend. No model,
credential import, real tool or paid API ran. The
[sanitized browser record](metric-freshness-main-browser.json) pins both sources.

![Current main before freshness integration](metric-freshness-main-before.png)

![Current dashboard with source and age labels](metric-freshness-main-after.png)

![Actual initial, partial and idle-expiry sequence](metric-freshness-main-flow.gif)

The fixture's four completed tasks yield one fresh completion report, one stale,
one unknown-age and one estimate. The overview labels the old result and its
source; it continues saying the execution state is unobserved. The cache ratio
changes from 80.0% to `比較不可` after a partial report, then to `古い情報` after
eight seconds and the next poll, without another state event.

An unsent consultation retains its text, focus and selection through updates.
Expanded source details remain open. Cancelling one approval and expiring one
consultation leaves one pending question and zero answers. All four provenance
labels are visible; external markup remains literal text with zero inserted
images, page errors or horizontal overflow.

![390 px current-main integration](metric-freshness-main-mobile.png)

![Selected task overview retains unobserved execution](metric-freshness-main-task.png)
