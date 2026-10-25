# 他のハーネスとの比較（実測）

rdsh を Claude Code・Codex CLI・dsh・opencode・Gemini CLI と同じマシンで並べた記録です。
**比較しているのは CLI の起動・メモリ・ディスクだけ**です。会話中の速度や出力品質は
モデルとタスクで決まるため、ここでは比較しません。

## 計測環境

| 項目 | 値 |
| --- | --- |
| ホスト | Fedora Linux 44 / x86_64 |
| 計測日 | 2026-10-25 |
| Node.js | v24.22.1（Node 実装のハーネス用） |
| 計測方法 | 起動は `--version` を 10 回実行した中央値、RSS は `/usr/bin/time -f %M` の 1 回実行ピーク、サイズは解決後の実体（`du -sh`） |

## 実測値

| ハーネス | CLI 起動 | ピーク RSS | インストール | 実体 |
| --- | ---: | ---: | ---: | --- |
| rdsh 0.12.0 | 1.52 ms | 5.3 MB | 8.9 MB | 単体バイナリ（Rust） |
| Claude Code 2.1.296 | 8.61 ms | 38.1 MB | 246 MB | 単体バイナリ（同梱） |
| Codex CLI 0.161.0 | 34.76 ms | 49.7 MB | 430 MB | Node |
| dsh 0.2.1-rc.3 | 66.1 ms | 66.7 MB | 864 MB | Node |
| opencode 1.19.4 | 369 ms | 128.3 MB | 205 MB | Node |
| Gemini CLI 0.63.0 | 1316 ms | 210.2 MB | 101 MB | Node |

opencode は計測のために `npm install --prefix <一時ディレクトリ> opencode-ai` で
一時領域へ導入しました（グローバル環境は変更していません）。

## この数字が意味すること、しないこと

### 意味すること

- CLI が最初の応答を返すまでの時間。シェル補完・スクリプト・エージェントから
  呼ばれる回数が多いほど効きます。
- ディスク占有。CI イメージやコンテナに焼くときの差になります。

### 意味しないこと

- **会話中のメモリと速度**。rdsh は起動後に dsh（Node.js）へ委譲するので、
  セッションを開けば dsh と同じだけメモリを使います。rdsh の 5.3 MB は
  ランチャープロセスの値です。
- 出力の品質。モデルとプロンプト次第で、ハーネスの差ではありません。
- Windows での所要時間。ここは Linux のみの計測です。

## 再計測

```sh
for c in rdsh dsh claude codex gemini; do
  /usr/bin/time -f "%e s / %M KB  $c" "$c" --version > /dev/null
done
```

複数回の中央値を取る場合は `tests/harness-compare.py`（未同梱）ではなく、
上記を 10 回繰り返して `sort -n` してください。
