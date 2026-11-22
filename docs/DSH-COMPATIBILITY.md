# DSHの機能別対応範囲

この表は公開版 rdsh v0.15.0 と main の b6aac05 にある実装・同梱物を照合したものです。
「保護付き委譲で監査済み」「ACPで有効にできる」「peer依存の宣言」「上流の検証対象」は、それぞれ確認する範囲が異なります。
全機能に共通する一つの対応版一覧として扱わないでください。

| 機能 | 版・条件 | 根拠 |
| --- | --- | --- |
| Rustの保護付きツール委譲 | DSH / toolsが同一の `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.3`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`..`0.2.2-rc.5`。Linux x86_64と隔離用ツールが必要 | [`AUDITED_ADAPTERS`](../src/tool_security.rs)と[プリロード検証](../security/preload.mjs)。版名に加え、実際の入口・ツール本体のバイト列を検証する |
| DashboardのDSH ACPセッション操作 | `0.2.0-rc.2` / `0.2.2-rc.5`。版のプローブに加えてACP初期化・能力確認が必要 | [`adapter-catalog.mjs`](../dashboard/adapter-catalog.mjs)と[CLIアダプター](CLI-ADAPTERS.md)。以前の文書にあったalpha.1は、現在のカタログにはない |
| Dashboardのプロジェクト固定更新 | DSH `0.2.0-rc.2` と、取得・検証したNode、CLI、アダプター、プラグインの組み合わせ | [`release-artifacts.mjs`](../dashboard/release-artifacts.mjs)と[固定更新](STAGED-UPDATES.md#capture-trusted-runtime-code) |
| 任意の `rdsh-mcp-exposure` | DSH関連peerの宣言は `0.2.0-rc.2`、`0.2.1-alpha.3`、`0.2.1-rc.3`、`0.2.1-rc.4`。`0.2.2-rc.5` は未検証のため宣言に加えていない。Cordisの条件も別にある | [`package.json`](../plugins/rdsh-mcp-exposure/package.json)。peer範囲だけで実通信や全機能の検証成功を意味しない |
| 同梱の `dsh-mobile-maxxing` v1.0.4 | 同梱READMEが明記する検証対象は `0.2.1-rc.2` / `0.2.1-rc.3` / `0.2.2-alpha.2` | [同梱README](../plugins/dsh-mobile-maxxing/README.md)。別コミットの上流READMEや次版PRでの検証を、同梱物へ自動適用しない |

Rustの通常委譲は、保護付きツール委譲とは異なる起動経路です。
通常起動できたことだけで、ACP・隔離・任意のプラグインが同じ版で使えるとは判断しません。
DSH 0.2.2-alpha.3の保護付き委譲は [PR #1054](https://github.com/jimoto-no-llm/rustdsh/pull/1054) の追加対応で、公開版v0.15.0には含まれません。
0.2.2-rc.1〜rc.5の追加は [rc.4/rc.5の監査記録](evidence/dsh-rc5/README.md) にまとめています。
他の機能の対応範囲も、そのPRだけでは広がりません。
`rdsh-llm-native`、`rdsh-compaction`、`rdsh-subagent-optimizer` のpeer範囲には、実際に読み込みと契約テストを確認した `0.2.2-rc.5` だけを加えました。
`rdsh-mcp-exposure` など、確認できていないプラグインの範囲は広げていません。
プリロードは、`rdsh-mcp-exposure` の開発依存が固定する `0.2.1-rc.5` の入口
（監査済みの `0.2.1-rc.3`/`rc.4` と同一バイト列）も受け付けますが、
起動側の監査表には追加していません。

## 導入・更新時の確認

1. 利用する機能を決め、その機能の対応版と条件を確認します。
2. DSHと対応するパッケージの版をそろえます。保護付き委譲ではソース検証も通す必要があります。
3. 必要なプラグインを対象プロファイルで検証します。peer依存のエラーを無視して導入しません。
4. 版・プロトコル・バイト列の不一致で拒否された場合、許可範囲や検証を外して回避しません。

npmの `latest`・`next`・`alpha` は更新される配布タグです。公開されたことと、このリポジトリで検証されたことを区別してください。
上流DSHの依存脆弱性は、実際に導入する版の依存グラフで別途確認する必要があります。
このリポジトリのGitHubアラートが0件でも、別途npmで導入したDSHの依存まで安全と保証するものではありません。

## 上流依存の監査

2026-11-05に、npmのlatestが指す `@deepseek-ai/dsh@0.2.1-rc.5` を一時ディレクトリで
`--package-lock-only --ignore-scripts` により解決し、コードを実行せず `npm audit` で確認しました。
`undici 8.11.2`、`zod 4.4.3`、`@modelcontextprotocol/client 2.2.0`、`fflate 0.8.2` が
既知advisoryの対象に含まれることを再現しています。別の場所に修正版が同居していても、古い版の解決が消えるわけではありません。
[解決した版とadvisory](evidence/doc-audit-20261105/upstream-rc5-audit.json)を参照してください。

`latest` を安全性の検証済み既定値として導入しないでください。依存を変更するときは、対象版の
アダプター・プロトコル・プラグイン契約も再検証します。互換性を確かめずに依存を上書きしたり、
起動前のバイト列検証を弱めて通したりする変更は、この修正には含めていません。

自動導入PR #1059が固定していた `0.2.2-alpha.3` でも同じ4ライブラリの影響を確認しました。
[alpha.3の解決結果](evidence/doc-audit-20261105/upstream-alpha3-audit.json)を記録しています。
自動導入の固定先を `0.2.2-rc.5` に移した後も、解決した `undici 8.11.2`、`@modelcontextprotocol/client 2.2.0`、`fflate 0.8.2` が
既知advisoryの対象に残ることを再確認しました（[rc.5の解決結果](evidence/dsh-rc5/rc5-audit.json)）。
固定版の変更は依存の修正ではありません。`0.2.2-rc.5` の依存脆弱性が解消したとは扱わないでください。

利用者専用 runtime（`install.sh` / `install.ps1` が作る隔離ディレクトリ）では、DSH の導入前に manifest の
`overrides` へ修正版を固定します（`undici 8.12.3`、Zod 4 のみ `4.6.7`、
`@modelcontextprotocol/client 2.3.1`、`fflate 0.8.3`）。既存の依存・無関係な override は保持し、
不正な manifest やシンボリックリンクは拒否します。DSH 本体と監査済みバイト列は変更しません。
`0.2.2-rc.5` では、2026-11-22 に素の状態で75件のadvisoryを再現し、上記4つの override を入れると
`npm audit` が0件になり、`npm ls` にも invalid が出ないことを再確認しました。
2026-11-10 の初回検証は[記録](evidence/one-command-install/dependency-repair-20261110.md)（当時の固定版 alpha.3）にあります。
この修正は利用者専用 runtime のみが対象で、別途導入した DSH や上の未修正の解決結果は変わりません。
Windows 実機の実行は未確認です。
