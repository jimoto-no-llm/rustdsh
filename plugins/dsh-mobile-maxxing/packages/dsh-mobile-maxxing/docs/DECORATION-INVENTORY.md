# Desktop / mobile boundary (#44) and right-panel layering (#46)

The boundary is the **device mode**, not the window width. A host bootstrap
classifies the device once and writes `globalThis.__RDSH_DEVICE_MODE__` for every
mode plus, in mobile mode only, `html[data-rdsh-device-mode]` (a desktop document
carries no marker). The client resolves
the mode in this order: a valid `__RDSH_DEVICE_MODE__`, then a valid
`data-rdsh-device-mode` attribute, then `"desktop"` (fail closed); it never
re-classifies. Phones and tablets get the mobile surface at any width; ordinary
PCs, Windows touch laptops and narrow desktop windows stay desktop. Resizing
never changes the mode. Width is geometry only (the Settings readout and
genuinely responsive sizing). This deliberately supersedes the original #44
width-only specification per direct user request.

## Stylesheets

`client.js` builds the layout from two constants:

| Constant | Contents |
| --- | --- |
| `CSS_DEVICE` | Only this plugin's own chrome: `.rdsh-mux-toast` and the Settings cards. Always present. No upstream selector. |
| `CSS_PHONE` | Every rule that reshapes upstream in mobile mode (drawer, right panel, composer, transcript, question cards, queue, workspace picker, settings navigation, animations, session/folder colour frames, safe-area root padding). |

There is **no `@media (max-width: 767px)` wrapper**. The mobile half is a
separate `<style data-rdsh-mux-style="phone">` appended only when the
bootstrapped mode is `"mobile"`; a desktop never receives it and a resize never
adds or removes it. Sizing-only breakpoints may still live inside `CSS_PHONE`
(the 768px tablet dock tier and the 380px composer compression are the two today).
The tablet tier still only exists when the device mode is `"mobile"`; it does not
re-introduce a width mode switch. The PWA install/toast
geometry uses `html[data-rdsh-device-mode="mobile"]` instead of a width query.
`boundary-issues.test.mjs` and `pc-parity.test.mjs` pin the style split, and
fail if a width feature query or the old wrapper comes back.

## Decoration inventory

Each function is called from `decorateFast()` / `decorateSlow()` unless noted.
"Mobile only" means it returns early (and clears a previous pass) in desktop
mode. The mode never changes during a page, so the cleanup path is dispose
(plus the defensive desktop-boot sweep).

| Function | Offers on upstream DOM | Guard | Cleanup on dispose |
| --- | --- | --- | --- |
| `decorateFast` frame/columns/sidebar/drawer | `data-rdsh-frame`, `-center-col`, `-rightbar-col`, `-sidebar`, `-drawer` | mobile mode only | attributes removed |
| `decorateFast` header/crumbs/conversation | `data-rdsh-header`, `-crumbs`, `-conversation` | mobile mode only | attributes removed |
| `decorateFast` `data-rdsh-anim` | animation choice | mobile mode only | attribute removed |
| `decorateFast` `data-rdsh-hide-settings` | hidden-control switch | mobile mode only (`onPhone && !hideDisabled`) | attribute removed |
| `decorateSessionRows` | row/status/title/running/ring/open/minor hooks **and** the session/folder colour frames | mobile mode only | `clearSessionRowHooks()` removes all, including both frame variables, and `clearFolderMenu()` drops the claimed workspace-menu row |
| `decorateEditCards` | edit card/header/row | mobile mode only | attributes removed before the scan |
| `decorateTranscript` | transcript column hooks | mobile mode only | attributes removed |
| `decorateUserBubbles` | user stack/bubble | mobile mode only | attributes removed |
| `decorateRightPanel` | panel node + `data-rdsh-rightpanel-open`, observers, `--rdsh-rightbar-width` | mobile mode only | `forgetRightPanel()` clears the attribute, the width variable and the observers |
| `decorateRightPanelTabs` | `data-rdsh-rtab` | mobile mode only | attribute removed |
| `decorateCodePreview` | code pre/scroll locks | mobile mode only | attributes removed |
| `decorateQuestionCards` / `decorateQuestionArrow` | question card/frame/tile/typing + injected arrow button; Enter/CMD-Enter and required-selection listeners | mobile mode only | attributes + arrows removed |
| `decorateTodoPanel` | todo row text/status/tab/title | mobile mode only | attributes restored/removed via `clearDetailPanelHooks()` |
| `decorateGoalBar` | goal objective/actions/editing, role/tab/title | mobile mode only | same |
| `decorateHeaderTitle` | header title/running | mobile mode only | attributes removed |
| `decorateHeaderActivityChips` | chip hook, generated icon/spinner nodes | mobile mode only | generated nodes removed, native spinner attributes cleared |
| `decorateSessionTitleTyping` | typing attribute/overlay/caret | mobile mode only | controllers cancelled, overlay removed |
| `decorateToasts` | toast hook + swipe listeners | mobile mode only | listeners removed (`toastSwipeState`), inline transform/opacity cleared |
| `decorateModelSearch` | model search row/input disabled | mobile mode only | pointer listener removed, `disabled` restored |
| `installSettingsNavArrows` | arrow nodes + list observers/listeners | mobile mode only | nodes, listeners, observers and flags removed |
| `decorateStatsDock` | stat text attributes | mobile mode only | attributes removed |
| `decorateLightbox` | crop button, lightbox/swipe hooks | mobile mode only | button removed, attributes removed (WeakSet keeps swipe listeners single) |
| `decorateQueueDock` | queue dock/panel/rows, inline `margin-bottom`, preview `title`/`tabindex` | mobile mode only | inline margin cleared; upstream `title`/`tabindex` restored from a WeakMap |
| `decorateWorkspacePicker` | search row, viewport/hidden hooks | mobile mode only | `clearWorkspacePicker()` |
| `decorateComposer` | `+` label, model button, composer root/dock | mobile mode only | `clearComposerHooks()` restores only the label this module wrote |
| `decorateSidebarSettingsRow` | injected Settings row, `data-rdsh-more-row` | `phone()` | nodes/attributes removed |
| `decorateSidebarToggle` | drawer toggle hook | mobile mode only | attribute removed |
| `decorateRouteHeading` | route heading inset | mobile mode only | attribute cleared |
| `markScrollers` | scroll hooks | mobile mode only | attribute removed |
| `installDrawer` | FAB + backdrop nodes | mobile mode only (boot) | nodes removed by `removeDrawerNodes()` |
| `enforceNoZoomViewport` | viewport `content` | mobile mode only | original value restored (a missing `content` attribute is restored as missing; a meta this module created is removed) |
| `applyDeviceTheme` | per-device palette/`theme-color`/`data-rdsh-device-theme` | mobile mode only | `releaseDeviceTheme()` restores the captured baseline; never writes the shared theme |
| `measureSafeArea` | `data-rdsh-safe-*`, `data-rdsh-native-gap`, `--rdsh-safe-*`, `--rdsh-native-gap-px` | mobile mode only | `releaseSafeArea()` |

`clearPhoneHooks()` is the single transition/dispose path: it closes menus and
popovers, cancels listeners/observers, removes generated nodes, strips every
attribute in `PHONE_HOOKS`, restores inline styles and the viewport, then
releases the device palette and safe-area writes. `decorate()` also fails safe:
a MutationObserver pass on a wide window only clears, never tags.

Queued work cannot undo that cleanup: the boot effect owns a `live` flag, so a
decorate frame requested before dispose is a no-op; the theme effect keeps its
own `active` flag for its rAF and `theme/change` microtask; and
`releaseDeviceTheme()` bumps `deviceThemeCheck` so a queued verification frame
cannot retry the palette. `boundary-issues.test.mjs` disposes with those frames
still queued, flushes them, and asserts the viewport, palette, animation and
drawer state stay released.

## Desktop is a hard no-op

`client.js` resolves the mode before it builds anything and returns
`{ apply() {} }` for a desktop. A PC therefore gets **no part of this package**:
no PWA shell (no manifest handling, no service worker registration),
no Settings cards or tabs, no terminal touch bridge, and no
listener, style, timer, fetch or storage read. Every surface described in this
document is mobile mode only.

The Settings → Mobile cards expose a per-browser opt-in
(`notifyDeviceTurns`) for receiving desktop-originated turns on a mobile device;
it is a mobile-side choice and is never read on a PC.

## One settings contribution

Only `mobile-ux` is registered in `settings.section`, labelled Mobile. Input and
PWA settings are rendered inside that section, without separate tab registration
or label-based hiding. The section retains theme, notifications/sound, Enter
behavior and app installation/update/status. Hidden-control list/customisation,
basic UI readouts, screen-size metrics and scroll diagnostics (including their
recording listener) are removed. Standard control hiding remains; old browser
hide overrides are ignored without deleting storage.

Device-local additions live in the same section: font sizes (text/code/terminal), UI
language from the registered catalog (`ja` only when the separate optional
`dsh-locale-ja` package owns it), and a default permission preset. Storage keys are
`rdsh-mobile-ux:local-permission` and `rdsh-mobile-ux:local-display`; no Host writer is
called. The permission preset is applied through the opened session's own `/permission`
command, using the public `uiWorkspace.openWorkspaceSession(beforeOpen)` contract plus
`ctx.sessions.using`. Theme and locale are projected onto a device snapshot (public
`getTheme`/`getSnapshot` shape), restored on teardown. The four chat-view preferences are
absent: the render-erased `slots.entries()` view keeps only id/order, so upstream policy
stores cannot be reached without a shared Host write.

## #46 layering

The open panel no longer sets `display: none` (or `visibility`) on the header.
The header stays in flow, so its rect is identical open/closed and the chat
does not jump. The panel's positioned column and the upstream
`[data-sidebar-right-panel]` root are raised with `z-index: 60`; the tagged
layer gets `isolation: isolate` **without** overriding upstream's `position:
absolute`. Verified in `boundary-issues.test.mjs` (source contract) and with a
real Chrome/CDP fixture: 10 open/close frames keep one header rect,
`elementFromPoint` hits the panel, and a desktop boot never receives the mobile
sheet.
