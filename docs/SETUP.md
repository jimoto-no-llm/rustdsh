# セットアップ手順書（AI に読ませる用）

このファイルは **AI エージェントにそのまま読ませる**ための手順書です。
人向けの説明は README にあります。ここは「上から順に実行すれば終わる」形でだけ書きます。

対象は、Rust も Node.js も DSH も触ったことがない人です。
コマンドは 1 行ずつ、そのままコピーして実行できます。

---

## 0. エージェントへの指示（この節はいちばん先に読む）

あなたはこのリポジトリの利用者を、DSH（DeepSeek Harness）が動く状態まで連れていく担当です。
次の決まりを守ってください。

- **一度に 1 ステップだけ**進める。終わったら「いま何ができたか」を 1 行で伝えてから次へ進む。
- **失敗したら止めて報告する**。同じコマンドを 2 回以上繰り返さない。原因を 1 行で書き、次に試すことを 1 つだけ出す。
- **確認したことだけ報告する**。実行していないコマンドを「成功しました」と書かない。
- **秘密を表示しない**。API キーは標準入力から渡し、表示も履歴も残さない。
- **破壊的な操作をしない**。既存の設定を消さない。`--replace` は本人が明示的に頼んだときだけ使う。
- 分からないことを推測で埋めない。分からなければ利用者に 1 つだけ質問する。

進める順番は次のとおりです。

1. 前提（OS・シェル）を確かめる
2. rdsh を入れる
3. 動作を確かめる
4. **モデルの接続先を 1 つだけ選んでつなぐ**（ここが山場）
5. 推奨プラグインを入れる
6. 会話を始める
7. （任意）自動更新と専用アプリ

---

## 1. 前提を確かめる

### Linux / macOS / WSL

```sh
uname -s
command -v curl
```

### Windows（PowerShell）

```powershell
$PSVersionTable.PSVersion
```

- `curl` が無い Linux では `sudo apt install curl`（Debian/Ubuntu）か `sudo dnf install curl`（Fedora）。
- Windows は PowerShell 5.1 以上なら動きます。

---

## 2. rdsh を入れる

### Linux / macOS / WSL

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

### Windows（PowerShell）

```powershell
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

インストーラは次の 3 つを一度にやります。

- `rdsh` 本体を `~/.local/bin`（Windows は `%LOCALAPPDATA%\rdsh\bin`）へ入れる
- 無ければ DSH 本体（Node.js 版）を入れる
- プロファイルに同梱プラグイン（設定画面・スマホ幅レイアウト・更新バナー・フィードバック無効化・視覚回答）を付ける

途中で質問が出たら、**全部 Enter（既定のまま）**で構いません。

---

## 3. 動作を確かめる

```sh
rdsh --version
rdsh doctor
```

- `rdsh --version` が版を返せば導入は成功です。
- `rdsh doctor` は足りないものを並べます。直すべきものは次のとおりです。

| doctor の行 | 意味 | 対応 |
| --- | --- | --- |
| `essential plugin(s)` | 同梱プラグインが足りない | `rdsh plugins install` |
| `dsh` が見つからない | DSH 本体が無い | インストーラをやり直す |
| `optional tools present` | 任意ツールの情報 | 何もしなくてよい |

---

## 4. モデルの接続先をつなぐ（1 つだけでよい）

DSH は「どのモデルを使うか」が決まらないと会話が始まりません。
下の **A〜D のどれか 1 つ**を選びます。最初は 1 つで十分です。

| 選ぶもの | 向いている人 | 用意するもの |
| --- | --- | --- |
| A. OpenAI のクレジット | ChatGPT の API を使っている | `sk-` で始まる API キー |
| B. OpenCode Go | OpenCode の定額プランがある | `OPENCODE_GO_API_KEY` |
| C. Command Code Goat | Command Code の契約がある | `COMMANDCODE_API_KEY` |
| D. Ollama | 手元の GPU で動かしたい | Ollama を起動しておく |

### どちらで使うかは、あとで選べます

`rdsh doctor` の最後に **Web UI かターミナルか**を聞かれます（6 参照）。
迷ったらブラウザの画面を選んでください。`rdsh setup --web` の画面と同じ感覚で使えます。

### 先にブラウザの設定画面を使う（おすすめ・わからなくなったらこれ）

コマンドを打つのが不安なときは、画面で設定できます。**ブラウザが自動で開きます。**

```sh
rdsh setup --web
```

- 開いたページに、キーを 1 つだけ貼ります。それで終わります。
- ブラウザが自動で開かなかったときだけ、表示された URL を開き、
  表示された「トークン引き渡しファイル」の中身をページに貼ってください。
- 画面のない機械（サーバー・CI）では URL の表示だけになります。

次に進む前に、`rdsh provider list` で 1 つでも「設定済み」になっていれば成功です。

### 共通：まず今の状態を見る

```sh
rdsh auth                    # 他ツールのログインが見えているか（値は表示されません）
rdsh provider list           # どの経路が設定済みか
```

すでに使える経路があれば、この節は飛ばして 5 へ進んでよいです。
たとえば Codex CLI にログイン済みなら、その OAuth をそのまま取り込めます。

```sh
rdsh auth --import --provider openai-codex
```

### A. OpenAI のクレジット（API キー）

キーは**画面に貼らず、標準入力から渡します**。

```sh
read -rsp "OpenAI API key: " OPENAI_KEY && echo
printf '%s\n' "$OPENAI_KEY" | rdsh provider add local-openai --base-url https://api.openai.com/v1 --id openai --name OpenAI --discover --key-stdin
unset OPENAI_KEY
```

`--discover` は `GET /v1/models` を読んで、使えるモデルを自動で並べます。
キーは `$DSH_HOME/.credentials.yaml` に**参照として**保存され、値は表示されません。

### B. OpenCode Go

```sh
read -rsp "OpenCode Go API key: " OC_KEY && echo
printf '%s\n' "$OC_KEY" | rdsh provider add local-openai --base-url https://opencode.ai/inference/go/v1 --id opencode-go --name "OpenCode Go" --discover --key-stdin
unset OC_KEY
```

### C. Command Code Goat

```sh
read -rsp "Command Code API key: " CC_KEY && echo
printf '%s\n' "$CC_KEY" | rdsh provider add commandcode --discover --key-stdin
unset CC_KEY
```

環境変数 `COMMANDCODE_API_KEY` に入れてあるなら、`--key-stdin` を外してそのまま実行しても構いません。

### D. Ollama（手元）

```sh
ollama serve &        # まだ起動していないときだけ
rdsh provider add ollama --discover
```

Ollama Cloud を使うなら、こちらを代わりに。

```sh
read -rsp "Ollama API key: " OL_KEY && echo
printf '%s\n' "$OL_KEY" | rdsh provider add ollama-cloud --discover --key-stdin
unset OL_KEY
```

### つながったか確かめる

```sh
rdsh provider list
rdsh models --provider openai          # A の場合（B〜D は経路名を変える）
```

モデルが 1 つ以上出ていれば成功です。0 件ならキーか URL が違います。
**そこで止めて利用者に聞いてください。**

### Ollama を使う場合だけ：推論の強さを補う

```sh
rdsh models efforts --dry-run     # 何が足りないか見るだけ
rdsh models efforts               # 足りないものだけ補う
```

---

## 5. 推奨プラグインを入れる

```sh
rdsh plugins status               # 何が足りないか（読み取りだけ）
rdsh plugins install --recommended=starter
```

`starter` は「何も設定しなくても期待どおり動く」最小の組です。
もっと欲しい人は `--recommended=all` にします。入るものは次のとおりです。

| プラグイン | 何をするか |
| --- | --- |
| rdsh-translation | 日本語訳の設定とプレビュー |
| rdsh-subagent-optimizer | 探索用サブエージェントを上限つきで走らせる |
| dsh-intelligent-ui | グラフ・表・入力欄などの視覚回答 |
| dsh-sound-notifications | 効果音とデスクトップ通知 |
| dsh-gitview | Web のサイドバーに Git パネル |
| rdsh-compute | 常駐の計算ブリッジ（`all` のみ） |
| rdsh-easy-work | ファイル整理の案内（`all` のみ） |
| rdsh-ui-comfort | Web チャットで Enter を「送信」に固定（`all` のみ） |
| rdsh-subagent-route | 子エージェントの provider・model・effort を選ぶ（`all` のみ） |

**同梱プラグインは既定で入っていて、フィードバック機能はオフです。**
戻したい場合だけ `rdsh features on feedback` を実行します（入っている無効化プラグインも外れます）。

---

## 6. 会話を始める（どちらで使うか選ぶ）

まず診断を流します。対話端末では、最後に **Web UI かターミナルか**を聞かれます。

```sh
rdsh doctor
```

```text
[rdsh] 次の一手
[rdsh]   同梱プラグインを補う: rdsh plugins install
[rdsh] どこで使いますか？
[rdsh]   1) Web UI（ブラウザ。自動で開きます）
[rdsh]   2) ターミナル（この画面のまま）
[rdsh] 選択 [1] 
```

- **1** … ブラウザで開きます（`http://127.0.0.1:3080`）
- **2** … この端末のまま TUI が始まります
- **そのまま Enter** … 画面のある機械なら Web UI、サーバーならターミナル

コマンドを直接叩いても同じです。

```sh
rdsh --profile web        # ブラウザ（http://127.0.0.1:3080）
rdsh tui                  # ターミナル
```

初回はモデルが選ばれていないことがあります。その場合は画面のモデル選択で、
4 でつないだ経路のモデルを選んでください。

---

## 7. 任意：自動更新と専用アプリ

```sh
rdsh update auto status   # 自動更新が入っているか
rdsh desktop status       # 専用アプリ（Electron）が入っているか
```

自動更新を有効にしたい場合だけ。

```sh
rdsh update auto on
```

止めたいときは `rdsh update auto off`。

---

## 詰まったときの早見表

| 症状 | まず見る | よくある原因 |
| --- | --- | --- |
| `rdsh: command not found` | `~/.local/bin` が PATH にあるか | シェルを開き直す |
| `dsh` が見つからない | `rdsh doctor` | インストーラの再実行 |
| モデルが 0 件 | `rdsh provider list` | キーの誤り、`--base-url` の誤り |
| 401 / 403 が出る | キーの有効期限 | 発行元で再発行 |
| 会話が始まらない | モデル選択 | モデル未選択 |
| 挙動がおかしい | `rdsh --version` | 古い版。インストーラをやり直す |

原因が分からないときは、次を実行して結果をそのまま貼ってください。

```sh
rdsh --version
rdsh doctor
rdsh provider list
```

**この 3 つの出力に秘密は含まれません。** API キーの値は出ません。
