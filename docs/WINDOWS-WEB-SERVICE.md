# WindowsでWebを常駐させる

`scripts/windows-web-supervisor.ps1`は、Windowsログイン後にDSH Webを常駐させるための
PowerShell 7用の起動補助です。起動した子プロセスが異常終了すると、既定では
5秒、10秒、20秒の待機を挟み、10分間に最大3回再起動します。長く動いた後の障害では
古い再試行回数が期限切れになります。正常終了とCtrl+Cは再起動しません。

## 設定

絶対パスと引数の配列を使って、任意のローカルファイルに設定を保存します。
作業ディレクトリには実際の作業フォルダーを指定してください。

```json
{
  "executable": "C:\\Users\\you\\AppData\\Local\\rdsh\\bin\\rdsh.exe",
  "arguments": ["--profile", "web", "--host", "127.0.0.1", "--port", "3080", "--no-open"],
  "workingDirectory": "C:\\work"
}
```

```powershell
pwsh -NoProfile -File .\scripts\windows-web-supervisor.ps1 -ConfigPath C:\work\web-service.json
```

既存の認証ストアや環境変数を設定するPowerShellスクリプトを使っている場合は、
`executable`にPowerShell 7の絶対パスを指定し、`arguments`を
`["-NoProfile", "-NonInteractive", "-File", "C:\\work\\start-web.ps1"]`にします。
そのスクリプトはWebプロセスの終了を待ち、終了コードを返す必要があります。
APIキーや認証付きURLをこのJSONへ書かないでください。

自動起動には、既存のスタートアップショートカットの実行先をこのコマンドへ変更するか、
タスクスケジューラで現在のユーザーのログオン時に同じコマンドを起動します。
スクリプト自体はタスクやサービスを登録せず、管理者権限も要求しません。

## 動作と診断

- 同じユーザー・ログインセッション・ポートの監視をmutexで1つに制限します。
- 各起動前にループバックのポートを確認し、既存のサーバーがあれば起動せず終了します。
  これはHTTP認証や起動完了の検査ではありません。生きているプロセスのハングは再起動しません。
- `%LOCALAPPDATA%\rdsh\web-service\3080\lifecycle.jsonl`へ、起動PID、終了コード、
  経過秒数、再試行回数を記録します。引数・環境・標準出力・標準エラーは保存しません。
  両出力は並行して読み捨て、大量出力でもメモリへ蓄積しません。
- 再起動するのはWebホストです。プロンプトや失敗したツール操作を再送しません。
  処理中だった作業の結果は、再接続後に確認してください。

`0xC0000409`などの異常終了コードだけで、メモリ不足・GPU・Node.jsなどの原因を
断定することはできません。Windowsのイベント記録と同時刻を照合してください。
Nodeの致命エラーを調べる場合は、起動する子の環境に`--report-on-fatalerror`を設定でき、
対応するNodeでは`--report-exclude-env --report-exclude-network`も指定します。
診断レポートにはローカルパスやスタックが含まれ得るため、公開PRへそのまま添付しません。

監視を止めるには実行中のPowerShellでCtrl+Cを押します。自動起動を登録した場合は
その登録も無効化します。監視スクリプトは自分が起動したプロセスだけを停止します。
