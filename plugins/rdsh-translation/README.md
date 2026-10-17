# 回答の日本語訳を表示し、履歴に反映する

Issue #448（Step 1 + Step 2）。規模: 中（既存のDSHコマンドとWeb UIスロットをつなぐプラグイン）。
DSHが所有する会話・モデル実行のホストアダプターとして実装し、独自のエージェントループは追加しません。

完了した英語・中国語の回答のアクション行には、2つの明示的な操作があります。

1. 「日本語訳を表示」（Step 1）: 現在の会話で直近に使ったprovider/modelへ独立した翻訳リクエストを1回送り、
   訳文ダイアログを開きます。原文、会話のsurface、次のモデル入力は変更しません。
2. 「日本語訳で置き換える」（Step 2）: 同じ翻訳リクエストを1回送り、対象回答のsurfaceノードを訳文で置き換えます。
   新しいターンや追加指示のuserメッセージは追加せず、次のリクエストの`deriveMessages()`は元の回答ではなく訳文を読み込みます。

自動翻訳は行いません。どちらもクリックしたときのみ動作します。
生成中の表示、二重クリックの防止、失敗時の再試行に対応しています。
日本語のみ、コードのみ、または中断された回答にはボタンを表示しません。
かな比率による判定を行うため、日本語の漢字のみの文章などを誤判定する場合があります。

置換はDSHの`surfaceOp: { op: 'replace', startSeq, endSeq }`（`/compact`と同じ経路）で行います。
元の回答は追記専用のsession logと人間向けのtranscriptに残り、置換ノードは`source.kind: 'rdsh-translation'`を持ちます。
DSHが置換をモデル可視のsurfaceだけに適用する設計のため、画面上の回答表示そのものは差し替わりません
（訳文はダイアログで確認できます）。画面表示の差し替えには、DSH側に置換を反映する表示APIが必要です。
ターン外のコマンドから追加できる置換は、開いているstepを要求しない`user/message`のみであるため、
モデルからは訳文がuserロールとして見えます（`assistant/message`での置換には開いているstepが必要です）。

DSHの通常の`command/run`・`command/done`ログには、操作と結果が記録されます。
置換後は`request/header`が再発行され、置換ノード以降のプロバイダーキャッシュの再利用が一度無効になります。
置換済みの回答や、`/compact`で隠れた回答への再置換に対しては、暗黙的に無視することなくエラーを表示します。
訳文表示と「置換済み」の表示はコンポーネントの一時的な状態であり、画面を再読み込みすると消えます（履歴の置換は残ります）。
自動翻訳、モデルの切り替え、翻訳結果の個別保存、置換ノードへのLike/Dislikeは対象外です。

## 導入と操作

リポジトリの`plugins/install.sh`では、`PROFILE=web`または`PROFILE=desktop`を指定して導入します。
除外する場合は`TRANSLATION=0`を指定します。headless/TUIでは既定で導入されません。
個別に導入する場合は、Webプロファイルでは`dsh plugin --profile web add /絶対パス/plugins/rdsh-translation`、
Desktopでは`rdsh desktop install --package /絶対パス/plugins/rdsh-translation`を使用します。
導入後に対象のWeb UIを開き直してください。

`$DSH_HOME/rdsh.json`の`translation.kana_threshold`で表示のしきい値を設定できます。
既定値は0.08、許容範囲は0.01〜0.5です。変更後は画面を再読み込みしてください。
翻訳の呼び出しには、現在のモデルの通常の利用料金および利用枠がかかります。

表示文言、コマンドの説明、エラーメッセージは表示言語に追従します。Web UIはDSHのlocaleカタログ
（`rdsh-translation`名前空間のen/zh/ja辞書）を使用します。日本語の言語定義はrdsh-settingsが
所有するため、このプラグインからは言語を追加しません。ホスト側の文言は`RDSH_LANG`、
`rdsh.json`の`general.language`、OSロケールの順で解決されます。プラグイン一覧の
タイトル・説明には`locale/en.json`、`locale/ja.json`、`locale/zh.json`を使用します。

コードブロック、インラインコード、識別子・パスなどは保護トークンで保持します。
トークンの欠落や重複、空応答、途中終了、64KiBを超える入力/出力はエラーとして表示します。
60秒のタイムアウトとDSHの保守処理による排他制御を利用し、生成中の会話は変更しません。

## 検証

`node --test tests/translation-preview.test.mjs`の実行により、表示ボタンからダイアログまでの動作、原文とsessionの不変性、
二重起動の防止、失敗・取り消し・上限の処理、導入リストの確認に加え、置換ボタンが`user/message`＋`surfaceOp: replace`を
対象seqへ1件だけ追記すること、`source.kind`と`sourceEventSeqs`の形式、表示操作が履歴を変更しないこと、
busy・対象なし・保護トークン欠落・session拒否時に追記しないこと、置換済みに対する専用エラーの発生を確認します。
同じテストはCIの既存プラグイン検証エントリーからも読み込まれます。
実providerを使った翻訳の品質や実DSH全体での受け入れは、合成境界での成功とは区別します。

隔離したDSHを用意した場合は、次のコマンドで実際のAgentLoop、LLM、CommandRuntime、実sessionと、
`dsh-session`/`dsh-compaction`の実invariant companionとの境界を確認できます。
providerのみが固定応答を返し、モデルAPIは呼び出しません。invariantの負の対照（開いていないturnの`turn/end`）が
`InvariantError`で拒否されることを確かめてから、置換が通ることを検証します。

```sh
RDSH_NATIVE_MODULES=/path/to/dsh/node_modules npm run test:translation --prefix tests/e2e
```

画面確認とは別の試験です。実行方法は[受入試験](../../tests/e2e/README.md)を参照してください。

実Webプロファイルでの操作前後のPNG・操作GIFと検証範囲については、
[画面の受入記録](../../docs/evidence/issue448-translation-preview/README.md)を参照してください。
