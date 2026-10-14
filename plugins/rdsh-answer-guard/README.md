# rdsh-answer-guard

Recover a DSH turn that produced no reader-visible answer, bundled with
[rdsh](https://github.com/jimoto-no-llm/rustdsh).

## The failure it recovers

On some routes the model ends a turn with its whole reply inside the reasoning
channel: the assistant message carries a `reasoning` block and no `text` block.
DSH treats that as a normal stop — `mapStopReason()` in
`@deepseek-ai/dsh-llm-pi-ai` raises `EMPTY_RESPONSE` only when the message has no
content at all, and a reasoning block is content — so the built-in retry never
fires and the turn closes as `completed`. The Web UI then folds that step as
process, and `hasAssistantReplyContent()` ignores reasoning blocks, so the
reader is shown no answer. The agent looks like it stopped responding until the
next prompt.

Measured on 2026-10-15 in one rustdsh review session
(`opencode-go/deepseek-v4.1-flash`, `reasoningEffort=high`): 7 of 18 turns ended
on a reasoning-only assistant message, including two consecutive turns where the
user had to send `?` to get anything at all. None of the 18 turns on the other
route showed it.

## What it does

The guard subscribes to committed session events and remembers whether the last
assistant message of each turn carried a reader-visible block (`text` with
non-whitespace content, or any non-text, non-reasoning block). When
`agent/turn-stopping` fires for that turn, and the reply was reasoning-only with
no pending tool call, it steers one short reminder into `agent.inbox.next-step`:

> Your previous assistant message contained no visible text: it was about to end
> the turn with only reasoning, so the reader was shown no answer. Do not repeat
> tool calls or redo the work. Restate the answer you already reached as
> ordinary text, outside any reasoning block, now.

`agent/turn-stopping` is a serial hook documented for exactly this: a listener
that steers makes the Agent Loop re-read its inbox, and fresh steering runs
another step. So the model restates its answer as ordinary text in the same
turn, and the reader sees it instead of an empty step.

Steering is bounded to one reminder per turn by default, so a model that only
ever emits reasoning cannot be steered in a loop. The reminder is stamped
`source.form = "notice"`, so it renders as a notice row and never as something
the user typed.

## Install

```sh
dsh plugin --profile web add /path/to/rustdsh/plugins/rdsh-answer-guard
```

`./plugins/install.sh` installs it together with the other bundled plugins, and
the patch entry is the usual one:

```yaml
- insert:
    - id: rdsh-answer-guard
      name: "rdsh-answer-guard"
      config: {}
```

The guard is on by default. Turn it off without uninstalling:

```sh
rdsh features off answer_guard
```

`config.maxNudges` in the patch entry changes the per-turn limit; `0` turns the
steering off while keeping the subscription.

## What it does not do

- It does not patch DSH internals and does not touch the provider request. It
  only reads the committed block kinds of the turn's last assistant message.
- It does not retry the model request, rewrite the reply, or hide the reasoning
  channel. It asks the model to restate what it already produced.
- It never inspects prompt text, model output, or credentials, and writes
  nothing to disk.

## Tests

```sh
node --test tests/answer-guard.test.mjs
```

The cases cover the recorded reasoning-only shape, visible text, whitespace-only
text, pending tool calls, turn and session isolation, the nudge bound, aborted
turns, and the `features.answer_guard` switch.
