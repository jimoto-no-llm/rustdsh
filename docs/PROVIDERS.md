# Provider routes: HAI, Command Code, Sarashina, Ollama and home LLM servers

`rdsh provider` registers an OpenAI-compatible endpoint as a DeepSeek Harness
(dsh) route, so the model appears in dsh's model picker without editing YAML by
hand. dsh bundles a catalog of known providers; anything outside it (HAI,
Command Code, a llama.cpp or vLLM server on your LAN) has to be declared under
`llm-pi-ai` in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` with an `api`, a
`baseURL`, an `apiKeyEnv` and a non-empty `models:` list. This command writes
that block.

```sh
rdsh provider list [--json]
rdsh provider add hai [options]
rdsh provider add commandcode [options]
rdsh provider add sarashina [options]
rdsh provider add ollama [options]
rdsh provider detect [--json]
rdsh provider import [options]
rdsh provider add local-openai --base-url <url> [options]
```

## What gets written

```yaml
- id: llm-pi-ai
  config:
    providers:
      hai:
        displayName: HAI
        apiKeyEnv: HAI_API_KEY
        api: openai-completions
        baseURL: https://hai-api.hcloud.ltd/v1
        models:
          - id: deepseek-v4-flash
            name: DeepSeek V4 Flash (HAI)
            contextWindow: 1048576
            maxTokens: 16384
            input: [text, image]
```

A Cordis override replaces a whole entry config, so the block is inserted
inside the existing `providers:` mapping. Other routes, comments, ordering and
line endings are kept byte for byte, and the file is replaced atomically under
the profile lock. If there is no `llm-pi-ai` entry, one is appended.

- A route that already exists is left alone (the command prints that and exits
  successfully). `--replace` rewrites exactly that block.
- If the structure cannot be placed safely (for example `providers: {}` written
  inline, an `llm-pi-ai` entry inside `insert`, multiple matching entries or
  identifiers using aliases, tags or folded YAML), nothing is written and the
  YAML to add by hand is printed. Only direct entry identifiers are inspected;
  identifiers inside a plugin's config do not identify that plugin. Inserted
  entries must use block mappings; flow, alias, scalar or complex entries are
  refused when their identity cannot be inspected safely. An outer `insert`
  entry's `config` is not applied by Cordis.
- `config` and `providers` must be block mappings. Sequences, duplicate block
  mapping keys (including existing provider/model fields) and keys with YAML
  tags, anchors or aliases are refused before the profile or
  key changes. Unicode characters such as NBSP remain part of an identifier;
  mapping and sequence block-scalar prompt text is preserved as text and is
  not inspected as keys.
- Structural columns use ASCII whitespace. Plain mapping keys starting with
  Unicode whitespace are unsupported and refused before any write.
- Single-line quoted keys and identifiers support YAML escapes; decoded
  duplicate keys are still refused, and non-target scalar contents are kept.
- `provider list` remains read-only and can inspect existing routes when an
  unrelated plugin uses a form that `provider add` will not edit.
- Appending an entry, config, providers mapping or route is refused if its
  separating newline would change the value of a final block scalar. Strip
  chomping and already terminated scalar values keep their supported insertion
  paths. `--replace` still replaces the selected route's whole block.
  Content includes tabs and spaces beyond the scalar's content indentation;
  an all-space empty scalar remains supported when the newline preserves it.
- `--dry-run` shows what would change and writes nothing, including no key.
- `--profile <name>` picks the profile; without it the usual default applies
  (`RDSH_DEFAULT_PROFILE`, `general.default_profile`, else a local `tui`).
  The profile directory must already exist.

Common options:

| Option | Meaning |
| --- | --- |
| `--model <id>` | Declare a model (repeatable). |
| `--discover` | Read ids from `GET {baseURL}/models` (`data[].id`, or Ollama-style `models[].name`). |
| `--from-opencode` | Take `baseURL` and models from opencode's `provider.<id>` entry. |
| `--base-url <url>` | `http://` or `https://`, no user:pass@, no spaces. |
| `--key-stdin` | Read the API key from one line on stdin. |
| `--replace` | Rewrite the route block if it exists. |
| `--dry-run`, `--json` | Preview only; machine-readable report. |

Models are merged in this order: `--model`, opencode, discovery; duplicates are
folded by id and keep the richest metadata. If no model is found, the command
fails without writing. Only fields a source states are written; anything else
falls back to dsh's route defaults (`defaultContextWindow`, `defaultMaxTokens`,
`defaultInput`, which is `[text]`). Add `input: [text, image]` or a window to
the YAML yourself when the server documents them.

## API keys

The key is never accepted on the command line. Give it as the route's
environment variable (for example `HAI_API_KEY`) or on stdin with
`--key-stdin`; it is stored in `$DSH_HOME/.credentials.yaml` (mode 0600) under
that name. The value is not printed by any command, `--json` included, and
discovery over https passes it to `curl` through a config on stdin, not argv.

- An environment variable fills the ref only when none exists; `--key-stdin`
  always overwrites it.
- If no key is given and none is stored, the route is still written and the
  command says the key is missing.
- `rdsh auth` reports a profile's default model route as `credential ok` or
  `credential missing` together with the key name. `rdsh setup` offers to
  persist each well-known key present in the environment plus every name a
  profile declares through `apiKeyEnv` (one y/N prompt per key; `--yes` saves
  nothing and no value is ever printed). Store the key with `rdsh provider add`
  as above, or with the setup UI's key endpoint: it accepts the well-known
  names and any profile-declared `apiKeyEnv` that matches
  `^[A-Z][A-Z0-9_]+$`, and refuses everything else before writing.
- An exported route key (`HAI_API_KEY`, `LOCAL_OPENAI_API_KEY`,
  `SARASHINA_API_KEY`, `COMMANDCODE_API_KEY`) alone does not count as a
  connection in `rdsh setup` or the first-run banner: it counts only when a
  profile's default model uses a registered route that declares exactly that
  key.
- A plugin entry inside `insert` that identifies `llm-pi-ai` is refused with
  the YAML to add by hand: appending another entry could replace the inserted
  definition's config. A model id or prompt mentioning that text does not
  identify a plugin.

## HAI

```sh
HAI_API_KEY=... rdsh provider add hai --profile web --model deepseek-v4-flash
printf '%s\n' "$KEY" | rdsh provider add hai --from-opencode --key-stdin
```

Preset: route `hai`, display name `HAI`, `api: openai-completions`, base URL
`https://hai-api.hcloud.ltd/v1`, key `HAI_API_KEY`.

`--from-opencode` reads `opencode.jsonc` or `opencode.json` from
`$XDG_CONFIG_HOME/opencode/` (or `~/.config/opencode/`). Comments, URLs inside
strings and trailing commas are handled. It uses `name`, `limit.context`,
`limit.output` and `modalities.input` (text and image only); its `apiKey` is
never read.

**HAI allows one concurrent connection.** When requests go through the serial
proxy, point the route at it instead of the upstream address:

```sh
rdsh provider add hai --base-url http://127.0.0.1:18080/v1 --model deepseek-v4-flash --replace
```

## Sarashina

```sh
SARASHINA_API_KEY=... rdsh provider add sarashina
rdsh provider add sarashina --profile web --model sarashina3-mini
```

Preset: route `sarashina`, display name `Sarashina`, `api: openai-completions`,
base URL `https://api.sarashina.ai/v1`, key `SARASHINA_API_KEY`. Issue a key at
<https://chat.sarashina.ai/dashboard/api-keys>.

Without `--model` the two documented chat models are written, and `--model`
replaces them:

```yaml
      sarashina:
        displayName: Sarashina
        apiKeyEnv: SARASHINA_API_KEY
        api: openai-completions
        baseURL: https://api.sarashina.ai/v1
        compat:
          supportsStore: false
          supportsUsageInStreaming: false
        models:
          - id: sarashina3-mini
            name: Sarashina3 mini
            contextWindow: 128000
            maxTokens: 8000
            input: [text]
          - id: sarashina3-nano
            name: Sarashina3 nano
            contextWindow: 128000
            maxTokens: 8000
            input: [text]
```

Why these lines exist: the API answers 400 for request fields it does not
document, and dsh (pi-ai `openai-completions`) sends `stream_options` and
`store` by default. `compat.supportsUsageInStreaming: false` and
`compat.supportsStore: false` stop both. `max_completion_tokens` must be
1-8000, while dsh defaults to 32768, so every Sarashina model gets
`maxTokens: 8000` (a smaller explicit limit from opencode is kept).

- `--model <id>` for `sarashina3-mini` / `sarashina3-nano` fills the name,
  `contextWindow` and `input` above. For any other id only `maxTokens: 8000` is
  written and a note says that only those two are chat models in the docs
  (`sarashina3-guard` is a judge model without tools).
- `--discover` is refused before anything is written: `GET /models` answers
  404. `--from-opencode` works as for the other presets.
- `--replace` rewrites the whole block, `compat:` included.

**`tool_choice` and the main agent.** When `tools` are sent, the API defaults
`tool_choice` to `required`. dsh / pi-ai never sends `tool_choice` and has no
compat switch for it, so dsh agent turns are expected to be forced into tool
calls. This is not verified. Treat Sarashina as unsuitable for the main agent
model until it is; tool-free requests such as title generation are not
affected. Rewriting the request body (injecting `tool_choice: auto`) is out of
scope here.

Limits and terms (checked 2026-10-14):

- Rate limits use fixed 60-second windows: `sarashina3-mini` 6 RPM,
  `sarashina3-nano` 60 RPM. A 429 carries no `Retry-After`.
- During the free beta, inputs and outputs may be used to improve the models.

Sources: <https://docs.sarashina.ai/api-reference/chat-completions> and
<https://docs.sarashina.ai/rate-limits>

## Command Code

```sh
COMMANDCODE_API_KEY=... rdsh provider add commandcode --model deepseek/deepseek-v4-flash
COMMANDCODE_API_KEY=... rdsh provider add commandcode --discover
```

Preset: route `commandcode`, display name `Command Code`,
`api: openai-completions`, base URL `https://api.commandcode.ai/provider/v1`,
key `COMMANDCODE_API_KEY`. Create a key in Command Code Studio
(<https://commandcode.ai/studio/>); the same key authenticates the CLI and the
API. Chat model ids use the documented `vendor/model` form
(`deepseek/deepseek-v4-flash`), so `--model` takes that id verbatim;
`--discover` reads the live list from `GET {baseURL}/models`. There is no
built-in default model: pass `--model`, use `--discover`, or let
`--from-opencode` supply one.

Provider API shape (checked 2026-10-17 against
<https://commandcode.ai/docs/provider>):

- `POST /chat/completions` (OpenAI shape), `POST /messages` (Anthropic shape)
  and `GET /models` under base URL `https://api.commandcode.ai/provider/v1`,
  with `Authorization: Bearer <key>` on every route (`/messages` also accepts
  `x-api-key`).
- Every plan except **Go** has API access (GOAT, Pro, Max, Team and the
  pay-as-you-go Provider plan). A Go-plan key answers `403` with code
  `upgrade_required`; upgrade the plan rather than retrying.
- Claude models are served only on `/messages` and use bare names
  (`claude-sonnet-4-6`); sending one to `/chat/completions` answers `400`.
  This preset only writes `/chat/completions` routes.

The Anthropic route is a hand-written entry, because `provider add` writes
`openai-completions` routes only:

```yaml
      commandcode-anthropic:
        displayName: Command Code (Claude)
        apiKeyEnv: COMMANDCODE_API_KEY
        api: anthropic-messages
        baseURL: https://api.commandcode.ai/provider/v1
        models:
          - id: claude-sonnet-4-6
```

This route is not verified against a live account: the model list differs by
plan, and a Claude model sent to the wrong endpoint fails with `400`. Zero data
retention (`x-cmd-zdr: 1` on `/chat/completions`, answered with `422`
`cmd_zdr_no_providers` when the model has no ZDR-capable upstream) is not
written by this preset; `headers` injection is tracked separately in #484.
On `/messages` the header is accepted but does not change routing.

## Detection and import (`detect`, `import`)

```sh
rdsh provider detect [--json]
rdsh provider import [--profile web] [--only <route>] [--no-discover] [--json] [--dry-run]
```

`detect` reads the machine and reports two buckets. It writes nothing.

- **dsh can use these as-is** — the provider is in dsh's own catalog, so a
  route would only duplicate what dsh already resolves. The evidence is an
  environment variable (`env:OPENAI_API_KEY`), a key dsh stored under that
  name (`dsh:credentials(DEEPSEEK_API_KEY)`), or another tool's config file
  that mentions a key (`file:~/.codex/auth.json`).
- **rdsh can register these routes** — presets whose key is on this machine, a
  local server that is listening (11434 Ollama, 8080 llama.cpp, 8000 vLLM, 1234
  LM Studio), and custom providers declared in OpenCode's `provider.<id>`
  block.

`import` then writes the second bucket, reading model ids from `GET /models`
unless the OpenCode entry already named them. A candidate whose key is missing
is reported as unregistered and left alone; it never stores a guess.

`rdsh setup` runs the same scan and registers what it finds: every route that is
writable is written for the default profile without asking, so a fresh install already has
the local server it can see. Existing routes are left untouched, nothing is registered for a
route whose key is missing, and `rdsh setup --no-auto-import` (or `--dry-run`) turns the
automatic part off. `rdsh setup --web` does the same before it opens the page, and the page
shows each route as registered.

Key values are never printed, and keys belonging to other tools are never
copied: the report only says where one was found. Store a key explicitly with
`rdsh provider add <preset> --key-stdin` when you want rdsh to keep it.

```sh
rdsh provider detect                 # what this machine can reach
rdsh provider import --dry-run       # what would be written
rdsh provider import --only ollama   # just one route
```

`import` follows the same rules as `add`: an existing route is left
untouched (use `add --replace`), and an entry that cannot be placed safely is
refused instead of guessed.

## Ollama

```sh
rdsh provider add ollama
rdsh provider add ollama --discover --model qwen3:8b --effort low,medium,high
```

Ollama speaks the OpenAI-compatible API on `http://127.0.0.1:11434/v1` and
authenticates nobody, so the route is registered with the `ollama` id, the
fixed base URL and the `no-key` placeholder under `OLLAMA_API_KEY`. No key
input is needed; `--no-key` stays accepted for symmetry with `local-openai`.
Pass `--base-url` to reach an Ollama on another host.

Ollama Cloud (`rdsh provider add ollama-cloud`) serves the hosted catalog on
`https://ollama.com/v1` and wants a real key. It keeps its key under
`OLLAMA_CLOUD_API_KEY`, apart from the local route, so the local placeholder
never stands in for a cloud key.

The preset declares `gpt-oss:20b` (131,072 context, 32,768 output) and the
three thinking levels that model publishes. Ids that come from `--model` or
`--discover` get no levels: Ollama reports thinking support through
`POST /api/show`, not through `/v1/models`, so rdsh does not assume one list
fits every model. Add the levels with `--effort`, and see [Reasoning levels]
(#reasoning-levels---effort) below.

## Reasoning levels (`--effort`)

dsh only offers a reasoning level when the model publishes one. Models in its
catalog carry their own; for anything else dsh treats the model as
non-reasoning unless the route states `reasoningEfforts:` by hand. `--effort`
writes that block for every model of the route:

```sh
rdsh provider add ollama --effort low,medium,high          # label and value are the same
rdsh provider add ollama --effort "minimal=low,deep=high"  # label=value
rdsh provider add ollama --effort none                     # no block: non-reasoning
```

```yaml
          - id: gpt-oss:20b
            reasoningEfforts:
              low: low
              medium: medium
              high: high
```

The label is what the model picker shows and the value is what dsh sends as
`reasoning_effort`, so a server that expects different words can be given
`quick=low`. `--effort none` removes the block on `--replace`, which is how a
model is declared non-reasoning. `rdsh provider add` prints the levels it
wrote, and `--json` reports them under `reasoningEfforts`.

A model whose server exposes no effort capability simply receives none: rdsh
does not assume one list fits every model, and leaves hand-written
`reasoningEfforts:` alone unless the whole block is replaced.

## Home servers (`local-openai`)

```sh
rdsh provider add local-openai --base-url http://192.168.1.20:8080/v1 --discover --no-key
rdsh provider add local-openai --id home-gpu --name "Home GPU" \
  --base-url http://gpu.lan:8000/v1 --discover --key-stdin
```

The default route id is `local-openai` with key `LOCAL_OPENAI_API_KEY`. `--id`
adds more servers side by side: the key name is the id upper-cased with `-`
turned into `_` plus `_API_KEY` (`home-gpu` gives `HOME_GPU_API_KEY`). The id
uses lowercase letters, digits and `-`, starting with a letter.

`--no-key` is for servers that need none: dsh still looks the key up by name,
so a non-secret placeholder (`no-key`) is stored under it. An existing real key
is not overwritten.

Typical base URLs:

| Server | Base URL |
| --- | --- |
| llama.cpp `llama-server` | `http://host:8080/v1` |
| vLLM | `http://host:8000/v1` |
| LM Studio | `http://host:1234/v1` |
| Ollama | `http://host:11434/v1` (or the `ollama` preset) |

`--discover` over `http://` uses a plain built-in HTTP client; over `https://`
it runs `curl`, pinned to https with a 30 second timeout and an 8 MiB cap.

Over a LAN these are plain `http` and usually unauthenticated: anyone on the
network can use the server, and any key sent is readable in transit. Keep such
servers on a trusted network or behind a tunnel or TLS proxy.

### Servers that reject dsh's defaults

Some OpenAI-compatible servers refuse the `developer` role or the
`max_completion_tokens` field. dsh reads per-route `compat` settings; add them
under the provider block by hand (rdsh does not guess them):

```yaml
      home-gpu:
        # ...generated keys...
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
```

`--replace` rewrites the whole block, so re-add a hand-written `compat:`
afterwards (the `sarashina` preset writes its own).

## Not covered

Starting or managing the servers, network discovery (mDNS), choosing
`agent-default-model`, HAI quota or pricing, and Command Code plan entitlements
(`/models` and the provider docs are authoritative).
