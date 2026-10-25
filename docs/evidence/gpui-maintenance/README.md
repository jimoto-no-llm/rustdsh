# GPUI整備の検証

2026-10-24、最新main `698f565` 上の独立ブランチをLinux instaboxで確認しました。
入力修正の前提となるfmt・未使用コード・Clippy・依存の互換性整理です。

- GPUIのfmt、debug/releaseの厳格Clippyは警告0です。
- `cargo test --locked` とrelease試験は、それぞれ103単体＋3プロセス試験が成功しました。
- 実DSHへの接続・再利用・セッション・モデル選択・live接続・停止の12経路が成功しました。
- 実WaylandのASCII対照試験では、従来どおり `abc123` が `aabbcc112233` になります。
  入力修正は後続PRに限定しています。
- vendorしたproc-macro-error2は、元crateのSHA256を確認しました。
  元の非公開宣言は厳格な互換性lintで失敗し、公開宣言への1行修正後は成功します。
  整形と同梱構成の差はvendorのNOTICEに記載しています。

[機械可読結果](verification.json) と
[由来・ライセンス・除去条件](../../../apps/rdsh-desktop/vendor/proc-macro-error2/NOTICE.md) を参照してください。
macOS/WindowsのGitHub CIは公開後に確認します。入力E2Eや見た目の変更はこのPRに含みません。
