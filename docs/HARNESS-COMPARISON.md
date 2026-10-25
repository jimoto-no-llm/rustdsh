# ハーネスの実測比較

rdsh（DSH）と他のハーネスを、同じモデル・同じプロンプト・同じ課題で比べた記録です。
あわせて、ランチャーとしての起動時間とディスク占有も同じマシンで測りました。

比較の軸は合否と時間だけです。出力の読みやすさや設計の好みは測っていません。

## 計測環境

| 項目 | 値 |
| --- | --- |
| ホスト | Fedora Linux 44 / x86_64 |
| 計測日 | 2026-10-25 |
| Node.js | v24.22.1 |
| モデル | deepseek-v4.1-flash（opencode-go 経由） |
| 課題数 | 7 |
| 試行回数 | 各ハーネス 1 回 |

## 課題の合否

同じモデルを全ハーネスに使わせ、同じ 7 問を解かせました。

| ハーネス | 正解 | 中央値 | 合計 |
| --- | ---: | ---: | ---: |
| dsh（そのまま） | 7 / 7 | 24.6 秒 | 229.6 秒 |
| dsh（rdsh 経由） | 7 / 7 | 29.6 秒 | 255.9 秒 |
| Codex CLI 0.161.0 | 7 / 7 | 28.0 秒 | 200.6 秒 |
| Gemini CLI 0.63.0 | 6 / 7 | 18.2 秒 | 411.3 秒 |
| Claude Code 2.1.296 | 6 / 7 | 36.5 秒 | 514.1 秒 |
| opencode 1.19.4 | 6 / 7 | 45.4 秒 | 345.0 秒 |

7 問すべて正解したのは dsh と rdsh 経由の dsh、Codex CLI の 3 つでした。残りは 1 問ずつ落としています。
rdsh を挟むと中央値は 24.6 秒から 29.6 秒に伸び、正解数は変わりませんでした。
Claude Code と Gemini CLI は失敗した 1 問で 300 秒の打ち切りに達しました。

### 課題と採点

各課題は未実装の `solution.py` とテストの組です。エージェントには同じ文面の
プロンプトを渡し、テストが通るように `solution.py` だけを編集させます。
採点はテストの合否で、エージェントの自己申告は使いません。

| 課題 | 内容 |
| --- | --- |
| parse-duration | "1h30m" のような文字列を秒に変換する |
| merge-intervals | 重なる区間をまとめる |
| top-k-words | 出現回数の多い語を取り出す |
| fix-binary-search | 二分探索の不具合を直す |
| dedupe-rows | 先頭列が重複する行を落とす |
| lru-cache | LRU キャッシュを実装する |
| token-bucket | トークンバケットを実装する |

制限時間は 1 課題あたり 300 秒です。時間切れは不正解として数えています。

### ハーネスごとの接続方法

全ハーネスに同じモデルを使わせるため、接続方法はハーネスごとに変えています。

- dsh は `--patch` でプロバイダとモデルを差し替えます（`dsh-patch.yml`）。
- rdsh は同じ引数をそのまま dsh へ渡します。rdsh 自身の環境変数（スリム起動）が加わります。
- Codex CLI は一時 `CODEX_HOME` の `config.toml` に `model_providers.opencode-go` を書きます。
- opencode は一時 `OPENCODE_CONFIG` に OpenAI 互換のプロバイダを書きます。
- Claude Code と Gemini CLI は自社 API しか話さないため、`proxy.py` で変換します。

`proxy.py` は Anthropic Messages と Gemini generateContent を OpenAI chat へ変換します。
ストリーミングと tool call の双方向変換を含みます。

上流のエンドポイントは `x-opencode-session` ヘッダを要求し、urllib の HTTP/1.1 を
403 で拒否します。そのため proxy はセッション ID を付けて curl 経由で呼び出しています。

## 起動とサイズ

| ハーネス | CLI 起動 | ピーク RSS | インストール | 実体 |
| --- | ---: | ---: | ---: | --- |
| rdsh 0.12.0 | 1.52 ms | 5.3 MB | 8.9 MB | 単体バイナリ（Rust） |
| Claude Code 2.1.296 | 8.61 ms | 38.1 MB | 246 MB | 単体バイナリ（同梱） |
| Codex CLI 0.161.0 | 34.76 ms | 49.7 MB | 430 MB | Node |
| dsh 0.2.1-rc.3 | 66.1 ms | 66.7 MB | 864 MB | Node |
| opencode 1.19.4 | 369 ms | 128.3 MB | 205 MB | Node |
| Gemini CLI 0.63.0 | 1316 ms | 210.2 MB | 101 MB | Node |

起動は `--version` を 10 回実行した中央値です。RSS は 1 回実行のピーク、
サイズは解決後の実体を `du -sh` で測りました。

opencode はグローバル環境を汚さないよう、一時ディレクトリへ導入して測っています。

## この数字が意味すること、しないこと

### 意味すること

- CLI が最初の応答を返すまでの時間。シェル補完やスクリプトから何度も呼ぶ場面で効きます。
- ディスク占有。CI イメージやコンテナに焼くときの差になります。

### 意味しないこと

- 会話中のメモリと速度。rdsh は起動後に dsh（Node.js）へ委譲するので、
  セッションを開けば dsh と同じだけメモリを使います。rdsh の 5.3 MB はランチャープロセスの値です。
- 出力の品質。モデルとプロンプト次第で、ハーネスの差ではありません。
- Windows での所要時間。ここは Linux のみの計測です。
- 統計的な主張。7 問 1 回の結果では、差があるとも無いとも言えません。

## 再計測

```sh
export OPENCODE_GO_API_KEY=...
python3 bench/harness-compare/run.py --harness dsh --harness codex --out results.json
```

`--task <名前>` で 1 課題だけを、`--timeout` で制限時間を変えられます。
採点は `grade.py` が行います。pytest は環境によって入っていないため、依存なしの
テスト実行器を同梱しています。

ランチャーの数字は次の手順で測れます。

```sh
for c in rdsh dsh claude codex gemini; do
  /usr/bin/time -f "%e s / %M KB  $c" "$c" --version > /dev/null
done
```

## アイコンの出典とライセンス

グラフの点は各ハーネスのロゴです。dsh は DeepSeek、rdsh 経由は rdsh のアイコンです。
それ以外は Simple Icons（CC0 1.0）から取得しました。

ロゴ自体は各社の商標です。ここでは比較対象を識別するためだけに使い、
提携や推奨を示すものではありません。
