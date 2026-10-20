# Web UI プラグイン棚卸し (task-2)

- 対象プロファイル: `~/.dsh/profiles/web` (dsh 0.2.1-rc.2 / GUI <http://127.0.0.1:3080>)
- 作業ブランチ: `test/webui-lighter` (worktree `/var/tmp/wt-uiperf`)
- 調査は**読み取りのみ**。本番サービス `dsh-web.service` と `~/.dsh` の実設定は一切変更していない。
- 分類は「**無効化しても安全**」「**条件付きで安全**」「**必要**」の3種。**推測は必ず「推測」と明記**した。

## 0. 結論サマリ

| 分類 | プラグイン | 一言 |
| ---- | ---- | ---- |
| **無効化しても安全** | `@local/rea-mcp` | 起動時点で解決失敗。すでに実効ゼロ。 |
| **無効化しても安全** | `dsh-gitview` | バージョン非互換で起動スキップ済み。実効ゼロ。 |
| **無効化しても安全** | `@local/dsh-sound` | client.js 49,670 B の最大級。音/通知のみで機能欠損なし。 |
| **無効化しても安全** | `@local/opencode-live` | bundles 未登録。読み込まれていない。 |
| **無効化しても安全** | `@local/opencode-zen-usage` | bundles 未登録。読み込まれていない。 |
| **無効化しても安全** | `rdsh-update-banner` | bundles 未登録。読み込まれていない。 |
| **条件付きで安全** | `@local/google-mcp` | Gmail/GDrive/Discord/Tavily 等の認証済み MCP を含む。**一部は現役**。 |
| **条件付きで安全** | `@local/superlist-mcp` | **bundles 未登録 = 現在 DSH からは使えない**。ただし AGENTS.md が正と定める。 |
| **条件付きで安全** | `@local/dsh-copy-deliverable` | client.js 7,162 B。UI ボタンのみ。 |
| **条件付きで安全** | `rdsh-no-feedback` | feedback 機能を切るだけ。`features.feedback=false` と連動。 |
| **条件付きで安全** | `rdsh-mobile-ui` | client.js 5,497 B。767px 以下のみ作用。 |
| **必要** | `@deepseek-ai/dsh-base` | ランタイム基盤。外すと起動しない。 |
| **必要** | `@deepseek-ai/dsh-web-app` | Web UI 本体。外すと GUI が消える。 |
| **必要** | `@deepseek-ai/dsh-experimental-agent-team-profile` | Agent Teams。本タスク自体がこれで動いている。 |
| **必要** | `rdsh-settings` | client.js 33,656 B と最大だが、rdsh.json の唯一の編集 UI。 |

> **注意**: `dependencies` に載っていても `dsh.profile.bundles` に無いものは**読み込まれない**。
> `@local/superlist-mcp` / `@local/opencode-live` / `@local/opencode-zen-usage` / `rdsh-update-banner` の4件が該当する。

| ---- |

## 1. 起動失敗の実測 (一次証拠)

`/tmp/cc-39100.log` (2026-10-20 20:30 取得) の起動出力から:

```text
dsh: skipping profile bundle "@local/rea-mcp": Error: dsh: cannot resolve profile bundle "@local/rea-mcp" from the dsh installation or /home/sahen/.dsh/profiles/web; run 'dsh plugin --profile web install' if its dependency is not installed
dsh: skipping profile bundle "dsh-gitview": Error: Plugin dsh-gitview@0.1.0 is incompatible with dsh 0.2.1-rc.2: requirements {"engines.dsh":"0.2.0-rc.2"}. ... Exact-version exemption: not active.
/usr/bin/python3: can't open file '/home/sahen/適当/gemini-mcp/server.py': [Errno 2] No such file or directory
{"level":"fatal",...,"message":"Authentication required: Either SLACK_MCP_XOXP_TOKEN, SLACK_MCP_XOXB_TOKEN, ... must be provided","app":"slack-mcp-server",...}
Error: Command failed: .../slack-mcp-server-linux-amd64
Error: OAuth keys file not found. Please place gcp-oauth.keys.json in current directory or /home/sahen/.gmail-mcp
Error: OAuth keys file not found. Please place gcp-oauth.keys.json in current directory or /home/sahen/.gmail-mcp
[alpha-mcp] Server started (v0.1.7)
[tavily-mcp] no TAVILY_API_KEY set; running in keyless mode.
Discord MCP Server v2.2.0 running on stdio.
```

補足 (`~/.dsh/logs/startup-2026-10-18T05-24-56...log`):
`mcp-client(blender2)` / `mcp-client(unity2)` は `spawn ... ENOENT` で **attempt 1/10〜3/10 のリトライ**を繰り返している。
Windows 側パス (`/mnt/c/...`) が WSL から見えないためで、**起動時間を確実に伸ばす**。

| ---- |

## 2. プラグイン別の詳細

### 2.1 `@deepseek-ai/dsh-base` — 必要

- **提供**: DSH ランタイム基盤。`/home/sahen/.local/opt/dsh-original/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base` に実在を確認。
- **起動失敗**: なし。
- **無効化時の影響**: プロファイル全体が成立しない。
- **判断**: **必要**。軽量化の対象外。

### 2.2 `@deepseek-ai/dsh-web-app` — 必要

- **提供**: Web GUI 本体 (`127.0.0.1:3080`)。
- **client.js**: 同梱の `dsh-client-ui-conversation/lib/client.js` だけで 774,080 B、`dsh-client-ui-settings-models` が 211,258 B など。**転送量の大半はここ**。
- **無効化時の影響**: GUI が表示されない。
- **判断**: **必要**。ただし**転送量削減の本命はここ**であり、棚卸しの対象ではなく最適化の対象。

### 2.3 `@deepseek-ai/dsh-experimental-agent-team-profile` — 必要

- **提供**: Agent Teams (spawn_teammate / shared task board)。
- **根拠**: 本棚卸しタスク自体が `task-2` を claim して `list_agents` で lead / bench-writer / verify-runner / plugin-auditor を観測しており、**稼働中**。
- **判断**: **必要**。ただし「実験的」バンドルであり、**推測**として、Agent Teams を使わないセッションでは外せる可能性がある。

### 2.4 `@local/rea-mcp` — **無効化しても安全**

- **起動失敗**: **あり (確定)**。「cannot resolve profile bundle」で起動スキップ。
- **原因**: `node_modules/@local/rea-mcp` の symlink 解決先 `/home/sahen/Projects/external-migration/dsh-workspaces/適当/rea-mcp` は存在するが、**その中に有効な `package.json` が無い** (`.ctrl.js`, `.diag.js`, `guruguru-potato-auto.js` 等の作業ファイルのみ)。
- **client.js**: なし。
- **無効化時の影響**: **なし**。すでに読み込まれていないため、bundles から外しても挙動は変わらない。ログのノイズだけが消える。
- **判断**: **無効化しても安全** (むしろ外すべき)。

### 2.5 `dsh-gitview` — **無効化しても安全**

- **起動失敗**: **あり (確定)**。`dsh-gitview@0.1.0` が `engines.dsh: 0.2.0-rc.2` を要求するが実行環境は `0.2.1-rc.2`。exemption 未適用のためスキップ。
- **提供**: Git パネル (差分 / stash / blame / CI ステータス)。README は「Requires DSH **0.2.0-rc.2**」と明記。
- **client.js**: パッケージ直下に無し (`lib/` 配下にビルド済みを確認)。**読み込まれていないので転送量ゼロ**。
- **無効化時の影響**: なし。既に機能していない。
- **判断**: **無効化しても安全**。復活させたい場合は DSH 側のダウングレードかプラグインの更新が必要。

### 2.6 `@local/google-mcp` — **条件付きで安全**

- **実体**: 設定専用バンドル。`package.json` は 153 B のみで、実体は `cordis.patch.yml` (6,358 B)。
- **起動失敗**: **バンドル自体は成功**。ただし**配下の MCP が個別に失敗**している:
  - `gmail` / `gmail2` → `OAuth keys file not found` (ログに2回)
  - `slack` → `SLACK_MCP_XOXP_TOKEN ... must be provided` + プロセス即死 → Node が `Command failed` で例外
  - `blender2` / `unity2` → `spawn ... ENOENT` で 10 回リトライ
  - `gemini` → `/home/sahen/適当/gemini-mcp/server.py` が存在せず `can't open file`
  - `tavily` → キーなしの keyless モードで起動
  - `distil` / `discord` / `chrome` / `context7` / `alphaxiv` → **正常起動**
- **実際に使われている形跡 (セッション横断の出現数)**:
  `mcp__discord` 17 / `mcp__gmail` 4 / `mcp__blender2` 4 / `mcp__chrome` 3 / `mcp__unity2` 3 / `mcp__gmail2` 3 / `mcp__alphaxiv` 3 / `mcp__gdrive` 2 / `mcp__distil` 2 / `mcp__tavily` 2 / `mcp__context7` 2 / `mcp__slack` 2。
  `~/.dsh/MEMORY.md` には gmail / gmail2 / gdrive / discord / chrome / distil / alphaxiv / tavily が**認証済み・疎通済み**として記録されている。
- **無効化時の影響**: **Discord / Chrome / alphaxiv / distil / context7 / tavily が即座に使えなくなる**。`MEMORY.md` には「主利用サービス: gmail / discord / twitter(X)」とあり、`discord` の 17 セッションは突出している。
- **判断**: **条件付きで安全**。
  - **丸ごと無効化は不可** (discord/chrome が現役)。
  - **安全に削れる内訳**: `mcp-slack` (未認証・プロセス即死でログを汚す)、`mcp-winbridge` (**既に `disabled: true`**)、`mcp-opencode-free` (**既に `disabled: true`**)。
  - **推測**: `mcp-blender2` / `mcp-unity2` は 10 回リトライで起動を遅らせる。WSL から Windows パスが見えない間は外す価値が高い。ただし「4 セッション / 3 セッション」の出現があるため**過去に使用実績あり**。外すなら要判断。
  - **推測**: `mcp-gmail` / `mcp-gmail2` は現在 OAuth キー未検出で起動失敗しているが、鍵を置けば復活する。ログ削減目的なら一時的に外せる。

### 2.7 `@local/superlist-mcp` — **条件付きで安全**

**この項目は特に指示があったため、設定・ログ・AGENTS.md を個別に確認した。**

- **bundles 登録**: **されていない**。`dsh.profile.bundles` の11件に `@local/superlist-mcp` は**含まれない**。`dependencies` には `link:` で入っているのみ。
- **実体**: `package.json` 156 B + `bridge.mjs` (4,357 B) + `cordis.patch.yml` (583 B)。`bridge.mjs` は「DSH の MCP クライアントは OAuth 未対応のため token 更新を肩代わりする」stdio ブリッジ。
- **このマシンでの使用形跡**:
  - `~/.dsh/AGENTS.md` 24行目: 「タスク・TODO・期限は Superlist で一元管理する (`mcp__superlist__*`)。DSH 内の todo と二重管理せず Superlist を正とし、新しい用件は Superlist にも入れる」→ **共通指示で必須化されている**。
  - DSH セッション履歴に「つながりました。これで集約は完成です。DSH から Superlist に直接つながりました。サーバーは接続中です」「毎朝7時の同期も動きます」という応答が残っており、**DSH 側で実際に接続・使用された実績がある**。
  - 出現数: `mcp__superlist` が 3 セッション。
  - ただし直近の `~/.dsh/logs/startup-*.log` (2026-10-18) および `/tmp/cc-39100.log` (2026-10-20) には **`superlist` の行が一切出ていない**。
- **解釈 (事実と推測を分離)**:
  - **事実**: 現在の `bundles` に無いので、**今の DSH Web から `mcp__superlist__*` は登録されない**。
  - **事実**: 一方で AGENTS.md は Superlist を「正」と定めており、指示と実態が食い違っている。
  - **推測**: bundles から脱落したのは、後から `rdsh-update-banner` 等を足す際に編集ミスで落ちた可能性が高い (登録されていれば起動ログに `mcp-superlist` 行が出るはずで、それが無い)。
- **無効化時の影響**: **現時点では実効ゼロ** (元々読み込まれていない)。したがって「無効化しても安全」と「必要」のどちらとも言い切れない。
- **判断**: **条件付きで安全**。
  - 軽量化の観点では **外して良い** (既に非ロード)。
  - **ただし**、`dependencies` からも消してしまうと将来 `dsh plugin --profile web install` で復元できなくなる。**bundles に戻す方向の修正**が本来あるべき姿。棚卸しとしては「軽量化で触らない / AGENTS.md との不整合として別途報告」を推奨。

### 2.8 `rdsh-settings` — 必要

- **提供**: 設定モーダルに rdsh セクションを追加。`DSH_HOME/rdsh.json` のトークン予算・context engine・goal・作業ファイル・Discord Rich Presence を編集する**唯一の UI**。
- **client.js**: **33,656 B** (自作プラグイン中で最大)。`index.js` 17,816 B。
- **起動失敗**: なし。
- **無効化時の影響**: `rdsh.json` の項目を GUI から編集できなくなる。`rdsh settings set` CLI は残るため**完全に不能ではない**。
- **判断**: **必要**。ただし client.js が最大なので、**遅延ロード化**の候補としては最有力。
- **出現数**: 42 セッションと突出しており、実際に常用されている。

### 2.9 `@local/dsh-sound` — **無効化しても安全**

- **提供**: 効果音 (Web Audio 合成) とデスクトップ通知。音声ファイルは持たず、追加依存 0。
- **client.js**: **49,670 B** — **自作プラグイン中で最大**。`index.js` は 358 B のみ。
- **起動失敗**: なし。
- **無効化時の影響**: 応答完了音・承認待ち通知・質問通知が消えるだけ。**エージェント機能の欠損はゼロ**。
- **判断**: **無効化しても安全**。client.js が最大級なので**削減効果が最も高い**。
  - ただし「見ていない間に起きたこと」を知る用途なので、**常用しているなら体験が落ちる**。出現数は 7 セッション。
  - **推測**: 承認プロンプトが無効な本セッション環境では通知の実利が小さい。

### 2.10 `rdsh-mobile-ui` — **条件付きで安全**

- **提供**: 767px 以下のときだけ `<style>` を1つ追加する CSS パッチ。質問カード・composer の幅調整のみで、値の送信や変更はしない。
- **client.js**: **5,497 B** (最小級)。`index.js` 410 B。
- **起動失敗**: なし。
- **無効化時の影響**: スマホ幅でレイアウトが崩れる (680px 固定幅のまま)。デスクトップでは元々ルールがマッチしないため**無影響**。
- **判断**: **条件付きで安全**。スマホから使うなら必要。PC のみなら外して良い。コストは 5.5 KB なので削減効果は小さい。
  - README に「上流クラス名は CSS-module ハッシュで DSH リリース間で変わる」とあり、**DSH アップグレードで黙って効かなくなる**点は留意。

### 2.11 `rdsh-no-feedback` — **条件付きで安全**

- **提供**: feedback 機能を構成する3エントリ (`message-feedback` / `ui-message-feedback` / `command-feedback`) に `disabled: true` を付けるパッチ。**削除ではなく無効化**。
- **client.js**: **なし** (バンドル自体はサーバー側パッチのみ)。転送量ゼロ。
- **根拠**: `~/.dsh/rdsh.json` の `features.feedback` は **`false`**。README 通り「スイッチが OFF のときだけ同梱される」条件が成立している。バックアップ `rdsh.json.bak-before-nofeedback-20261020-191950` も存在。
- **無効化時の影響**: Like/Dislike ボタンと `/feedback` コマンドが復活する。`features.feedback=false` の設定と矛盾する。
- **判断**: **条件付きで安全**。client.js を持たないので**軽量化効果はほぼゼロ**。触る理由がない。
  - README の Caveats: 上流が id を改名すると `disabled: true` が何にもマッチせず **fail open** (feedback が復活する)。

### 2.12 `@local/dsh-copy-deliverable` — **条件付きで安全**

- **提供**: client.js 7,162 B + index.js 2,673 B。deliverable のコピー UI。
- **起動失敗**: なし。ログにエラーなし。
- **無効化時の影響**: 成果物のコピーボタンが消える。`present` ツール自体は DSH 標準 (`@deepseek-ai/dsh-tool-present`) なので**成果物表示は残る**。
- **判断**: **条件付きで安全**。7 KB なので削減効果は小さい。出現数 4 セッション。

### 2.13 `@local/opencode-live` — **無効化しても安全** (未ロード)

- **bundles 登録**: **なし** (`dependencies` のみ)。したがって**現在読み込まれていない**。
- **実体**: client.js 18,225 B / index.js 1,765 B。
- **判断**: **無効化しても安全**。すでに実効ゼロ。出現数 4 セッションは過去の利用痕跡。

### 2.14 `@local/opencode-zen-usage` — **無効化しても安全** (未ロード)

- **bundles 登録**: **なし**。読み込まれていない。
- **実体**: client.js 17,030 B / index.js 5,223 B。
- **補足**: `~/.dsh/MEMORY.md` に「Zen (2026-10-17 時点): **ユーザー判断で見送り** (キー未登録)」と明記されている。**使う予定が無い**ことが一次記録から確認できる。
- **判断**: **無効化しても安全**。削除候補として有力。

### 2.15 `rdsh-update-banner` — **無効化しても安全** (未ロード)

- **bundles 登録**: **なし**。ただし `~/.dsh/profiles/web/cordis.patch.yml` 196行目に `- id: rdsh-update-banner` として**直接パッチ登録されている** (config: `demo: false`, `syncScript: .../sync-dsh.sh`)。
- **実体**: client.js 18,041 B / index.js 22,040 B。
- **出現数**: 24 セッション。
- **判断**: **無効化しても安全**。更新通知バナーが消えるだけ。**推測**: 18 KB の client.js を常時積む割に、効果は「更新があるときだけバナーを出す」ため、遅延ロードの良い候補。

| ---- |

## 3. client.js サイズ一覧 (自作プラグインのみ)

| プラグイン | client.js | index.js | 常時必要か |
| ---- | ---: | ---: | ---- |
| `@local/dsh-sound` | 49,670 | 358 | いいえ (音のみ) |
| `rdsh-settings` | 33,656 | 17,816 | **はい** (設定 UI) |
| `rdsh-update-banner` | 18,041 | 22,040 | いいえ (未ロード) |
| `@local/opencode-live` | 18,225 | 1,765 | いいえ (未ロード) |
| `@local/opencode-zen-usage` | 17,030 | 5,223 | いいえ (未ロード) |
| `@local/dsh-copy-deliverable` | 7,162 | 2,673 | いいえ (ボタンのみ) |
| `rdsh-mobile-ui` | 5,497 | 410 | スマホ時のみ |
| `rdsh-no-feedback` | なし | 401 | — |
| `dsh-gitview` | なし (未ロード) | — | — |
| `@local/google-mcp` | なし (設定のみ) | — | — |
| `@local/superlist-mcp` | なし (bridge のみ) | — | — |
| **合計 (実ファイル存在分)** | **149,281 B** | — | |

参考: DSH 標準の `dsh-client-ui-conversation/lib/client.js` だけで **774,080 B**。**自作プラグインの client.js 合計は標準 UI 1本より小さい**。
→ **転送量削減の主戦場は DSH 標準バンドル側**であり、自作プラグインの無効化で得られる削減は限定的 (最大でも 49,670 B の dsh-sound)。

| ---- |

## 4. 推奨アクション (証拠に基づく優先順)

1. **確実に外せる (挙動が変わらない)**: `@local/rea-mcp`, `dsh-gitview` — bundles から外す。起動ログのノイズが消える。
2. **未ロードの掃除**: `@local/opencode-zen-usage` (見送り確定), `@local/opencode-live` — `dependencies` からも整理候補。
3. **起動を遅らせている要因を止める**: `mcp-slack` (即死), `mcp-blender2` / `mcp-unity2` (ENOENT × 10 リトライ)。`google-mcp` の `cordis.patch.yml` 内で個別に無効化するのが安全。
4. **削減効果が最大**: `@local/dsh-sound` (49,670 B)。常用していなければ外す。
5. **触らない**: `dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile`, `rdsh-settings`, `rdsh-no-feedback`。
6. **別途報告**: `@local/superlist-mcp` が bundles から脱落しており `~/.dsh/AGENTS.md` の「Superlist を正とする」指示と矛盾している。

| ---- |

## 5. 未検証・限界

- 本番サービスへの影響を避けるため、**別ポートでの起動検証は行わず**、既存ログとファイル実体の読み取りで判定した。
- `dsh plugin --profile web list` は `pnpm was not found` で失敗した (`/tmp/dsh-probe-ls` の分離 DSH_HOME で実行)。プラグイン一覧は `package.json` + `cordis.patch.yml` + 起動ログから再構成した。
- 「ブラウザ側で常時必要か」は README の記述とスロット登録の有無に基づく。**実ブラウザでの `network` 計測は bench-writer (task-1) の担当範囲**。
- セッション出現数は `~/.dsh/storages/session_projcache/sessions/` を文字列検索した件数であり、**呼び出し回数ではない**。
