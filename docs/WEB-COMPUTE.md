# Web計算の委譲 PoC（rdsh-compute/1）

分析 `RDSH_WEB_ACCELERATION_ANALYSIS.md` の実装の第一歩です。
結論（通すだけでは速くならない、まず計測）をそのまま守ります。

## 方針

- DSH が正本（セッション・権限・Agent Loop・イベント・認証）を保持します
- Rust は純粋計算のみ（`tokens.estimate` / `tokens.prune`）とし、読み取り専用相当とします
- 既定は OFF（`RDSH_COMPUTE=1` でのみ Rust 経路）とし、失敗時は元の Node 処理にフォールバックします
- `rdsh serve`（64 KiB 上限・5ms ポーリング）は高速 RPC には使いません
- 毎回の CLI 起動は行わず、常駐の `rdsh compute`（stdio NDJSON）を使います
- デコード後のテキストは 1 リクエストあたり 1 MiB を上限とし、大きな履歴は呼び出し側で分割します。
  生の NDJSON フレームにも `6 × 1 MiB + 64 KiB` の上限を設けます。
  JSON の最大エスケープ膨張を許容しつつ、読み込み時のバッファーを制限します。
  超過した行は `too_large` で拒否して改行まで読み捨て、次の要求を受け付けます。
- `tokens.estimate_batch`（最大64件・件毎256 KiB・合計1 MiB）で複数のテキストを 1 往復に集約します。小さなテキスト 200 件の常駐比較では約 1.4 倍（1.76ms→1.29ms）となりますが、大きなテキストでは差がありません
- `rdsh serve` のアイドル時の accept 待ちを 100ms→5ms に短縮しました。アイドル打鍵の初動は中央値で 93.5ms→3.6ms（約26倍）となりましたが、応答内容・上限・認証・終了処理は変わりません

## 構成

```text
Web GUI → DSH Host/Plugin → plugins/rdsh-compute → stdio → rdsh compute
                         ↘ (失敗・無効時は元の実装)
```

プロトコルは `src/compute.rs` の版付き NDJSON（`rdsh-compute/1`）です。
未知の版・操作・巨大な入力・非 UTF-8 は実行せずに拒否します。

## 計測（採否の式）

1 画面の所要時間を概念的に次のように分けます。

`T_total = T_DSH + T_serialization + T_IPC + T_Rust + T_browser`

改修前は `T_before = T_DSH_original + T_browser_original` です。
Rust で短縮できた時間が IPC・変換・描画への影響を上回る場合にのみ採用します。
関数の単体での高速化は採用理由としません。

- Rust 側の `elapsed_us`（ワーカー内の純粋な処理時間）
- Node 側の `bridge_us` / `total_us`（往復・変換込み）
- 比較対象: (1) 元の Node 関数 (2) 毎回の CLI 起動 (3) 常駐ワーカー

## 使い方

```sh
# 常駐ワーカーの手動確認
echo '{"v":1,"id":"t1","op":"tokens.estimate","text":"hello"}' | rdsh compute --once

# Node プラグインのテスト
(cd plugins/rdsh-compute && npm test)

# IPC 込みの比較（同一入力・同一環境・複数回で）
time echo '{"v":1,"id":"t1","op":"tokens.estimate","text":"hello"}' | ./target/release/rdsh compute --once
```

## 受入条件（抜粋）

- [ ] 同一の入力で Rust / Node の出力が一致する
- [ ] 既定 OFF の状態で既存の Web・CLI・dashboard が壊れない
- [ ] 版の不一致・破損・巨大な入力・異常終了時にフォールバックする
- [ ] エンドツーエンド（ブラウザの操作時間）の改善が測定できている
- [ ] 効果がなければ既定化せず、根拠と反例を残す

## 次の候補（未着手）

- 段階1のベースライン（240ターン・3,000件の一覧・1,000件の検索での本家ベンチマーク実行）
- 実ワークロード1件の限定的な移植（既定は OFF のまま）
- OS マトリクス（Windows ネイティブ / WSL / Linux / macOS）の対応表
