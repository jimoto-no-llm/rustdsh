# ZDR モード（保持しないルートだけを使う）の要件

Status: 要件定義。実装は圧縮の分だけ（ZDR モードで、圧縮の送り先が確認できない時に起動を断る。[COMPACTION-POLICY.md](COMPACTION-POLICY.md) の受入範囲を参照）。ほかは実装なし。親 [#87](https://github.com/jimoto-no-llm/rustdsh/issues/87)（closed）、
子 [#484](https://github.com/jimoto-no-llm/rustdsh/issues/484)。関連する提案は
[provider-quota-routing.md](proposals/provider-quota-routing.md)（PR [#513](https://github.com/jimoto-no-llm/rustdsh/pull/513)、merged）。

この文書は「ZDR（Zero Data Retention）が必要な作業で、保持するルートへ要求を出さない」ために、
rdsh が何を保証し、何を保証しないかを決める。実装は合意後に親 #87 の分割に沿って行う。

## 目的

ZDR を要求する利用者が、保持しないルートだけを使う設定を rdsh で表明でき、
ZDR を満たさないルートが選ばれたことを起動時・実行前・`rdsh doctor` で確認できるようにする。
rdsh は dsh のルーターではなくランチャーなので、保証の範囲は「rdsh が設定したルートと、
そこへ付けた要求」までとする。

## 用語

| 用語 | 定義 |
| --- | --- |
| ZDR | プロバイダが入力（プロンプト、添付、ツール結果）と出力を保存・学習・第三者提供に使わないこと |
| 保持しないルート | ZDR を満たすと rdsh が根拠付きで判定した `provider` + `model` の組 |
| route | dsh プロファイルの `cordis.patch.yml` が持つ `providers.<name>` のエントリ |
| profile | rdsh が `--profile` で起動する dsh 設定の単位 |
| fail-closed | 対応を確認できないルートを「対応」とみなさず、候補から外すこと |
| declared | 利用者の宣言だけで ZDR と主張されるルート。根拠が弱く `available` と同義にしない |

## 何を「保持しない」と定義するか

rdsh が ZDR とみなす条件は、次のすべてを満たすこととする。

1. プロバイダが入力と出力を、モデルの学習に使わない。
2. プロバイダが入力と出力を、要求の処理以外の目的で保存しない。例外は、法令に基づく保存と、
   利用者が明示的に選んだログ保存だけとし、その場合は ZDR と表示しない。
3. 事業者またはリージョンをまたぐ転送でも、1 と 2 が維持される。
4. サブプロセッサ（下流プロバイダを含む）にも 1 と 2 が及ぶ。

ここでの「保存」はプロバイダ側を指す。ローカルのセッションログ、rdsh のコスト台帳、
dashboard の履歴は rdsh が管理する別の保持であり、ZDR モードでも消さない（消すのは別の要件）。

## 対象範囲

ZDR モードが対象にする要求は、**同一プロファイルで起動した dsh の全 LLM リクエスト**とする。

- メインエージェントのターン、タイトル生成、サブエージェントの委任、コンパクションの要約を含む。
  これらはプロファイルのルートを共有するため、ルート単位で ZDR を判定する。
- 実行時のルートは 1 つとは限らない。プロファイルに複数ルートがあり役割ごとに使い分ける場合は、
  **使われうる全ルート**が ZDR を満たすことを起動時に確認する。
- dashboard の外部エージェント（[#472](https://github.com/jimoto-no-llm/rustdsh/issues/472)・
  [#473](https://github.com/jimoto-no-llm/rustdsh/issues/473)）は対象外とする。
  別プロファイル・別プロセスで動くため、rdsh の ZDR モードはそのプロファイルに及ばない。
  同じプロファイルを共有する場合だけ、そのプロファイルの判定に従う。

## 判定の根拠

ルートを ZDR とみなす根拠は、rdsh に同梱する**手で管理する表**を正とする。
表の各エントリは `provider`、要求方法、`source_url`、`checked_at`、判定
（`available` / `unavailable` / `unknown`）を持つ。

| プロバイダ | 要求方法 | 満たせないときの挙動 | 判定 | 出典 |
| --- | --- | --- | --- | --- |
| Command Code | ヘッダー `x-cmd-zdr: 1`（CLI は `CMD_ZDR=1`） | `422 cmd_zdr_no_providers`。保持するプロバイダへフォールバックしない | `available`（ヘッダー型） | [Command Code ZDR](https://commandcode.ai/docs/resources/zdr) |
| OpenRouter | 本文 `provider.zdr: true`、またはアカウントの Privacy 設定 | ZDR のエンドポイントだけにルーティングされる | `available`（本文型） | [OpenRouter ZDR](https://openrouter.ai/docs/features/zdr) |
| Sarashina | 無償ベータでは不可（入出力がモデル改善に使われうる。除外は有料プランのみ） | — | `unavailable` | [SB Intuitions 2026-10-13](https://www.sbintuitions.co.jp/news/press/20261013_01/) |
| HAI | 公開情報を確認できていない | — | `unknown` | — |
| local-openai | 要求不要（外部プロバイダに送らない自己ホスト） | — | `available`（自己ホスト） | — |

補足:

- 利用者の宣言（`declared_routes`）は根拠として弱い。`declared` と表示し、`available` と同じ扱いにしない。
- `unknown` は非対応として扱う（fail-closed）。表にないプロバイダも `unknown` とする。
- プロバイダの API（OpenRouter の `GET /api/v1/endpoints/zdr`）で確認できる場合は、将来
  `checked_at` の更新に使う。MVP は同梱表とし、ネットワーク取得は行わない。
- 表は rdsh のリリースに同梱する。利用者の環境で自動更新しない（更新は別Issue）。

## 強制の方法

ルートの種類で取れる手段が違うため、次の 3 段階に分ける。

| 種類 | 手段 | 実装 |
| --- | --- | --- |
| ヘッダー型（Command Code） | 起動時に渡す設定オーバーレイ（`--patch`）で `headers` に `x-cmd-zdr: 1` を追加 | rdsh で実装可能。プロファイル本体は書き換えない |
| 本文型（OpenRouter） | 本文 `provider.zdr` | dsh が `openRouterRouting` を compat で withhold するため rdsh からは注入できない。アカウント設定に委ね、表示で「本文型は未注入」と示す |
| 自己ホスト（local-openai） | 要求不要 | 外部に送らないことを表示する |

- オーバーレイの適用は起動時の一時的なもので、プロファイルの `cordis.patch.yml` を書き換えない。
  オーバーレイがプロファイルの `headers` より優先されるかは実装Issueで確認する（未確認）。
- 本文型の注入先は、上流 dsh が compat で許可するか、[#457](https://github.com/jimoto-no-llm/rustdsh/issues/457)
  （closed）の同時接続中継の再利用が候補になる。この要件では実装せず、検出と表示だけを先に行う。

ZDR を満たせないルートの扱いは次のとおり。

- ZDR モードでは、選択時に非対応ルートを除外し、除外理由を表示する。
- 除外は起動を止めない。ただし**メインルート（プロファイルの `agent-default-model` が使うルート）が
  非対応なら起動を拒否**し、理由と代替ルート（ある場合）を示す。モードを明示した以上、
  黙って保持ルートへ送らない。
- ZDR モード以外の既定動作は変えない。

## 切り替え方法

切り替えは 3 つ用意する。優先順位は既存の言語解決と同じく、明示的な CLI が最優先とする。

| 方法 | 用途 | 優先 |
| --- | --- | --- |
| `rdsh --zdr` / `rdsh --no-zdr` | その起動だけ切り替える | 1 |
| 環境変数 `RDSH_ZDR=1` / `RDSH_ZDR=0` | CI と自動化向け | 2 |
| `features.zdr`（既存の機能スイッチ） | 利用者の既定にする。既定 `false` | 3 |

- `rdsh features on zdr` / `rdsh features off zdr` で `rdsh.json` を更新する。
- プロファイル単位の ZDR 宣言は MVP では扱わない（プロファイルの YAML を ZDR の真偽で書き換えない）。
- ZDR モード中であることは次の 3 か所に表示する。

| 表示先 | 内容 |
| --- | --- |
| 起動時のバナー | `ZDR mode: on` と、対象ルート数・除外ルート数 |
| `rdsh doctor` | ルートごとの判定（`available` / `unavailable` / `unknown` / `declared`）、種別（ヘッダー型・本文型・自己ホスト）、根拠 URL、確認日 |
| `rdsh auth` | 既存の資格情報状態（`ok` / `importable` / `missing`）に ZDR 判定を併記 |

## rdsh.json のスキーマ案

置き場所は `$DSH_HOME/rdsh.json` の新セクションとし、既存の `features.<id>` スイッチに合わせる
（`src/rdsh_config.rs`、schema v1）。プロファイルの `cordis.patch.yml` は読むだけで、ZDR のために書かない。

```json
{
  "schema": 1,
  "features": { "zdr": false },
  "zdr": {
    "table": "builtin",
    "declared_routes": { "opencode-go": "declared" }
  }
}
```

- `features.zdr` は既定 `false`。無効時は ZDR の判定・表示・オーバーレイ生成を行わない
  （既存実行に影響させない）。
- `zdr.table` は `builtin`（同梱の手管理表）または検証用の fixture パス。fixture でも
  `source_url` と `checked_at` を必須にする。
- `zdr.declared_routes` はプロバイダIDから `declared` への明示入力。省略時は空とする。
  `declared` は `available` と別の表示にし、推奨や起動可否の根拠にしない。
- 資格情報の値、プロファイル、DSH の設定は書かない。ZDR モードでも変更しない。

## 失敗時の扱い

- プロバイダが ZDR を満たせないと答えた場合（例: `422 cmd_zdr_no_providers`）は、そのエラーを表示して終了する。
  **保持するルートへフォールバックしない。**
- 要求を付けたかどうかを確認できない起動（古い rdsh 経由、rdsh を通さない起動）は、
  ZDR モードの対象外として表示する。対象外を「満たした」と表示しない。
- 部分的にしか ZDR を満たせないプロファイルでは、除外したルートと理由を必ず表示する。

## 検証可能性とテスト方法

「要求を付けた」と「実際に保持されなかった」は別である。rdsh が確認できるのは前者までとする。

| 区分 | 内容 |
| --- | --- |
| rdsh が確認できること | オーバーレイの生成、リクエストに付いたヘッダー、除外したルートと理由、起動拒否 |
| rdsh が確認できないこと | プロバイダ内部の保存、学習への利用、下流事業者での扱い |

テスト方法（実装時。既存の `tests/provider_cli.rs` と `tests/auth_sharing.rs` の方式に合わせる）:

1. 隔離した `HOME` / `DSH_HOME` / `XDG_*`、fixture の `cordis.patch.yml`、実バイナリ
   `env!("CARGO_BIN_EXE_rdsh")`、ローカル HTTP サーバーを使い、ネットワークへ出ない。
2. 生成したオーバーレイにヘッダー型ルートの `x-cmd-zdr: 1` が入ることを確認する。
3. 表の全エントリに `source_url`・`checked_at`・種別があることをテストする。
4. `unknown` と `unavailable` のルートが選択対象から外れることをテストする。
5. メインルートが非対応のときに起動を拒否することをテストする。
6. `--zdr` / `RDSH_ZDR` / `features.zdr` の優先順位をテストする。
7. 実行前後で `cordis.patch.yml`、`.credentials.yaml`、`rdsh.json` の SHA256 が変わらないことを確認する。
8. `rdsh doctor --json` の表示に判定・種別・根拠URL・確認日が出ることをテストする。

## routing 提案（#513）との関係

[provider-quota-routing.md](proposals/provider-quota-routing.md) は利用枠の消費を抑える読み取り専用の
`rdsh route plan` を提案しており、ZDR を Non-goals に置いている。この要件はその入力を与える。

- `rdsh route plan` に ZDR の要求を渡した場合、表で `available` のルートだけを `eligible` とし、
  `unknown` と `unavailable` は除外理由付きで `excluded` にする。`declared` は `unknown` と同じ扱いにする。
- ZDR を要求した比較で候補が 1 つでも欠けたら、既存の fail-closed と同じく
  `recommendation: null` と `coverage: incomplete` を返す。
- 利用枠の比較（どのルートが安いか）と ZDR の判定（どのルートが保持しないか）は別の軸として表示し、
  片方だけで推奨を確定しない。
- `features.zdr` と `features.route_plan` は独立のスイッチとする。ZDR モードは `route plan` が
  無効でも起動時の判定と表示を行う。

## 未確認・限界

- HAI の ZDR の公開情報は確認できていない（2026-10-17 時点）。
- OpenRouter の本文型は、dsh が `openRouterRouting` を withhold しているため rdsh からは注入できない
  （dsh d7432673 / pi-ai 1.0.2 の `COMPLETIONS_COMPAT_GATE`）。アカウント設定に依存する。
- オーバーレイの適用順序と、プロファイルの `headers` より優先されるかは未確認。実装Issueで確認する。
- 表の `checked_at` は人が更新する。プロバイダの規約変更を rdsh が自動で検出はしない。
- ZDR はプロバイダの契約であり、rdsh はその履行を検証しない。

## 実装の分割（親 #87 へのリンク）

合意後は次の単位で実装する。親 [#87](https://github.com/jimoto-no-llm/rustdsh/issues/87) は closed のため、
実装Issueは別途起票する。

1. ZDR 表と判定（`source_url` / `checked_at` / fail-closed）。
2. ヘッダー型のオーバーレイ生成と検証。
3. `rdsh --zdr`・`features.zdr`・`RDSH_ZDR` と、バナー・`doctor`・`auth` の表示。
4. `rdsh route plan`（[#513](https://github.com/jimoto-no-llm/rustdsh/pull/513)）への ZDR フィルター連携。

## 受入条件（この要件）

- [x] 1. 対象範囲を決めた（同一プロファイルの全 LLM リクエスト。dashboard の外部エージェントは対象外）。
- [x] 2. 判定の根拠と `unknown` の扱い（fail-closed）を決めた。
- [x] 3. 強制の方法（ヘッダー型 / 本文型 / 自己ホスト）と、非対応ルートの扱いを決めた。
- [x] 4. 切り替え方法と表示先、`rdsh.json` のスキーマ案を決めた。
- [x] 5. 失敗時の扱い（フォールバックしない）と、検証可能性の範囲を決めた。
- [x] 6. 「保持しない」の定義と、routing 提案との関係を決めた。
