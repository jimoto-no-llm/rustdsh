# Web計算の委譲 PoC（rdsh-compute/1）

分析 `RDSH_WEB_ACCELERATION_ANALYSIS.md` の実装第一歩です。
結論（通すだけでは速くならない、まず計測）をそのまま守ります。

## 方針

- DSH が正本（セッション・権限・Agent Loop・イベント・認証）を保持します
- Rust は純粋計算のみ（`tokens.estimate` / `tokens.prune`）。読み取り専用相当
- 既定 OFF（`RDSH_COMPUTE=1` でのみ Rust 経路）。失敗時は元の Node 処理にフォールバック
- `rdsh serve`（64 KiB 上限・100ms スリープ）は高速 RPC に使いません
- 毎回 CLI 起動はしません。常駐 `rdsh compute`（stdio NDJSON）を使います
- 1 リクエスト 1 MiB 上限。大きな履歴は呼び出し側で分割します

## 構成

```
Web GUI → DSH Host/Plugin → plugins/rdsh-compute → stdio → rdsh compute
                         ↘ (失敗・無効時は元の実装)
```

プロトコルは `src/compute.rs` の版付き NDJSON（`rdsh-compute/1`）です。
未知の版・操作・巨大入力・非 UTF-8 は実行せず拒否します。

## 計測（採否の式）

1 画面の所要を概念的に次で分けます。

`T_total = T_DSH + T_serialization + T_IPC + T_Rust + T_browser`

改修前は `T_before = T_DSH_original + T_browser_original`。
Rust で短縮できた時間が IPC・変換・描画への影響を上回る場合だけ採用します。
関数の単体高速化は採用理由にしません。

- Rust 側 `elapsed_us`（ワーカー内純粋時間）
- Node 側 `bridge_us` / `total_us`（往復・変換込み）
- 比較対象: (1) 元の Node 関数 (2) 毎回 CLI 起動 (3) 常駐ワーカー

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

- [ ] 同一入力で Rust / Node の出力が一致する
- [ ] 既定 OFF で既存 Web・CLI・dashboard が壊れない
- [ ] 版不一致・破損・巨大入力・異常終了でフォールバックする
- [ ] エンドツーエンド（ブラウザ操作時間）の改善が測れている
- [ ] 効果がなければ既定化しない。根拠と反例を残す

## 次の候補（未着手）

- 段階1のベースライン（240ターン・3,000一覧・1,000検索の本家ベンチ実行）
- 実ワークロード1件の限定移植（既定 OFF のまま）
- OS マトリクス（Windows ネイティブ / WSL / Linux / macOS）の対応表
