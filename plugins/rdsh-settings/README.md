# rdsh-settings (test prototype)

DSH設定サイドバーに rdsh セクションを追加するテスト用プラグインです。
デザインはDSHそのまま (settings.section スロットを使い、DSH変数で描画)。

## 入る場所

- 設定モーダルの縦ナビに rdsh が増えます
- 順序は Models(10) / Built-in plugins(15) の次: order 20
- クリックでトークン予算・retriever/packer/verifier・goal・作業ファイル・未解決タスクを調整できます

## 保存先

- DSH_HOME/rdsh.json（単一設定源。context・beta・全体設定すべて）
- 旧 DSH_HOME/rdsh-context.json は読み替え専用。rdsh.json に context が
  ある場合は無視されるので、移行後は削除してかまいません。
- Rust側 `rdsh context build/search/status/explain` と同じファイルを読み書きします

## 試す

APIにはDSHのGUIセッション認証とHost/Origin検証を適用します。
`connection.requestRejection` を提供するDSHが必要です（0.2.0-rc.2で検証済み）。
認証機能を利用できない場合、APIは操作を拒否します。
設定画面が扱わない既存キー（`extras.enable`など）は、保存時にも保持します。
Working Filesの空リストは明示的な指定として扱い、旧形式のファイル一覧には戻りません。
この読込動作を反映するには、Rustランチャーも更新してください。

```sh
dsh plugin --profile web add ./plugins/rdsh-settings
```

外すときはプロファイルのプラグイン一覧から rdsh-settings を外します。
テスト実装なので context engine は既定OFF（beta.context_engine=false）。
使うときだけONにします。
