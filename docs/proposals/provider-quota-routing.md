# プロバイダ利用枠ルーティングのスコープ提案（#87）

Status: 未起票（子Issueを起票したらこの節にリンクを貼る）。対象マイルストーンは `v0.4.0`。

親Issue [#87](https://github.com/jimoto-no-llm/rustdsh/issues/87) はエピックとして残し、
実装は子Issueに分割する。この文書は「1プロバイダ目に着手できる粒度」まで決めるための下書きで、
実装そのものではない。

## Goal

複数のサブスクリプション型プロバイダを使い分けるとき、公式に公開された料金と消費枠の情報から
「消費枠への影響が小さい候補」を提示できるようにする。rdsh 側の読み取り専用の助言に限定し、
DSH 本体のモデル選択・フォールバック・リクエスト中継は変更しない。

ROADMAP の「one provider at a time」は、メンテナの分割案（1社ずつ追加）と整合する形で
「プロバイダを1社ずつ対応する」と解釈する。この解釈自体は 87-1 で確認する。

## Non-goals

- DSH 本体のモデル選択・ターンピニング・フォールバックの実装や変更。
- プロファイルの `agent-default-model` の自動書き換え。
- リクエスト中継とヘッダー注入（直列化プロキシは `scripts/serial-proxy.mjs` の担当）。
- 12プロバイダの一括対応。1社ずつ追加する。
- ZDR（Zero Data Retention）要件。[#484](https://github.com/jimoto-no-llm/rustdsh/issues/484) で定義中。
- 予算の強制執行（[#45](https://github.com/jimoto-no-llm/rustdsh/issues/45)）と
  利用枠・再試行時刻の表示（[#59](https://github.com/jimoto-no-llm/rustdsh/issues/59)）。
- 実際の請求額の保証。提示する値は公式情報に基づく推定で、請求書の検証ではない。

## Scope

### 配置（rdsh 側のどこに置くか）

- 新設する読み取り専用コマンド `rdsh route plan`（仮称。名称は 87-1 で確定）を、
  新モジュール `src/route_plan.rs` に置き、`src/main.rs` の `NATIVE_FIRST` と clap 定義に追加する。
- 入力: `--profile`、トークン量（入力・出力・キャッシュ読み書き）、`--json`。
- 読み取り: プロファイルの `cordis.patch.yml`（既存のルート読取）、
  既定ルートと資格情報の有無（既存の `provider_needs()`）、同梱する公式料金表。
- 出力: 候補ごとの状態（`eligible` / `unknown` / `excluded`）、根拠URL、確認日、
  消費枠への影響の内訳、推奨または `recommendation: null` と理由。
- 書かない・変えない: プロファイル、DSH の選択、予算ポリシー、外部ネットワーク（MVP では取得しない）。
  自動切替・自動フォールバックもしない。
- 適用は利用者または運用者が DSH の既存の操作（モデルピッカー、プロファイル編集）で行う。
  DSH の選択は DSH が所有する（[docs/MODEL-ROUTING.md](../MODEL-ROUTING.md)）。
- 既存の `dashboard/model-routing.mjs`（run 単位の表明と承認）と `dashboard/model-selection.mjs`
  （DSH 選択の読み取り）は変更しない。ルーティング提案は実行前の助言であり、実行時の制御ではない。

却下した候補:

| 置き場所 | 判断 |
| --- | --- |
| 起動時のプロファイル選択の助言だけ | 比較ロジックと根拠を残せないため、CLI の出力として実装する |
| `agent-default-model` の書換 | DSH の選択をクライアントが書き換えるため対象外 |
| リクエスト中継 | `serial-proxy` の領域で、本件の検証可能な範囲を超える |

### データ源の方針（公式情報に限定）

- 公式とは、プロバイダ自身のドキュメント・料金ページ、またはプロバイダが公式に文書化した API を指す。
- 料金表の各エントリに `source_url` と `checked_at` を必須にする。
- サードパーティの集計サイトやコミュニティ製ツールは根拠にしない。
  公式 URL の「発見」にだけ使い、採用する値は必ず公式ページで確認する。
- 公式が出す区分（時間帯別、トークン長別、5時間・週・月の窓）をそのまま表現し、補間しない。
- 通貨換算はしない。公式の換算値がある場合だけ、その根拠付きで金額を出す
  （[docs/COST-LEDGER.md](../COST-LEDGER.md) と同じ立場）。

### 取得できない場合の扱い（unknown と fail-closed）

- `unknown` は 0 でも最安でもない。推奨候補として扱わない。
- 比較対象の全候補が公式データを持つ場合だけ推奨を出す。
  1つでも欠けたら `recommendation: null`、`coverage: incomplete` とし、終了コード 1 を返す（fail-closed）。
  取得できた候補と欠けた候補の一覧は常に表示する。
- 資格情報の状態が `missing` のルートは除外する。`importable` はまだ反映されていないため、
  除外理由を付けて非候補にする。既存の `provider_needs()` の 3 状態をそのまま使う。
- 実行時の残量が公式 API で取れない場合は「不明」と表示し、窓の残量や再試行時刻を推測しない。

### 1プロバイダ目: OpenCode Go

候補比較（2026-10-14 確認）。「同梱」はローカルの DSH 0.2.0-rc.2 チェックアウト（pi-ai 0.87.1）で確認した事実、
「未確認」は公式情報を確認できていないことを示す。

| 候補 | 公式の料金・枠ソース | dsh へのルート同梱 | rdsh 側の再利用 | 残量の公式観測 | 実装難度 |
| --- | --- | --- | --- | --- | --- |
| OpenCode Go | モデル別トークン単価・モデル別月次上限・5時間/週/月の割合を公式ページに記載 | あり（pi-ai 0.87.1 に `opencode-go` カタログ） | `provider_needs()`、`--from-opencode`、opencode ログイン取込 | ワークスペース月次の spent/limit は公式 Budgets API。モデル別の窓は未確認 | 中 |
| Command Code | 公式 Provider API ページと料金ページにプラン別 credits とモデル別 allowance | なし（`commandcode` カタログは無い） | 新規プリセットが必要（[#450](https://github.com/jimoto-no-llm/rustdsh/issues/450) が open） | 公式の利用 API は未確認（非公式の alpha エンドポイントの報告あり） | 高 |
| Ollama Cloud | 公式料金ページにプラン別 credits を記載 | なし（自前サーバーは `local-openai` プリセット） | なし | 未確認 | 中〜高 |
| GitHub Copilot | 公式 plans ページに AI credits を記載 | あり（pi-ai に `github-copilot`） | 認証が別系統（GitHub トークン） | 個人向け残量 API は未確認 | 高 |
| ChatGPT Plus / Pro | 公式の利用枠 API は未確認 | あり（pi-ai に `openai-codex`） | Codex CLI のログイン取込 | 未確認 | 高 |

1プロバイダ目は OpenCode Go とする。理由は3点。

1. 既存コードの再利用が最も大きい。dsh の pi-ai 0.87.1 に `opencode-go` のカタログが同梱されており、
   ルート登録の新規実装が不要で、rdsh は `provider_needs()` と opencode 取込をそのまま使える。
   Command Code は #450 のルート登録が前提で、まだ open のため着手順が後になる。
2. 公式情報が構造化されている。モデル別のトークン単価、モデル別の月次上限、5時間 20%・週 50%・
   月 100% という窓の割合が公式ページにあり、確認日付きの表を作れる。
3. 観測可能性の切り分けができる。公式 Budgets API でワークスペース月次の spend と limit は取れる一方、
   モデル別の窓は公式 API が未確認のため unknown になる。fail-closed の規則を実データで検証できる。

注意点（事実）: 公式 Go ページの "Known problematic clients" に DeepSeek Harness が挙がっており、
セッションヘッダー `x-opencode-session` が一部の経路で送られないと記載されている。
効果測定ではセッション帰属を前提にせず、この制約を別Issueで扱う。

### 計算式（提案）

```text
effective_cost(model, usage) = Σ_k (usage.tokens_k / 1_000_000 × official_unit_price_k)
                              + official_multiplier がある場合はその係数を適用
plan_pressure(model, usage)  = effective_cost / official_monthly_limit(model)
```

計算例（この提案による解釈。数値は公式 Go ページ、2026-10-14 確認。入力 1M + 出力 1M トークン）:

- GPT 6 Luna: (0.10 + 0.50) USD ÷ 月次上限 15 USD = 4.0%。
- GLM-5.3-Flash: (0.15 + 0.50) USD ÷ 月次上限 60 USD = 約 1.1%。
  トークン単価は GPT 6 Luna が安いが、枠に対する消費は GLM-5.3-Flash が小さい。
  単価だけの比較では枠当たりの最安にならない例。
- DeepSeek V4.1 Flash は同一モデルで Off-Peak と Peak の単価が 2 倍違う（月次上限は同じ）。
  時間帯が実効レートの一部になる例。

### 既存実装との関係

- `src/auth.rs` の `provider_needs()`（3状態 `ok` / `importable` / `missing`）を
  候補の適格判定に再利用する。現在はモジュール内の非公開関数のため、87-2 で `pub(crate)` にする。
- `src/providers.rs` のルート読取も再利用する。同じく非公開のため可視性の変更が要る。
  `PRESETS` は API キー型ルート（hai / local-openai / sarashina）用で、OpenCode Go は対象外
  （pi-ai 同梱カタログ側にある）。
- 台帳（[docs/COST-LEDGER.md](../COST-LEDGER.md)）は報告された費用の記録で、価格の探索はしない。
  提案値は台帳へ自動報告しない。
- 予算執行（[docs/BUDGET-CONTROL.md](../BUDGET-CONTROL.md)）は明示的に
  「No automatic model/provider downgrade occurs」としており、提案はこれに従い自動切替をしない。

## Acceptance criteria

この提案の最初のマイルストーン（87-2 の MVP）が満たす条件。

- [ ] `rdsh route plan --profile <name> --json` が、公式料金表に基づく候補と根拠を出力する。
- [ ] 各候補に `source_url` と `checked_at` がある。
- [ ] 公式データが欠けた候補は `unknown` として表示され、最安として扱われない。
- [ ] 対象候補の1つでも公式データが欠けた場合、`recommendation: null` で終了コード 1 になる。
- [ ] `missing` / `importable` のルートは理由付きで除外される。
- [ ] プロファイル、資格情報、DSH の設定を1バイトも変更しない（テストで確認する）。
- [ ] ネットワークなしで実行できる（MVP に取得処理を入れない）。

## 子Issue分割（下書き）

親 #87 はエピックとして残す。87-5 はすでに #484 として分離済み。以下は起票用の下書き。

### [87-1] ルーティング提案の配置・データ源・計算式を確定する

- 内容: この文書の決定事項を承認する。コマンド名、置き場所、料金表のスキーマ、
  公式ソース方針、計算式、fail-closed の規則を確定する。
- 受入条件:
  - [ ] コマンド名と置き場所が1つに決まる。
  - [ ] 料金表のスキーマ（必須項目: モデル、単価、月次上限、`source_url`、`checked_at`）が決まる。
  - [ ] 公式サイトの計算例が2件、URL と確認日付きで書かれる。
  - [ ] unknown と fail-closed の規則が承認される。
- 依存: なし（コード変更なし）。

### [87-2] MVP: OpenCode Go の公式料金表と読み取り専用の提案コマンド

- 内容: OpenCode Go のみを対象に、公式ページから作った料金表と `rdsh route plan` を実装する。
  同一プロバイダ内のモデル比較までとし、プロバイダ横断比較は2社目以降に回す。
- 受入条件:
  - [ ] 料金表に OpenCode Go のモデル別単価・月次上限・`source_url`・`checked_at` がある。
  - [ ] 候補の適格判定に `provider_needs()` を使い、`missing` / `importable` を除外できる。
  - [ ] 純関数の選択テスト（最安選択、除外、同額時の安定した tie-break）がある。
  - [ ] fixture の CLI テストがネットワークなしで通る。
  - [ ] 実行前後でプロファイルと資格情報が変化しないことをテストで確認する。
- 依存: 87-1。

### [87-3] 公式ソースの更新・キャッシュ・陳腐化の表示

- 内容: 料金表を公式ソースから更新する処理を追加する。TTL 内はネットワークに出ない。
  取得失敗時は直近の値を `stale` として表示し、推測値で補わない。
- 受入条件:
  - [ ] TTL 内の再実行がネットワークへ出ないことをテストで確認する。
  - [ ] 取得失敗時に前回値と `checked_at` が表示され、`stale` が明示される。
  - [ ] 公式ページの形式変更で値が取れない場合、その項目が `unknown` になり、
    推奨が出なくなる（fail-closed）。
  - [ ] ソースの利用規約・取得方法を確認したメモがある。
- 依存: 87-2。

### [87-4] プロバイダ追加テンプレートと Command Code の追加

- 内容: 1社追加するごとのテンプレートを決め、2社目として Command Code を追加する。
  2社目が入った時点でプロバイダ横断の比較を有効にする。
- テンプレート項目（案）: 公式の料金・枠ソースURL / 換算の根拠 / 除外条件（プラン制限など） /
  `source_url` と `checked_at` / fixture。
- 受入条件:
  - [ ] テンプレートが文書化されている。
  - [ ] Command Code が候補になる。ただし Provider API が使えないプランは除外理由付きで非候補。
  - [ ] ネットワークなしの fixture で追加プロバイダの選択が検証できる。
  - [ ] プロバイダ横断比較が fail-closed の規則どおりに動く。
- 依存: 87-2、[#450](https://github.com/jimoto-no-llm/rustdsh/issues/450)。

### [87-5] ZDR モード

- すでに [#484](https://github.com/jimoto-no-llm/rustdsh/issues/484) として分離済み。重複起票しない。

## 検証方法（fixture、ネットワークなし）

- `tests/route_plan_cli.rs` を `tests/provider_cli.rs` の `Fixture` と同じ方式で作る。
  隔離した `HOME` / `DSH_HOME` / `XDG_*`、fixture の `cordis.patch.yml`、
  実バイナリ `env!("CARGO_BIN_EXE_rdsh")`。ネットワークは使わない。
- fixture で差し替えられる料金表（`--table <path>`）を用意し、公式ページに依存せずに検証する。
- ケース: 最安選択、同額時の tie-break、`unknown` の除外、資格情報 3 状態の扱い、
  coverage 欠落時の `recommendation: null` と終了コード 1、実行前後のファイル不変。
- 料金表そのもののテスト: 全エントリに `source_url` と `checked_at` がある。重複したモデルが無い。
- 実行例:

```sh
TMPDIR=/var/tmp rtk cargo test --test route_plan_cli
TMPDIR=/var/tmp rtk cargo test route_plan
```

- 未検証として残るもの: 実際のプロバイダの課金・残量、公式ページの取得（87-3）、
  DSH のセッション帰属（`x-opencode-session` の制約）。

## 根拠（事実と未確認）

事実（この文書の作成時に確認したもの）:

- pi-ai 0.87.1 に `opencode-go` などのカタログが同梱されている（ローカルの DSH 0.2.0-rc.2 で確認）。
- OpenCode Go の公式ページに、プラン価格、モデル別トークン単価、モデル別月次上限、
  5時間 20%・週 50%・月 100% の窓、`x-opencode-session` の要件、
  "Known problematic clients" の記載がある。
- OpenCode Console の Budgets API に `GET /api/v1/budgets/members`（`spent_micro_cents`、
  `limit_micro_cents`、`resets_at`）が公式に文書化されている。
- Command Code の公式 Provider API ページと料金ページに、プラン別 credits とモデル別 allowance がある。
- Ollama の公式料金ページに、プラン別 credits がある。
- GitHub Copilot の公式 plans ページに、AI credits の記載がある。
- `src/auth.rs` の `provider_needs()` は `ok` / `importable` / `missing` の 3 状態を返す。
- `tests/provider_cli.rs` は隔離 HOME と実バイナリで CLI を検証している。

未確認（断定しない）:

- 各プロバイダのモデル別残量を取得する公式 API の有無。
- OpenCode Go のモデル別窓の残量（公式には未確認。関連する要望は
  [anomalyco/opencode#18648](https://github.com/anomalyco/opencode/issues/18648)、closed）。
- Ollama Cloud、ChatGPT Plus / Pro、GitHub Copilot の残量 API。
- `x-opencode-session` を DSH が送れる範囲。

出典:

- [OpenCode Go](https://opencode.ai/v2/docs/console/go/)
- [OpenCode Console Budgets API](https://opencode.ai/v2/docs/console/api/budgets/)
- [Command Code Provider API](https://commandcode.ai/docs/provider)
- [Command Code 料金](https://commandcode.ai/pricing)
- [Ollama 料金](https://ollama.com/cloud)
- [GitHub Copilot plans](https://docs.github.com/en/copilot/get-started/plans)
