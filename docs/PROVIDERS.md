# Provider routes: HAI, Sarashina and home LLM servers

`rdsh provider` registers an OpenAI-compatible endpoint as a DeepSeek Harness
(dsh) route, so the model appears in dsh's model picker without editing YAML by
hand. dsh bundles a catalog of known providers; anything outside it (HAI, a
llama.cpp or vLLM server on your LAN) has to be declared under `llm-pi-ai` in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` with an `api`, a `baseURL`, an
`apiKeyEnv` and a non-empty `models:` list. This command writes that block.

```sh
rdsh provider list [--json]
rdsh provider add hai [options]
rdsh provider add sarashina [options]
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
  inline), nothing is written and the YAML to add by hand is printed.
- `--dry-run` shows what would change and writes nothing, including no key.
- `--profile <name>` picks the profile; without it the usual default applies
  (`RDSH_DEFAULT_PROFILE`, `general.default_profile`, else a local `tui`).
  The profile directory must already exist.

Common options:

| Option | Meaning |
|---|---|
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
  `credential missing` together with the key name. `rdsh setup --yes` saves
  `HAI_API_KEY` / `SARASHINA_API_KEY` / `LOCAL_OPENAI_API_KEY` from the environment, like the other
  known keys, and the setup UI's key endpoint accepts both names.

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
https://chat.sarashina.ai/dashboard/api-keys.

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

Sources: https://docs.sarashina.ai/api-reference/chat-completions and
https://docs.sarashina.ai/rate-limits

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
|---|---|
| llama.cpp `llama-server` | `http://host:8080/v1` |
| vLLM | `http://host:8000/v1` |
| LM Studio | `http://host:1234/v1` |
| Ollama | `http://host:11434/v1` |

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
`agent-default-model`, and HAI quota or pricing.
