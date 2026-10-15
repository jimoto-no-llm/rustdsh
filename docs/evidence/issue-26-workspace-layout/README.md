# Issue #26 workspace layout evidence

The screenshots are real Chromium captures of the project dashboard served by the local Node project CLI. Both use a synthetic task and question over local HTTP MCP at 1280×900; no provider calls, Tailscale, desktop shell, or production project data were involved.

- `before.png` was captured from source commit `fb051f8fc8de77248ecf0da148b215f6b261147d`. The existing status view occupies the first screen, the workspace layout controls are hidden (`visible_layout_controls: 0`), and 29 element IDs are duplicated in the DOM.
- `after.png` was captured from PR head `cecba5ce715e0f320ce300b3492bf941aaa7d8df`. The three existing panes and layout controls render in the first screen (`visible_layout_controls: 1`); the DOM has no duplicate IDs.
- `before.json` and `after.json` record source commits, capture scenario, and DOM observations for those screenshots.

This is a technical UI comparison for the scoped duplicate-markup fix. It does not complete Issue #26's arbitrary pane rearrangement, terminal/conversation, diff, or preview acceptance requirements.
