# rdsh 紹介動画

最新版は30秒の4K紹介動画です。3840×2160 / 60fps / H.264 + AAC。
起動性能・検索・トークン見積もり・タスク確認・回答保存を、操作と結果の順に紹介します。
主コピーとコマンドを大きくし、必要なUIだけに寄せて、待ち時間と重複説明を削りました。
前版の承認済みBGMは曲・テンポ・前半の音量を維持し、新しい終わりのフェードと操作音だけ調整しています。
UIは空のHOMEと新しいブラウザーでDPR 6に撮り直し、4Kでも元画像の画素を超えて拡大していません。

出力: `out/rdsh-intro-sharp-4k-ja.mp4`
構成と修正の意図: `DESIGN-sharp.md`

前の44秒版は`src/original.tsx`と`out/rdsh-intro-original-ja.mp4`に、
白×青の版は`src/stylish.tsx`と`out/rdsh-intro-stylish-ja.mp4`に残しています。

## 再編集・書き出し

```sh
cd media/rdsh-intro
npm ci --ignore-scripts
npm run studio
npm run render -- --browser-executable=/usr/bin/google-chrome
```

素材は同梱済みです。画面を撮り直す場合は、リポジトリの
`dashboard`と`tests/e2e`の依存関係、および`target/debug/rdsh`が必要です。
撮影スクリプトはLinuxのChromeとシステムフォントを使います。

```sh
npm run capture:sharp
npm run audio
npm run typecheck
npm run verify
```

## 構成

| 秒 | 内容 |
| --- | --- |
| 0–2.4 | コマンドの結果をブラウザで見る |
| 2.4–6 | 起動性能の比較（約0.90ms・約98倍） |
| 6–9.6 | TODO全件検索の入力と見つかった場所 |
| 9.6–12 | トークン数の確認（README.mdは10） |
| 12–16.2 | タスク一覧と料金・節約率の確認 |
| 16.2–21.6 | AIの質問に答えて回答済み表示へ |
| 21.6–24 | スマホでも同じ画面を見る |
| 24–30 | 互換の案内とsetup --web・音楽クレジット |

## 個人情報の扱い

- デスクトップや既存のブラウザーは録画していません。
- 一時ディレクトリの空のHOME、DSH_HOME、XDG、Dashboard状態を使います。
- ブラウザーは新規の隔離コンテキストで起動します。
- タスク、質問、回答、費用、トークン数はすべて架空です。
- APIキーや実際のアカウントを設定せず、モデル呼び出しも行いません。
- Tailscaleは無効です。スマホ場面はレスポンシブ表示のデモです。
- 設定UIはカードだけを切り出し、背景のプロジェクト名を除外します。
- 切り出したコンテンツに重なる固定ナビゲーションを撮影時だけ隠します。
- ブラウザーのアドレスバー、アクセスキー、接続QRは映しません。
- 表示テキストを点検した記録は`public/sharp/capture-audit.json`です。

CLI出力は架空のREADMEを使った実行結果です。性能の数字は
`README.ja.md`のLinux x86_64・`--version`起動中央値（n=5）と最大RSSを参照します。
Desktop全体やモデル応答の性能を示す数字ではありません。
保存を示す場面は実際のブラウザー送信とローカルの保存確認に基づきます。
動画のマウスポインターとクリック表示はRemotionで追加しています。

## 素材

- ロゴ: リポジトリの`assets/icon.png`
- UI: リポジトリのsetup / project dashboard
- BGM: “Chill Wave” / Kevin MacLeod / incompetech.com / CC BY 4.0
  - 公式音源の24秒から24秒を抜粋、音量調整、フェードと操作音を追加
  - 出典: <https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600048>
  - ライセンス: <https://creativecommons.org/licenses/by/4.0/>
  - 元の音源と出典記録: `public/chill-wave-source.mp3`, `public/music-license.json`
  - `scripts/sharp-audio.py`で編集と操作音の合成を再現
  - クレジットは動画内にも表示。投稿用文面は`MUSIC-CREDITS.md`。
- 前版BGM: `scripts/stylish-soundtrack.py`による合成音源
- 最新版のフォント: Instrument Sans / Noto Sans JP / DejaVu Sans Mono、同梱のライセンスを参照
- 旧版のフォント: IPA Pゴシック / DejaVu Sans、同梱のライセンスを参照
- 前版の立体リボン: Three.jsのメッシュと手続き生成の反射テクスチャ
- Remotion: <https://www.remotion.dev/>

## 確認

`npm run typecheck`、隔離環境の設定保存・回答保存、画面素材の表示テキスト、
代表フレームの目視、MP4の映像・音声ストリームと全編のデコードを確認します。
検証結果は`out/sharp-verification.json`に保存します。

最新版の外付け字幕: `public/captions-sharp.ja.srt`
44秒版の再出力: `npm run render:original`
白×青の版の再出力: `npm run render:stylish`
旧版の再出力: `npm run render:classic`
