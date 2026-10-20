# Web UI 埋め込み画像アセット — 独立検証 (task-4)

検証者: verify-assets (teammate)
検証日時: 2026-10-20 (JST)
作業ブランチ: `test/webui-lighter` (worktree `/var/tmp/wt-uiperf`)
検証対象: DSH インストール先
`/home/sahen/.local/opt/dsh-original/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
再現スクリプト: [webui-embedded-assets-repro.py](/var/tmp/wt-uiperf/docs/evidence/webui-embedded-assets-repro.py)

> **安全性**: 本検証は**読み取りのみ**。`dsh-web.service` は停止も再起動もしていない
> (検証前後で `ActiveState=active`, `NRestarts=0`, `MainPID=400989` 不変)。
> `~/.dsh` と元リポジトリ `/home/sahen/Projects/windows-migration/c1a2a17f4ca1-rustdsh` は未変更。
> GUI への認証付きアクセスができないため、実ネットワーク転送量は**未検証** (後述)。

---

## 0. 判定サマリ

| # | 主張 | 判定 | 実測値 |
|---|---|---|---|
| 1 | 全75プラグイン | **一致** | 75 (`*/lib/client.js` の個数) |
| 2 | client.js 合計 11,619,693 chars | **一致** (char 単位。byte は 11,664,203) | 11,619,693 chars |
| 3 | うち 3,645,684 chars が base64 画像 | **不一致** | 3,645,716 (接頭辞込み) / 3,645,224 (payload のみ) |
| 4 | 31.4% | **一致** (丸めの範囲内) | 31.375% |
| 5 | 最大は dsh-client-ui-settings-account の 3,205,173 chars | **不一致** | 3,209,194 chars |
| 6 | 内訳は welcome/recharge の8枚 + SVG 2枚 | **概ね一致** (SVG は 2枚ではなく 4枚) | WebP 8枚 + SVG 11枚 + PNG 1枚 = 20件 |
| 7 | 参照は `locale === "zh"` 三項演算子 + `darkSrc` | **一致** (逐語で確認) | 1ファイル内に2箇所 |
| 8 | 同時に使われるのは 2 枚だけ、残り6枚は常に未使用 | **不一致 (誤り)** | 8枚すべてコード上到達可能。同時表示は 4 枚 (light 2 + dark 2) |
| 9 | base64 の WebP が gzip でほとんど縮まない | **一致** (理由の記述は要補足) | 実 WebP の gzip 比 0.99875 |

---

## 1. 計測手順

```bash
cd /var/tmp/wt-uiperf
python3 docs/evidence/webui-embedded-assets-repro.py
```

3回連続実行して同一値であることを確認済み (決定論的)。

### 1.1 「75プラグイン」の同定

`find` で `client.js` を拾うと **87 件**になる。これは `lib/types/client.js` など
型定義の副産物 12 件を含むため。プラグイン本体の client バンドルは
`<pkg>/lib/client.js` であり、これが **75 件**で主張と一致する。

```text
$ find . -name client.js -type f | wc -l                      -> 87
$ find . -maxdepth 3 -path '*/lib/client.js' -type f | wc -l  -> 75   <== 主張と一致
```

### 1.2 合計値: char と byte の区別

```text
total bytes : 11664203
total chars : 11619693   <== 主張の 11,619,693 はこちら
non-ascii   : 22312 chars
```

主張の 11,619,693 は **文字数 (UTF-8 デコード後の len)**。ファイルサイズ (byte) は
11,664,203 で 44,510 の差がある。数値自体は再現するが、単位は「chars」と明記すべき。

### 1.3 base64 埋め込み量: 主張値が再現しない

```text
data:image URIs           : 20
base64 chars (w/ prefix)  : 3645716   (31.375%)
base64 chars (payload)    : 3645224   (31.371%)
主張値                     : 3645684
差 (接頭辞込み)            : +32
差 (payload のみ)          : -460
```

境界の定義を変えても主張値 3,645,684 は再現しなかった。試した定義:

| 定義 | 値 |
|---|---|
| payload のみ (`[A-Za-z0-9+/=]` を前進) | 3,645,224 |
| 接頭辞 `data:...;base64,` 込み | 3,645,716 |
| 二重引用符 `"` も含める | 3,645,733 |
| 閉じ括弧 `)` も含める | 3,645,719 |

いずれも一致しない。**正しい値は 3,645,716 chars (接頭辞込み) / 31.375%** であり、
主張の 3,645,684 は 32 chars 過小。ただし**丸め後の 31.4% は一致**するため、
結論への影響はない。

### 1.4 最大パッケージ: 不一致

```text
dsh-client-ui-settings-account : 3209194 chars   <== 実測
主張値                          : 3205173 chars
差                              : +4021 chars
内訳: WebP 8枚 (3,200,352) + SVG 6枚 (8,668) + ... = 3,209,194
```

同パッケージのファイル全体は 3,415,941 chars (bytes 3,417,829)。
**正しい値は 3,209,194 chars** (ファイル全体ではない点に注意)。

### 1.5 内訳: SVG の枚数が違う

```text
data:image/svg+xml;base64,   11 件
data:image/webp;base64,       8 件
data:image/png;base64,        1 件
合計                         20 件
```

主張は「8枚 + SVG 2枚」だが、実際は **SVG 11枚** (うち当該パッケージに 6枚、
残りは dsh-client-ui-plugin-manager 等)。「SVG 2枚」は
`onboarding_office_default` と `onboarding_code_default` の 2 **変数**を指している
可能性が高いが、全体の件数としては誤り。

---

## 2. 「8枚のうち2枚だけ使用」は誤り — コード上の反証

これが本検証で最も重要な訂正。**8枚すべてがコード上到達可能**である。

### 2.1 各変数の参照回数

宣言に続く参照が、8変数すべてに存在する (宣言1 + 参照1 = 2 回)。

```text
onboarding_welcome_default             decl+refs=2
onboarding_welcome_dark_default        decl+refs=2
onboarding_welcome_zh_default          decl+refs=2
onboarding_welcome_zh_dark_default     decl+refs=2
onboarding_recharge_default            decl+refs=2
onboarding_recharge_dark_default       decl+refs=2
onboarding_recharge_zh_default         decl+refs=2
onboarding_recharge_zh_dark_default    decl+refs=2
```

### 2.2 実際の参照コード (逐語)

`welcome` 側 (実測の該当箇所):

```js
children: (0, react_jsx_runtime.jsx)(OnboardingIllustration, {
    className: DesktopOnboarding_module_css_default.welcomeArtwork,
    src: locale === "zh" ? onboarding_welcome_zh_default : onboarding_welcome_default,
    darkSrc: locale === "zh" ? onboarding_welcome_zh_dark_default : onboarding_welcome_dark_default
})
```

`recharge` 側 (実測の該当箇所):

```js
children: (0, react_jsx_runtime.jsx)(OnboardingIllustration, {
    className: DesktopOnboarding_module_css_default.creditIllustration,
    src: locale === "zh" ? onboarding_recharge_zh_default : onboarding_recharge_default,
    darkSrc: locale === "zh" ? onboarding_recharge_zh_dark_default : onboarding_recharge_dark_default
})
```

主張の「`locale === "zh"` の三項演算子と `darkSrc` の組み合わせ」は**逐語で一致**。

### 2.3 darkSrc は削除されず DOM に描画される

`OnboardingIllustration` の定義 (実測):

```js
function OnboardingIllustration({ className = "", src, darkSrc }) {
    return (0, react_jsx_runtime.jsxs)("div", {
        className: `${DesktopOnboarding_module_css_default.illustration} ${className}`,
        "aria-hidden": "true",
        children: [(0, react_jsx_runtime.jsx)("img", {
            className: DesktopOnboarding_module_css_default.lightIllustration,
            src, alt: ""
        }), (0, react_jsx_runtime.jsx)("img", {
            className: DesktopOnboarding_module_css_default.darkIllustration,
            src: darkSrc, alt: ""
        })]
    });
}
```

`src` と `darkSrc` は**常に両方 `<img>` として描画**される。どちらを表示するかは
JS ではなく CSS が決める:

```css
.ywGceq_illustration img{width:100%;height:auto;display:block}
.ywGceq_illustration .ywGceq_darkIllustration{display:none}
body[data-ds-dark-theme] .ywGceq_lightIllustration{display:none}
body[data-ds-dark-theme] .ywGceq_darkIllustration{display:block}
```

したがって:

- ライトテーマ: `src` が表示、`darkSrc` は `display:none`
- ダークテーマ: `darkSrc` が表示、`src` は `display:none`

**「残り6枚は常に未使用」は成立しない。** 英語ライトなら
`welcome_default` + `recharge_default`、英語ダークなら
`welcome_dark_default` + `recharge_dark_default` が表示される。
つまり 1 セッションで同時に**表示**されるのは 4 枚
(ステップごとに light 1 + dark 1、ステップは welcome と recharge の2つ)。
中国語ロケールなら `_zh` 系に切り替わる。

> **補足 (推測ではなく観測の限界)**: 上記は**バンドル内のコードとCSSの静的な解析**結果。
> 実際に onboarding 画面を描画して `<img>` の `naturalWidth` を測る等の
> ブラウザ実測は、GUI が 401 を返し認証手段がないため**未検証**。

### 2.4 ただし「6枚は無駄」という主旨には別の根拠がある

表示されない 4 枚 (`darkSrc` 側の非選択分とロケール非選択分) も、
`<img src>` が DOM に存在するため**ブラウザは取得を試みる**。
`display:none` はダウンロードを防がないため、**転送量としては 8枚分が載る**。
バンドルが全プラグイン分を1回で配るなら、削減余地は
「未使用の6枚」ではなく「テーマ/ロケールで選択されない 4〜6枚を
遅延読み込みにできるか」という論点になる。

---

## 3. gzip で縮まないことの確認

### 3.1 全体とbase64の圧縮率

```text
all_raw    11664203   all_gzip    4406417   ratio 0.3778
base64_raw  3645716   base64_gzip 2679029   ratio 0.7348
rest_raw    8013618   rest_gzip   1720775   ratio 0.2147
```

base64 部分は 0.735 しか縮まず、コード部分 (0.215) の 3.4 倍縮みにくい。主張と一致。

### 3.2 しかし 0.735 は「既圧縮だから」ではない — 内訳の分解

base64 の 0.77 は **base64 アルファベット自体の性質** (6bit/文字 = 3/4 展開) で
説明できる。実際に WebP をデコードして測ると:

```text
base64 chars : 553492
decoded bytes: 415118
magic        : b'RIFF' WEBP       <- 本物の WebP
gzip(decoded webp) bytes: 414599
  -> ratio vs decoded   : 0.998750   (1.0 = 圧縮不能)
  -> delta bytes        : -519
```

**デコード済み WebP は gzip で 519 バイト (0.125%) しか縮まない。**
これは WebP (VP8L 可逆圧縮) が既に圧縮済みであるためで、主張の理由付け
「既圧縮のため」は**正しい**。ただし base64 段階の 0.77 という数字を
そのまま「圧縮効果」と読むと誤解を招く。正しくは:

- 0.77 = base64 の 3/4 展開が戻るだけ (情報量は減っていない)
- 0.9987 = 画像そのものが圧縮不能

対照実験として、同サイズのランダム base64 も 0.7739 となり、
**内容に関係なく base64 なら 0.77 程度になる**ことを確認した。

全 8 枚の WebP で同様に 0.7718 (合計 3,200,352 → 2,470,115)。

---

## 4. 未検証項目 (推測で埋めていない)

| 項目 | 状態 | 理由 |
|---|---|---|
| 実ネットワーク転送量 (gzip 後) | **未検証** | GUI `http://127.0.0.1:3080/` が 401。認証手段がなく、バンドル配信エンドポイントの応答を取得できない |
| ブラウザでの実描画・`<img>` 取得数 | **未検証** | 同上。DevTools/Playwright での実測は認証が前提 |
| 「初期ロード」の厳密な定義と対象範囲 | **未検証** | 全 75 バンドルが初期ロードで配られるのか、遅延ロードされるのかを実測できていない。本レポートは「インストール済み全 client.js の静的合計」を測ったもので、初期ロード転送量そのものではない |
| brotli 圧縮率 | **未検証** | `brotli` Python モジュールが未導入。CLI (`/usr/bin/brotli`) での計測は未実施 |

> 主張の「初期ロードの31.4%」という表現は、**静的な合計値の比率**としては
> 再現するが、初期ロードの実転送に対する比率としては本検証では確認できていない。
> 用語を「インストール済み client.js 合計に対する比率」と限定するのが正確。

---

## 5. 再現方法

```bash
cd /var/tmp/wt-uiperf
python3 docs/evidence/webui-embedded-assets-repro.py            # 人間可読
python3 docs/evidence/webui-embedded-assets-repro.py --json     # 機械可読
```

スクリプトは読み取り専用で、外部依存は Python 標準ライブラリのみ。
`--install` で別のインストール先も計測可能。

---

## 6. 結論

- 主張のうち **75プラグイン / 11,619,693 chars / 31.4% / 最大パッケージが
  settings-account / 三項演算子+darkSrc のパターン / gzip で縮まない** は再現した。
- ただし数値の細部に 3 点の不一致: base64 合計 (3,645,716 / 主張 3,645,684)、
  最大パッケージ (3,209,194 / 主張 3,205,173)、SVG 枚数 (11 / 主張 2)。
  いずれも結論を覆す差ではない。
- **「8枚のうち実際に使われるのは2枚、残り6枚は常に未使用」は誤り。**
  8枚すべてコード上到達可能で、テーマ (CSS `data-ds-dark-theme`) と
  ロケール (`locale === "zh"`) の組み合わせで選択される。同時に**表示**されるのは 4 枚。
  ただし `display:none` は取得を止めないため、
  「表示に使われない画像も転送される」という趣旨の指摘自体は妥当。
