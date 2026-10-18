# Web Search API CLI evidence (2026-10-18)

Base: `97cc5c3a240bd4af9a04d71258601cb2d6cf6619` (`origin/main` when work started).
Candidate: `codex/ollama-web-search`.
Both outputs were captured from compiled Linux binaries in WSL FlashNext with isolated HOME/DSH_HOME
and no API keys. No hosted search API or model was called.

## Help output before / after

Command: `rdsh --language ja search-web --help` (exit 0 for both).

```diff
--- before/main-97cc5c3a
+++ after/ollama-web-search
@@ -1,18 +1,26 @@
-SearXNG によるWeb検索
+SearXNG（既定）または Ollama API によるWeb検索
 使い方: rdsh search-web [OPTIONS] <QUERY>
 
 引数:
   <QUERY>  検索クエリ
 
 オプション:
+      --provider <PROVIDER>      プロバイダーID [default: searxng] [possible values: searxng, ollama]
+      --share-file <SHARE_FILE>  隔離されたモデルツールとプロジェクトファイルを共有（繰り返し可）
       --limit <LIMIT>            結果上限
-      --share-file <SHARE_FILE>  隔離されたモデルツールとプロジェクトファイルを共有（繰り返し可）
-      --json                     機械可読JSONを出力
       --passthrough              slim委譲を無効化
       --dry-run                  実行せずに内容を表示
+      --json                     機械可読JSONを出力
       --slim                     slim委譲を強制
       --no-slim                  slim委譲を無効化
       --patch <PATCH>            設定オーバーレイを適用（繰り返し可）
       --profile <PROFILE>        使用するプロファイル
       --language <LANGUAGE>      rdsh自身の表示言語: en、zh-CN、ja
   -h, --help                     ヘルプを表示
+
+有効化: rdsh features on search-web
+Ollama: OLLAMA_API_KEY を設定し --provider ollama を指定（最大10件）。
+Web Search API サービスの案内: Tavily https://www.tavily.com/
+Tavily 入門: https://docs.tavily.com/documentation/quickstart
+組み込み検索先: searxng、ollama。Tavily はサービスの紹介です。
+利用手順: https://github.com/jimoto-no-llm/rustdsh/blob/main/docs/WEB-SEARCH.md
```

## Explicit Ollama selection without a key

Command: `rdsh --language ja search-web dummy --provider ollama --json`.
The candidate fixture enables `features.search-web`; the base rejects the new flag during argument parsing.

Before (exit 2, stderr):

```text
[rdsh] コマンド引数が無効です: 引数またはコマンドを認識できません
[rdsh] Clap 診断:
error: unexpected argument '--provider' found

  tip: a similar argument exists: '--profile'

Usage: rdsh search-web --profile <PROFILE> <QUERY>

For more information, try '--help'.
```

After (exit 1, stderr; stdout empty):

```text
[rdsh] エラー: Ollama Web Search: --provider ollama を使う前に有効な OLLAMA_API_KEY を設定してください
```

## Result and compatibility verification

- `websearch::ollama::tests` uses loopback HTTP fixtures to verify POST JSON, Bearer authentication,
  result mapping/order, 1–10 limits, empty results, HTTP failures, redirects, invalid responses,
  response-size bounds and a stalled-response timeout.
- `tests/web_search_providers.rs` checks the actual CLI: feature gating, localized missing/malformed-key
  errors, provider parsing and Tavily guidance in English, Chinese and Japanese.
- Its SearXNG fixture asserts identical JSON from the default command and `--provider searxng`,
  including when `OLLAMA_API_KEY` is present, and checks that the key is absent from the HTTP request.
- This evidence does not validate a real Ollama account, service availability or search relevance.
  Tavily is linked as an API service guide; it is not an implemented provider in this change.

## Local validation

- `sh scripts/check.sh quick`: fmt, clippy with zero warnings and 911 Rust tests passed.
- `cargo test --release`: 911 passed; benchmark example suites: 3 and 12 passed.
- `tests/regress.sh` with the release binary: all 107 checks passed.
- `node --test tests/model_benchmark/fence.test.mjs`: 2 passed.
- Markdown lint and `git diff --check`: passed.

The first installer-registry regression failed on both the base and candidate because the Windows
checkout applied CRLF to `release-digests*.tsv` (`i/lf w/crlf`); the parser received a 65-byte hash.
The candidate checkout's two TSV files were converted to the LF representation from Git before the
successful regression run. Their tracked contents are unchanged and are not part of this change.
