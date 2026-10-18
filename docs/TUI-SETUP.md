# TUI profile setup

This is a preserved setup example for DSH 0.2.0-rc.2. The pinned plugin below
has not been revalidated against newer DSH releases.

`rdsh tui` delegates to the `tui` profile in dsh. DSH 0.2.0-rc.2 does not ship
that profile, so a fresh installation needs a TUI plugin first. The
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
`rdsh tui` で起動できます。Web側の設定は変更しません。
`profile "tui" does not exist` は、プロファイルが未導入の場合に出るエラーです。
