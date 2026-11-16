# native-compaction

通信を行わない共通ライブラリです。入力 ZIP のクレートを rustdsh に統合しています。
しきい値、ツールの切れ目、費用計算、指示の検査、対応表、記録、プロバイダ形式のヘルパーを提供します。

root の `Cargo.toml` のライブラリターゲットと、`crates/native-compaction/Cargo.toml` は
同じ `src/lib.rs` を使います。後者は独立した未公開クレートです。
ソースを `src/` 配下に保持し、rustdsh のパッケージ配布にも含めます。
Rust 1.85 以上、依存は serde_json だけです。

リポジトリのルートから実行します。

```sh
cargo test --locked --lib
cargo test --locked --manifest-path crates/native-compaction/Cargo.toml
```

プロバイダ側の処理はリクエスト本文の構築・応答の読み取り・不透明な結果の往復までです。
認証、HTTP、永続保存は行いません。DSH/native-web の実送受信には接続していません。
対応範囲と出典は [Native Compaction](../../docs/COMPACTION-POLICY.md) を参照してください。
