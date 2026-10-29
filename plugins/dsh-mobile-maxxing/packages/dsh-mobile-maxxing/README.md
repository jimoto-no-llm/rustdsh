# dsh-mobile-maxxing — `dsh-mobile-maxxing`

DSH（DeepSeek Harness）の Web UI をスマホで使い倒すための統合プラグインです。
PWA・通知・モバイルUXを1パッケージにまとめています。
CJK表示の修正は、PC 側の描画を変えない方針のため別パッケージ `rdsh-markdown-cjk` に分離しています。
**素の DSH にそのまま入ります。** コア機能に他の `rdsh-*` プラグインも外部 npm パッケージも不要です。

> English: [Jump to the English section](#english)

![インストールカード](docs/install-card.png)

## インストール

```sh
dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing
# DSH を再起動して読み込む（例: systemctl --user restart dsh-web.service）
```

`dsh plugin --profile web add` が依存と bundle の両方を更新します
（`--profile` は必須で、`cd ~/.dsh/profiles/web` は要りません）。手で書く場合はこうです。

```json
{
  "dependencies": {
    "dsh-mobile-maxxing": "https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.0/dsh-mobile-maxxing-1.0.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-mobile-maxxing"]
    }
  }
}
```

```sh
pnpm install        # プロファイル内。npm ではなく pnpm（DSH の profile は pnpm 管理）
```

開発中にこのチェックアウトを使う場合（依存と bundle の両方が入ります）:

```sh
dsh plugin --profile web add link:/path/to/dsh-mobile-maxxing
```

**必要なのはこれだけです。** 追加のプラグインも、`web-push` などのライブラリも要りません。
日本語の共有 UI だけは任意の別パッケージ `dsh-locale-ja` が所有します（この tarball には
含まれず、自動では有効になりません）。

```sh
dsh plugin --profile web add kuraneko1/dsh-locale-ja
```

詳細は [dsh-locale-ja リポジトリ](https://github.com/kuraneko1/dsh-locale-ja) を参照。

## できること

| 機能 | 内容 |
| --- | --- |
| インストール可能な PWA | ホーム画面に追加、オフライン起動、更新のお知らせ |
| 通知 | アプリを見ている間はアプリ内バナー、それ以外は Web Push |
| 通知音 | 合成した5種類。音量も設定可。音声ファイルは同梱しません |
| スマホ/タブレットのレイアウト | サイドバーがドロワーに、設定は1タップ、コードは既定で折り返し（解除可）。幅ではなく端末で判定 |
| コードレビュー | 折り返しを既定でON。右端の操作は「…」に集約し、PC で開く系は非表示 |
| テーマ（ライト／ダーク） | 上流のトークンに追従。PC と別に「この端末だけ」の配色を選べる |
| チャット表示（この端末のみ） | 作業の詳細・折りたたみ時機・実行中の Enter・性能表示を、この端末だけ上書き。共有設定は変更しない |
| モバイル操作の細部 | ターミナルだけダーク、上端で過去ログを自動読み込み、Trajectory タブの到達性、サブエージェント一覧の見出しと「実行中を上に」、ファイル検索のクリア、モデルメニューのセーフエリア、左端スワイプで戻る |
| CJK 表示の修正（任意） | 別パッケージ `rdsh-markdown-cjk` を入れた場合のみ。このパッケージ本体は PC 側を変えないため、Markdown レンダラを書き換えません |
| 日本語 UI（任意） | 別パッケージ `dsh-locale-ja`（`dsh plugin --profile web add kuraneko1/dsh-locale-ja`）を入れた場合のみ。この tarball には含まれず、自動で有効になりません |

## もっと詳しく

使い方・通知の仕組み・設定・既知の制限・クレジットは別ファイルにまとめています。

- **日本語**: [`docs/USAGE.ja.md`](docs/USAGE.ja.md)
- **English**: [`docs/USAGE.en.md`](docs/USAGE.en.md)

## 開発

```sh
npm test     # Node.js のテスト + 任意の Chrome CSS fixture 7件
```

ビルド工程はありません。`client.js` はブラウザにそのまま配信され、`index.js` は Node
標準モジュールだけで動きます。

---

## English

A single integrated plugin that makes the DSH (DeepSeek Harness) Web UI pleasant on phones and tablets:
installable PWA, notifications and a phone/tablet layout chosen by device mode.
The CJK autolink fix stays a separate package (`rdsh-markdown-cjk`) because this package deliberately
leaves the PC renderer untouched. **It installs on a stock DSH** — the core needs no other `rdsh-*`
plugin and no external npm package.

## Install

```sh
dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing
# then restart DSH to load it (e.g. systemctl --user restart dsh-web.service)
```

`dsh plugin --profile web add` updates both the dependency and the bundle list
(`--profile` is required; the `cd ~/.dsh/profiles/web` is not). By hand:

```json
{
  "dependencies": {
    "dsh-mobile-maxxing": "https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.0/dsh-mobile-maxxing-1.0.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-mobile-maxxing"]
    }
  }
}
```

```sh
pnpm install        # inside the profile; DSH profiles are pnpm-managed
```

To develop against this checkout (installs the dependency and the bundle):

```sh
dsh plugin --profile web add link:/path/to/dsh-mobile-maxxing
```

**That is all.** No companion plugin, no `web-push`, no build step. The shared Japanese UI
is owned only by the optional separate `dsh-locale-ja` package (not in this tarball, never
auto-enabled):

```sh
dsh plugin --profile web add kuraneko1/dsh-locale-ja
```

See the [dsh-locale-ja repository](https://github.com/kuraneko1/dsh-locale-ja) for details.
local-tarball install.

## What it does

| Feature | Detail |
| --- | --- |
| Installable PWA | Add to home screen, offline launch, update notice |
| Notifications | In-app banner while the app is on screen, Web Push otherwise |
| Notification sounds | Five synthesised presets with a volume control; no audio files ship |
| Mobile layout | Sidebar becomes a drawer, settings open in one tap, code wraps by default (toggle available) |
| Code review | Wrap is on by default; header actions collapse into a "…" menu; native open-in-app buttons are hidden |
| Light / dark theme | Follows the host tokens; a per-device palette can differ from the PC |
| Chat view (this device) | Work-details verbosity, collapse timing, busy Enter and performance detail overridden for this browser only |
| Mobile polish | Terminal-only dark, older history at scroll-to-top, Trajectory tab reachability, subagent-list heading with "Running first", file-search clear, model-menu safe area, left-edge swipe back |
| CJK rendering (optional) | Only with the separate `rdsh-markdown-cjk` package; this package leaves the Markdown renderer stock to avoid changing the PC |
| Japanese UI (optional) | Only with the separate `dsh-locale-ja` package (`dsh plugin --profile web add kuraneko1/dsh-locale-ja`); it is not in this tarball and is never enabled automatically |

## More detail

- **English**: [`docs/USAGE.en.md`](docs/USAGE.en.md)
- **日本語**: [`docs/USAGE.ja.md`](docs/USAGE.ja.md)

## Development

```sh
npm test     # Node.js tests + optional Chrome CSS fixture tests (7)
```

There is no build step: `client.js` is served verbatim and `index.js` uses only Node
built-ins.

## License

MIT. See [LICENSE](LICENSE). Credits for the referenced implementations are in
[`docs/USAGE.en.md`](docs/USAGE.en.md#credits).
