# Claude Code／CodexからDSHへ移行する

[English](CODING-AGENTS.md) · [rdshのインストール](../README.ja.md#インストール)

rdshを導入し、いつものプロジェクトでDSHの新しい会話を始める手順です。
プロジェクトの指示ファイルはそのまま使い、モデル接続だけを選んで設定します。

## 最初に確認すること

| 引き継ぐもの | 移行先での扱い |
| --- | --- |
| プロジェクトの`AGENTS.md`／`CLAUDE.md` | 標準のDSHプロファイルが自動で読みます。名前の変更・変換は不要です。 |
| CodexのChatGPTログイン（OAuth） | `rdsh auth --import --provider openai-codex --source codex`で明示的に取り込めます。 |
| Claude Codeのログイン・契約 | 直接取り込む機能はありません。Anthropic等のAPIキー、または対応する別のモデル接続を選びます。 |
| 元の会話履歴・resume | そのクライアントに残ります。DSHでは新しい会話を開始します。 |
| MCP・hooks・skills・承認設定 | 自動変換しません。DSHで必要なものを個別に設定します。 |
| コードの編集・テスト実行 | 現行のrdsh経由のモデルツールは共有ファイルの読み取り専用です。書き込み・ネットワーク・ホストのテスト実行は許可しません。 |

現行版は会話・共有コードの分析から移行を始める構成です。
Claude Code／Codexの編集や実行までをすべて置き換えることはできません。
既存のクライアントと設定を残して、小さなプロジェクトで確認してください。

会話には**Linux x86_64（WindowsはWSL）・本家DSH・Node.js・bubblewrap・prlimit**が必要です。
macOS／WindowsネイティブではローカルCLIは使えますが、保護されたagent起動は未対応です。

## 1. rdshと本家DSHを用意する

[インストール手順](../README.ja.md#インストール)でrdshを導入します。
Windowsで会話する場合はWSLの端末でUnixの手順を使ってください。
本家DSHが未導入なら、監査済みの版を入れます。Node.jsの実機検証は24です。

```sh
npm install --global @deepseek-ai/dsh@0.2.0-rc.2
rdsh --version
rdsh doctor
```

`doctor`で本家DSHの場所と版を確認します。監査済みは`0.2.0-rc.2`と`0.2.1-alpha.1`です。
Ubuntu／WSLのUbuntuで隔離用コマンドが未導入なら、次を実行します。

```sh
sudo apt-get install bubblewrap util-linux
```

本家DSHは[開発者プレビュー](https://github.com/deepseek-ai/deepseek-harness)です。
版を無条件に最新へ上げるとrdshの実行保護に対応しない場合があります。
起動を拒否された場合は、診断に従って対応する環境・版を揃えます。

## 2. モデル接続を選ぶ

移行元に合わせて、モデルの認証方法を選びます。

**Codexから移行し、既存のログインを使う場合：**

```sh
rdsh auth
rdsh auth --import --provider openai-codex --source codex
```

未ログインの場合だけ、先に`codex login`します。取り込みはDSH側へのコピーで、
元のCodex設定を変更しません。`setup --login`でログインを開いた場合も、取り込みは別の操作です。
保存状態は`rdsh auth`、または`rdsh setup --web`の「接続状況を更新」で確認できます。
ログイン元は同じOSのユーザー環境です。WSLからWindows側のログインは自動探索しません。
見つからない場合はWSL内でCodexへログインするか、APIキーの接続を選んでください。

**Claude Codeから移行する場合、またはAPIキーを使う場合：**

DSHの「Settings → Models」で、接続先とAPIキーを一度に追加します。
次の節でDSHを起動してから、画面の手順に進んでください。
APIキーとサブスクリプションのログインは別です。Claude Codeの契約は自動で引き継ぎません。
Claude以外のモデルを使う場合は、対応するCodexログインやDeepSeekキーも選べます。

既に接続先を設定済みでキーだけ保存・更新したい場合は、`rdsh setup --web`でも
Anthropic・OpenAI・DeepSeekを選べます。キーの保存だけで使用モデルは変わりません。

## 3. いつものプロジェクトで会話を始める

プロジェクトへ移動します。次の例は`README.md`が存在する場合です。
別のファイルを読ませたい場合は、共有するファイル名を置き換えます。

```sh
cd /absolute/path/to/your/project
rdsh --share-file README.md --profile web
```

Webプロファイルは初回に自動初期化されます。開いたDSHで次を行います。

1. 初回のプレビュー案内を確認して「Continue」を押します。DeepSeekの接続を求められ、他の接続を使う場合は「Configure later」を選びます。
2. 「Settings → Models → Add model provider」で「Third-party model provider」を選びます。CodexのOAuthは`openai-codex`、Claudeは`anthropic`、OpenAIのAPIキーは`openai`です。
3. Codexの取り込み済みOAuthならAPIキー欄は空のまま「Apply」。Claude／OpenAIならこの欄にAPIキーを入力して「Apply」です。DeepSeekの場合は既存のDeepSeekカードでキーを設定します。
4. Settingsを閉じ、「Choose workspace」で**起動時と同じプロジェクトのフォルダー**を選びます。初期ワークスペースが別のフォルダーなら切り替えてください。
5. 「New Session」を押して会話を作り、入力欄のモデル選択から追加したプロバイダーのモデルを選びます。最初の依頼は次の内容にします。

```text
このプロジェクトに適用される指示ファイルの名前を確認し、共有したREADMEを要約してください。
変更はまだ行わないでください。
```

フォルダー選択がDSH内の画面で開く場合は「Edit path」でプロジェクトの絶対パスを
入力し、「Open」で決定できます。

モデルの返答とファイルの内容を確認できれば、最初の会話は完了です。
読むファイルを増やすときは`--share-file`を追加して起動し直します。
ディレクトリ全体は指定できません。既存のコードや履歴は書き換えません。

### 指示ファイルを引き継ぐ

監査済みDSHの標準プロファイルは`AGENTS.md`・`CLAUDE.md`、各`.local.md`を読みます。
同じ場所で内容が同じファイルは重複しません。既存ファイルをコピー・改名する必要はありません。
カスタムプロファイルでは読み込みを無効化できるため、設定を確認してください。

全体に適用する指示はDSHでは`$DSH_HOME/AGENTS.md`（通常`~/.dsh/AGENTS.md`）です。
`~/.codex/AGENTS.md`・`~/.claude/CLAUDE.md`の必要な文章だけ確認して追加し、
DSH側に既存の指示がある場合は内容を統合してください。全体の上書きは不要です。
Claude固有の`@`参照・hooks・MCP名やCodex固有の設定は、そのまま動くとは限りません。

## 操作の対応表

| いつもの操作 | DSH／rdshでの入口 |
| --- | --- |
| `claude`／`codex`で対話を始める | プロジェクト内で`rdsh --profile web` |
| 端末だけで会話する | `rdsh tui`（`tui`プロファイル導入済みの場合） |
| 一回の依頼を実行する | `rdsh --share-file README.md --profile headless "READMEを要約してください"` |
| モデルを選ぶ | DSHのモデル選択画面。Claude／Codex固有のCLIフラグは移植しません。 |
| ログイン・接続状態を見る | `rdsh auth`、`rdsh doctor`、`rdsh setup --web` |
| セッションを探す | `rdsh sessions`（DSHの履歴。移行元の履歴は含みません） |
| 進捗や質問の画面を追加する | 任意の[プロジェクトDashboard](../dashboard/README.md) |

## 困ったとき・元の環境に戻る

- **本家DSHが見つからない：** 本家の導入後、`rdsh doctor`で探索結果を確認します。
- **接続できない：** 認証を用意したプロバイダーと選択モデルが一致するか確認し、期限切れならログイン更新後に明示的に取り込みます。
- **ファイルが見えない：** 起動したプロジェクトと`--share-file`を確認します。共有は読み取り専用です。
- **元の作業を再開する：** DSHを終了し、同じプロジェクトで`claude`／`codex`を開きます。元の履歴と設定はそのまま残っています。

詳しい[設定・復旧手順](USER-FLOW.md)と[設定画面](RDSH-SETTINGS.md)も確認できます。
