# TUI profile setup

This is a preserved setup example for DSH 0.2.0-rc.2. The pinned plugin below
has not been revalidated against newer DSH releases.

`rdsh tui` delegates to the `tui` profile in dsh when one is installed.
DSH 0.2.0-rc.2 does not ship that profile, so without the plugin below a fresh
installation has none; `rdsh tui` then starts the built-in Rust TUI
(`rdsh native-tui --backend dsh --dsh-profile web`, same DSH web profile and
the same boot layers) and prints one line saying so. An explicit
`rdsh --profile tui` or `rdsh boot --profile tui` is never redirected.

Creating the profile below is only needed when you want DSH's own TUI plugin
instead. The
[`@deepseek-harness-tui/dsh-tui` plugin](https://github.com/ccch1mneyyy/dsh-TUI)
supports this runtime; its 0.14.0 release declares compatibility with
DSH 0.2.0-rc.2.

With dsh and pnpm installed, create the profile through the supported plugin
manager:

```sh
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.14.0
rdsh tui
```

This adds the plugin to the `tui` profile and preserves the existing Web
profile. Do not create `tui` from the Web or headless template merely to hide
the missing-profile error: those templates do not provide a terminal UI.

If `tui` already contains a different custom terminal plugin, retain its
configuration instead of installing another terminal UI alongside it.
`rdsh --passthrough tui` still requires an installed profile.

## 日本語

`tui` はdsh標準のプロファイルではありません。上記のプラグインを導入すると
`rdsh tui` はDSHのTUIへ委譲します。Web側の設定は変更しません。
未導入の場合、`rdsh tui` は組み込みのRust TUI（`rdsh native-tui --backend dsh
--dsh-profile web` と同じDSH webプロファイル・同じ起動レイヤー）を起動し、その旨を
1行で表示します。`rdsh --profile tui` のような明示指定は切り替えません。
