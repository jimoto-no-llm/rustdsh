# Native Compaction

通常起動では DSH に絶対トークン数の圧縮ポリシーを渡します。
`native-web` では Rust が所有する履歴を圧縮します。
DSH の会話ループ、要約記録、ツールの境界判定、窓あふれ時の再試行は上流の実装を使います。

## 設定

設定先は `$DSH_HOME/rdsh-compaction.json`、既定は `~/.dsh/rdsh-compaction.json` です。
`rdsh.json` の保存で消えない独立したファイルです。

```json
{
  "schema": 1,
  "policies": [{
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "context_window": 1000000,
    "output_reserve": 8192,
    "trigger_tokens": 150000,
    "retain_tokens": 20000,
    "max_tokens": 8192
  }],
  "instructions": "Summarize the conversation. Preserve constraints, paths and denied calls. Do not call tools.",
  "routes": [{ "provider": "deepseek", "model": "deepseek-v4-flash", "method": "dsh_summary" }],
  "native_web": {
    "enabled": true,
    "trigger_bytes": 419430,
    "retain_bytes": 83886,
    "tool_result_tokens": 1024
  }
}
```

上の値は設定例です。ルート名、窓、出力予約は DSH が実際に解決する値に合わせてください。
`retain_tokens` は `trigger_tokens` 未満とし、要約の `max_tokens` は明示します。
未知の項目、重複ルート、不正な数値は拒否します。最大 256 KiB、ポリシーは最大 200 件です。

通常起動への適用は既定でオフです。

```sh
rdsh features on compaction_policy
rdsh plugins install --profile headless --recommended compaction
rdsh plugins install --profile web --recommended compaction
```

`policies` だけなら追加プラグインは不要です。`instructions`、`routes`、`early` を使う場合は
`rdsh-compaction` が必要です。対象は **DSH 0.2.1-rc.2**。DSH の自動更新は行いません。
プラグインのインストールだけでは圧縮の構成を変更しません。

## 起動時の適用

合成済みの `dsh --dump-config` から、既存の設定を保持したオーバーレイを作ります。
`thresholdRatio: 1` と `headroomTokens = context_window - output_reserve - trigger_tokens` を使い、
割合に依存しない発動点に変換します。既存の `modelPolicies` は上書きしません。

プラグインが必要な場合、headless は旧バックエンドを無効化して置換行を追加します。
DSH のパッチの `name` は代入ではなく照合条件なので、直接変更しません。
Web は standard、ptc、minimal、cordis の各プリセットの `config` を再構成して中の実装を置換します。
無効化されたトップレベル行には追加しません。

出力先は `$DSH_HOME/compaction/policy-<SHA256>.patch.yml` です。
内容別のファイルを原子的に作るため、異なるプロファイルの同時起動でも設定が混ざりません。
使わなくなったオーバーレイは手動で削除できます。プロファイル本体は書き換えません。
利用者の `--patch` は生成したオーバーレイの後に渡すため、利用者の指定が優先されます。
プラグインに置き換えた headless では、後続パッチの対象 ID は `rdsh-compaction` です。
Web は従来どおり各 preset の `config` 内を指定します。`name` を照合条件に使う場合も
置換先の `rdsh-compaction` に合わせてください。

機能がオフ、またはファイルがない場合は通常起動を維持します。
有効化した設定が不正、必要なプラグインが未導入、設定合成が失敗した場合は起動を拒否します。
対象行がない場合や出力ファイルを書けない場合は、適用できなかったことを通知します。

`instructions` を省略すると DSH の既定指示を使います。指定時は最後の user 指示だけを差し替えます。
会話の先頭、ツール宣言、モデル、出力上限、用途、キャンセル信号は保持します。
上流の形状が変わった場合は要約を失敗させ、会話本文を誤って書き換えません。

## 方式と費用

`routes.method` は `dsh_summary` と `off` のみです。未記載のルートは DSH の要約を使います。
`off` は自動圧縮と窓あふれ救出を止めます。手動の `/compact` は残ります。
プロバイダ側の圧縮や未対応の方式を、別の方式へ黙って置き換えることはありません。

必要な場合だけ、設定全体へ `"early": {"expected_turns":10,"min_tokens":100000}` を追加します。
インストール済み pi-ai のカタログから単価を読み、要約とキャッシュ再構築の費用を
予想継続ターン数以内に回収できる場合だけ早期圧縮します。
ツール境界を考慮した対象範囲で計算しますが、要約長は出力上限による見積もりです。
無料のキャッシュ読み出しを有料入力として計算しません。
単価不明のルートや別の要約モデルには適用せず、価格を推測しません。
費用計算が失敗しても通常の圧縮は妨げません。

DSH から Rust へ渡すのはトークン数と単価だけです。本文や資格情報は渡しません。
費用の式は予測用の独自モデルで、請求額やキャッシュの保持を保証しません。

## native-web

native-web の圧縮は既定で有効で、通常起動の機能スイッチとは独立しています。
`native_web.enabled: false` で無効化できます。既存の Rust 所有ループの履歴管理だけを拡張します。

- 新規入力を受けた最初のステップと、各ステップの上限確認前に測定します。
- バイトしきい値は既定 419,430、残す量は 83,886。硬い上限は従来の 512 KiB です。
- 窓が分かるモデルでは、窓の 80% と「窓 − 出力予約」の小さい方でも判定します。
  `native_web.trigger_tokens` と `retain_tokens` で変更できます。窓不明時はバイト数だけを使います。
- 最初の user メッセージと直近のやり取りを残し、ツール提案と結果を分断しません。
- 先に古いツール結果の `content`、`stdout`、`stderr` を削り、JSON 構造を保持します。
- まだ大きい場合だけ、選択中の同じプロバイダ・モデルで要約し、秘密値を伏せます。
- `USER_DENIED` は構造化した記録として付加し、再圧縮後も残します。
- 失敗、空要約、容量が減らない要約、キャンセルでは削減前の履歴を保持します。
- 成功時は件数と前後のバイト数だけを通知します。置換元の本文と重複するツールイベントは除去します。

送信後の窓あふれ再試行、別モデルへの要約委託、費用による早期発動、プロバイダ側の圧縮は
native-web の対象外です。SDK の不明な窓容量も推測しません。

## 診断と記録

```sh
rdsh doctor
rdsh doctor --json
rdsh compaction capabilities
rdsh compaction report /path/to/session.jsonl
rdsh compaction decide --input-file /path/to/cost-input.json
```

doctor は機能スイッチ、設定の妥当性、ルートの絶対値を表示します。
JSON には `compaction_policy` と `compaction_capabilities` を含めます。
DSH は起動しないため、適用行数は起動時の通知で確認します。

`report` は `compaction/start`、`compaction/summary`、`compaction/end` を ID で結合し、
完了・失敗・未完了、置換件数、使用トークン、要約の SHA256 とバイト数を出します。
要約・会話・rawOutput・エラーの本文は出さず、JSONL を書き換えません。入力は最大 64 MiB です。
圧縮されたログは先に別ファイルへ展開してください。`decide --input-file -` は標準入力を読みます。

## 受入範囲

入力 ZIP は `native-compaction-rustdsh-20261110.zip`、SHA256 は
`1e652fbf910db842e28ad1bc6411157cead0f745992ed9a942eae599483d0815` です。
要件の rustdsh 第2段階を対象とし、共通コードを `native_compaction` ライブラリへ統合しました。
独立した未公開クレートの入口は `crates/native-compaction/Cargo.toml` です。
同じソースを使用し、通常の `cargo package` にも実装を含めます。

| 要件 | 実装・検証 |
| --- | --- |
| RQ-01 / RQ-07 | 絶対値、方式の拒否、headless と Web 4プリセットの実 DSH 設定合成 |
| RQ-04 / RQ-08 | DSH の圧縮と救出を継承。off は両方を抑止 |
| RQ-05 | 共通 Rust 費用計算、DSH の早期判断、無料キャッシュ・不明価格 |
| RQ-06 | JSONL 集計、本文非表示、読み取り専用の実バイナリ試験 |
| RQ-09 | 実 DSH の要約要求を比較し、末尾指示以外の同一性を確認 |
| NW-01〜NW-05 | 模擬 HTTP プロバイダで要約・失敗・キャンセル・秘密値・拒否記録を確認 |
| RQ-02 / RQ-03 | 共通クレートの通信なしヘルパーと往復試験。DSH/native-web の送受信には未接続 |
| RQ-10 | 自前の記録に本文を出さず、native-web の要約先を固定。ZDR は下記参照 |
| RQ-11 | 入力要件どおり、ACON による指示最適化は後続工程 |

現在の [ZDR 要件](ZDR.md) は **実装なし** です。入力 ZIP の「既存 ZDR 判定に従う」という
前提は成立しません。この機能は ZDR を保証せず、DSH の元の履歴や要約も削除しません。
プロバイダ側の圧縮の実送受信には、上流アダプターの変更と保存契約の設計が必要です。
有料 API による圧縮の成功や要約品質を検証済みとはしていません。

形式の出典（2026-11-10 確認）:
[OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)、
[Anthropic threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)、
[Anthropic on-demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)、
[xAI Context Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction)。
