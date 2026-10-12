# バズ用デモ構成 (15秒)

`rdsh` を一言で見せるための最短台本です。合成データのみ使います。

## 15秒台本

1. 0-4秒: `rdsh bench` を実行。`0.9ms vs 73ms` を画面いっぱいに見せる
2. 4-9秒: `rdsh tokens sample.txt` で即時応答を見せる
3. 9-13秒: `rdsh search TODO --dir .` で並列検索を見せる
4. 13-15秒: `curl install.sh | bash` の1行導入で締める

再現は `./scripts/demo-buzz.sh --bin target/release/rdsh` でできます。

## 投稿テンプレ

- X: `dshが重いのでRust化したら73ms→0.9msになった。互換そのまま、tokens/searchもNodeなしで動く。rdsh` + 動画15秒
- Zenn: `dshをRustランチャーで速くした話`
- HN: `rdsh: fast Rust launcher for dsh (0.9ms startup, drop-in compatible)`

## 注意

- 数値は手元の `bench` 結果をそのまま載せる。盛らない
- 会話・モデル応答は本家DSHのまま、と明記する
- 詳細は [README.ja.md](../README.ja.md) と [USER-FLOW.md](USER-FLOW.md) へ誘導する
