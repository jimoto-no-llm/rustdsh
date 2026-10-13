# rdsh-translation

Adds a Web UI action to translate a settled text-only answer into Japanese and
replace that one answer on DSH's model-visible session surface. The append-only
session log retains the original event; the replacement source also retains its
text for the collapsed “元の回答を表示” disclosure.

The translation is one standalone `ctx.llm.stream()` request under an idle-phase
`agent.runMaintenance()` lock. It does not create a turn or add a user request.
The command lifecycle and one `user/message` surface replacement are the only
new session records. The original answer must still be on the surface; a message
already shadowed by `/compact` fails with a visible command error.

The Web action appears for settled text-only answers whose kana ratio is below
`translation.kana_threshold` (default `0.08`). The command can also be entered
as `/ja <message-id>` when the heuristic misses an answer. Adjust the threshold
in `$DSH_HOME/rdsh.json`:

```json
{
  "translation": {
    "kana_threshold": 0.08
  }
}
```

An optional cheaper route requires both fields; if either is absent, the
current agent route is used:

```json
{
  "translation": {
    "kana_threshold": 0.08,
    "provider": "provider-id",
    "model": "model-id"
  }
}
```

Fenced and inline code, URLs, flags, common path forms, file extensions,
snake_case, and camelCase identifiers are replaced by checked placeholders
before the model call and restored exactly. If the model drops or changes one,
the translation is rejected and the answer is not replaced. The current
implementation accepts text-only answers; mixed media and tool-call messages
are not offered.

Each replacement starts a new request series and may reissue `request/header`;
the new surface invalidates request caches after the replaced answer. This is a
one-time cost for the translation. Like/Dislike feedback remains attached to
the original assistant message and cannot be applied to the replacement-origin
user message (`target-not-found` in DSH message feedback).

DSH 0.2.0-rc.2 exposes idle surface replacement through a `user/message`
checkpoint. That means subsequent model context sees the translated text with a
user role; the original assistant role is not preserved by this upstream API.
The plugin uses this supported replacement path to avoid adding a turn, and
keeps the original answer available in the collapsed disclosure. Preserving the
assistant role needs an upstream message-projection/replacement contract.

The replacement uses the `compact-checkpoint` source kind without a
`compactionId` so the DSH 0.2.0-rc.2 generic user-message and compaction renderers
do not show it as a regular user bubble. The plugin provides the dedicated
`conversation.chat.node` view and hides the original assistant card by its keyed
chat-row identity. Keep the DSH UI contract pinned while this renderer depends
on that key format.

Tests exercise the kana gate, final/interrupted message filtering, protected
literal restoration, and the DSH session invariant with synthetic events. No
real provider or model is needed for those checks.
