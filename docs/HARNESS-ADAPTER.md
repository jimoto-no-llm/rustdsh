# Harness adapter seam / ハーネスアダプター層

rdsh のマイクロオーケストレータ層と委任先 harness をつなぐ接合点の仕様です。
「委任先は差し替え可能」というREADMEの表現の実体です。

## 契約

`src/harness_adapter.rs` は次の trait を定義します:

```rust
pub trait HarnessAdapter {
    fn resolve_binary(&self) -> Option<String>;
    fn build_command(&self, options: &LaunchOptions) -> anyhow::Result<BootedCommand>;

    fn launch(&self, options: &LaunchOptions, locale: crate::locale::Locale) -> anyhow::Result<()> {
        let booted = self.build_command(options)?;
        crate::passthrough::finish_launch(booted, options.dry, locale)
    }
}
```

`LaunchOptions` は profile、from_default、patches、app_args、dry、slim、locale を保持します。
`BootedCommand` は `std::process::Command` と順序付きの `notices: Vec<String>` を返します。
`launch()` は共通の実行・dry-run 処理を使う既定メソッドです。
この接合点はコンパイル時の差し替え用で、実行時のアダプタ選択機能ではありません。

- `DshAdapter`: 同梱アダプター。既存の `passthrough` の挙動（slim env、web assets、gzip overlay、web_search bridge など全部）をそのまま引き受けます。
- 他のハーネス向けアダプター（OpenAI互換CLI を起点とするエージェント等）は、この trait を実装するだけで `rdsh` の管理層を使用できる、というのが milestone の位置付けです。

## ここが境界

- 委任先が MUST 満たす: 子プロセスへの委任と終了コードの引き受け、環境変数の上書き権限。
- rdsh側は provider、検索エンジン、guard までを atomic に差し替えられるよう独立（現行はここまで含めて動く）。

## Milestone（roadmap）

| 段階 | 内容 | 状態 |
| --- | --- | --- |
| 1 | `HarnessAdapter` trait と `DshAdapter` の実装 | 実装済み |
| 2 | OpenAI互換CLI と同等契約を満たす adapter の一例 | next |
| 3 | Rust workspace 分離（`rdsh-core` = 管理層、`rdsh-dsh` = アダプター crate） | planning |
