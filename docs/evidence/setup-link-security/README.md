# Setup external-link boundary

The key-issuance button now calls `window.open` with `noopener` so the opened
page does not receive an opener reference to the local setup page.

Real captures of the isolated native `rdsh setup --web` server:
[before](before.png), [after](after.png). Both used empty temporary HOME and
DSH_HOME, separate authenticated local servers, and a fresh browser context.
Appearance is unchanged; this change adds no animation or navigation flow.

[Browser observations](observations.json) record the actual button handler and
the arguments emitted by clicking it. During the click check, `window.open`
was replaced by an argument recorder, and external network requests were
blocked. No provider page, real credential, or Muse session was included in
these captures. The button still selects the same provider URL and `_blank`;
only the `noopener` feature was added.
