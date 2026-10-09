# Discord Rich Presence verification

Verified on 2026-10-09 in WSL, with Windows Discord and installed original DSH 0.2.0-rc.2.

The shared application is `1557873849280888903`. Its public registered icon is now
`3abd404070c831dcaa59310cc29982df`. The bundled `plugins/rdsh-settings/assets/rushDSH.png`
matches the user's supplied PNG byte for byte (SHA-256
`ad3e5003f51188335d5e54b0fa2b636ca37089cfd0d83fb715ef461f17656726`).
Discord's resized PNG was also compared against the source: mean absolute RGB
difference after resizing and compositing on white was 1.18–1.31 out of 255.
No image edits were applied to the supplied file.

| Check | Result |
| --- | --- |
| Rust regression suite | 105 passed |
| JavaScript regression suite | 65 passed, one existing skipped test |
| Original DSH Web settings | Save, partial save, draft preservation, reload, corrupt-file error and recovery passed |
| Icon delivery | Authenticated GET returns the supplied PNG exactly; HEAD and rejection checks passed |
| Settings layout | Desktop 1280×900 and mobile 390×844 inspected; no horizontal overflow in the mobile section |
| Original DSH AgentLoop | Idle → two genuinely running agents → idle; work held before model dispatch |
| WSL bridge fixture | Windows named pipe, Windows PID, Unicode, ACK, fragmentation and clearing passed |
| Live Windows Discord | New icon, details, agent count, status display type, timestamps and button acknowledged; clearing acknowledged |
| Public icon refresh | Cache, registered-image changes and offline fallback passed; live public metadata resolved the new icon |
| Formatting / diff | `cargo fmt -- --check` and `git diff --check` passed |

The live result is in `target/discord-live/new-icon.json`. It records only selected
activity acknowledgement fields, no Discord account data. No provider calls were
made and no persistent user configuration was changed. Temporary presence was
cleared after the test. RPC acceptance does not independently verify the Windows
profile rendering; the Windows GUI capture tool could not launch its app server.
Rich Presence buttons are shown to other users, rather than the author's own profile.

The settings screenshots use a temporary DSH profile. Its default-workspace warning
comes from that isolated host environment.

- [Desktop settings](discord-presence/settings-desktop.png)
- [Mobile settings](discord-presence/settings-mobile.png)

Diff review: correctness 3/3, project conventions 3/3, test evidence 3/3; no blockers.
The mobile host adjustment uses semantic settings-modal anchors and is scoped to
the mounted rdsh section. The bundled icon follows the provided asset, and runtime
Discord imagery follows the shared application's public registration.

## Persistent runtime follow-up (2026-10-09)

The subsequent report that RPC was absent concerned the regular DSH service. Its
user settings file was missing, so presence remained disabled, and the running
process retained the older settings plugin. The service also had neither
`WSL_DISTRO_NAME` nor Windows executables in its `PATH`.

Presence is now enabled in `/home/sahen/.dsh/rdsh.json` (mode 0600). The web profile
overlay reloads only the settings plugin with a fresh module URL; the existing DSH
process and its working agents were left running. The previous overlay was backed
up under `/home/sahen/.dsh/backups/discord-rpc-1791531257850/`.

WSL detection now also checks the kernel release, and the bridge uses the installed
Windows PowerShell executable by absolute path when available. This supports the
service's restricted environment as well as an interactive WSL shell.

| Follow-up check | Result |
| --- | --- |
| JavaScript regression suite | 68 passed, one existing skipped test |
| WSL bridge without inherited WSL variables or Windows PATH | Handshake, Windows PID, Japanese activity, ACK and fixture clearing passed |
| Existing DSH service | Connected; persistent settings enabled; actual running-agent changes acknowledged |
| Windows profile rendering | User explicitly confirmed that the activity appeared |

Selected runtime evidence is saved in `target/discord-live/persistent.json`, without
credentials or Discord account data. The regular service continues publishing
presence; only the isolated bridge fixture was cleared during this follow-up.
