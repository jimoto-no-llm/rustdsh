# rdsh-subagent-route

新しく起動するサブエージェント（子エージェント）の **provider・model・reasoning effort** を
設定画面から選べるようにします。

## 何を変えるのか

DSH は委譲ツール（`@deepseek-ai/dsh-tool-subagent`）の `agentOptions` を読み、
そこに書かれた provider / model / reasoningEffort を子の既定値にします。書かれていなければ
子は親の設定を継承します。

このプラグインは、その `agentOptions` をプロファイルの `cordis.patch.yml` に書き込みます。

```yaml
- id: tool-subagent
  config:
    agentOptions:
      provider: "opencode-go"
      model: "deepseek-v4.1-flash"
      reasoningEffort: "high"
```

エージェントプリセットをカスタマイズしているプロファイルでは、この entry はプリセットの
`plugins` の中に入っています。その場合も同じ場所を書き換えます（トップレベルに足しても
実際に読み込まれる entry には届きません）。

## 画面

設定 → **サブエージェント** に provider / model / effort の 3 つと、**保存**・**継承に戻す** が
並びます。空欄は継承です。

## いつ反映されるか

保存した値は、**次に起動する子**から効きます。すでに動いている子は自分が開始したときの
設定を持ち続けます（DSH の子セッションは継続できるため、途中でルートを差し替える経路が
ありません）。

## インストール

```sh
dsh plugin --profile web add <checkout>/plugins/rdsh-subagent-route
# または
rdsh plugins install --profile web --recommended=subagent-route
```

ホスト側の変更は dsh の再起動後に読み込まれます。
