# コンテキスト保持とリポジトリ依存関係: 指摘への対応記録

対象は、レビューで共有された `rdsh_context_dependency_issues.md` の指摘
（2026年10月14日時点の `main` に対するレビュー）です。実装はこのリポジトリの
未リリース変更（`CHANGELOG.md` の Unreleased）に入り、検証は下表のテストで行っています。

## 結論

指摘のうち 1.1〜1.4、2.3、3.1〜3.2、および 4 の一部（再走査・完全性の可視化）に対応しました。
一方、2.1（意味検索）、2.2（走査上限と `.gitignore` 互換）、3.3（設計依存の競合検知）、
トークン数の厳密性は**未対応のまま**です。できていないことを「解決済み」と書かないため、
残る制限として末尾に明示します。

## 対応表

| 指摘 | 対応 | 実装 | 検証 |
| --- | --- | --- | --- |
| 1.1 会話ターンへ自動注入されない | `rdsh context inject` が DSH `UserPromptSubmit` フック契約で文脈を出す。`rdsh context hook install` が `hooks.json` に冪等に追記 | `src/context.rs`, `src/context_hook.rs` | `tests/context_hook_prototype.sh`, `tests/context_inject_contract.mjs` |
| 1.2 会話の進展で記憶が更新されない | 記憶ストア（schema 1）と `remember` / `distill` / `memory` / `forget`。撤回・重複は決定的規則で `superseded_by` を付けて履歴を残す | `src/context.rs` | `tests/context_hook_prototype.sh`, `cargo test` |
| 1.3 圧縮で中間の重要情報が消える | `rdsh compact` が落とした中間から制約・決定・エラー・差分・コマンド行を予算25%以内で残し、カテゴリ別 digest を付ける | `src/compact.rs` | `cargo test`（`compact::tests`） |
| 1.4 過去セッション参照が既定で0 | 注入は既定で直近2セッションを継承（`context.inject_sessions` / `inject_session_count`）。`build --sessions N` で1回だけ上書き | `src/context.rs` | `tests/context_hook_prototype.sh` |
| 2.3 収集断片が単一時点を保証しない | 開始/終了で git HEAD・branch・dirty と読み取りファイルの size+mtime を比較し `snapshot` を出す。`--require-stable` は変化時と git 状態が不明なときに exit 3 | `src/context.rs` | `cargo test`（snapshot テスト）, 手動CLI確認 |
| 2.3 / 3.1 抜粋に依存先が揃わない | 検索ヒットのファイルを依存グラフ近傍（被 import 元・import 先）で展開して `retrieved` に追加 | `src/context.rs` + `src/deps.rs` | `tests/deps_prototype.sh` |
| 3.1 依存関係が構造化されていない | `rdsh deps build\|query\|impact`。Rust / JS・TS / Python / Go の import・定義・静的呼び出しをファイル単位で保持 | `src/deps.rs` | `tests/deps_prototype.sh` |
| 3.2 変更影響範囲が特定できない | `rdsh deps impact <file\|symbol>` が直接・推移（既定3、上限8）の依存元、影響するテスト（テスト用パスと、`#[cfg(test)]` を持つ依存ファイル）、未解決エッジ数を出す | `src/deps.rs` | `tests/deps_prototype.sh` |
| 4 索引が無く毎回再走査する | `$DSH_HOME/rdsh-index/<root-key>.json` の増分索引。size+mtime が同じファイルは再解析しない。`--force` で全再構築 | `src/deps.rs` | `tests/deps_prototype.sh` |
| 3.4 Dependabot とコード解析の混同 | 用語を分離して本ドキュメントと README に明記（下記） | `docs` | - |

## 各項目の補足

### 1.1 自動注入

注入は「フックが stdout に返す JSON」だけを経路にします。DSH 側は
`hookSpecificOutput.additionalContext` を次のリクエストの文脈として扱うため、
rdsh 側の作業メモとモデルが見る文脈が同じ経路に乗ります。フックは **fail-open** です。

- どの失敗でもプロンプトは止めず exit 0 です。**何も出さない**のは設定ファイルが読めない場合と
  stdin を解釈できない場合だけ。索引が壊れている場合は「(dependencies: unknown; run rdsh deps build)」を
  付けて、期限超過の場合は検索節を落として、goal・constraints・記憶は出し続けます。
- 期限（`context.inject_deadline_ms`、既定1200ms）を過ぎたらコード検索と依存閉包を省略し、
  goal・constraints・記憶だけを出します。
- 予算は専用（`context.inject_budget`、既定1200トークン）で、通常のターン予算とは別です。
- 記憶ファイルが壊れている場合は「(memory unreadable: unknown; using settings)」を1節に入れて
  設定値だけで続行し、注入そのものは止めません。
- フック payload が 256KiB を超える場合は、本文を切り捨てたうえでプロンプト由来の検索クエリだけを
  使わずに注入します（goal・constraints・記憶は出ます）。

### 1.2 記憶

フック（`inject`）は**記憶を書き換えません**。会話から記憶を作るのは `distill` の明示実行だけです。
プロンプトを毎ターン自動で記憶へ追記すると、(a) 生の会話が上限まで溜まり、(b) 抽出した `[mem]` が
次の文脈に再注入されて自分のプロンプトを読み返す feedback loop になり、(c) 貼り付けた秘密情報が
そのまま永続化されうるためです。自動化したい場合は `Stop` フックなどから
`rdsh context distill --latest --apply` を明示的に呼ぶ運用にします。

記憶は会話ログの写しではなく、種類（goal / decision / constraint / task / file / note）を持つ
項目の集合です。`distill` は**ユーザー発話だけ**を読み、マーカーで決定・制約・撤回を抽出します。
新しい項目が既存項目と正規化トークンで60%以上重なる場合、または撤回マーカーを含む場合は、
古い項目を `superseded_by` で無効化します（削除はしません）。規則で解けない矛盾は両方を
active のまま残し、conflict として警告します。ファイルは 0600・原子的置換・`flock`（非ブロッキング）で
扱い、競合時は注入を優先して書き込みを諦めます。

### 1.3 圧縮

予算内ならバイト同一で素通しする契約は維持しています。超過時は、先頭（system）と新しい行を
優先しつつ、落とした中間から重要行（制約・決定・エラー・差分パス・コマンド）を予算の25%以内で
元の順序のまま残し、カテゴリ別件数を digest として出します。出力は常に予算以下です。

### 2.3 鮮度

`build` は開始時と終了時で git HEAD・branch・dirty パスと、実際に読んだファイルの
size+mtime を比較します。変化があれば `snapshot.stable=false` と変化ファイル一覧を出し、
`--require-stable` なら（変化が無くても git 状態を読めない場合は）exit 3、注入時は1行の警告を付けます。「収集途中で変わった断片を
単一時点の事実として渡さない」ための最小限の保証で、ファイル内容の意味的な整合は保証しません。

### 3.1 / 3.2 依存グラフ

抽出は静的近似です。動的 dispatch、間接呼び出し、マクロ生成、生成コードは `unknown` として
明示し、`unresolved` 件数で報告します。索引が無い場合は「情報が無い」であり「依存が無い」では
ありません（`related_files` は空を返し、注入は閉包なしで続行します）。

`impact` の `tests` は「依存元のうちテストを持つファイル」です。このリポジトリのように
各モジュールが `#[cfg(test)]` を持つ構成では、推移的な依存元が広いため一覧も広くなります。
「この変更で何を走らせるか」の絞り込みとしては、パスがテストを示すファイル（`tests/**` など）と、
単体テストを持つ依存元を合わせて読むのが実際的です。実測では 231 ファイル・512 エッジを
0.55 秒で構築し、2回目は 231 ファイルすべてを再利用（`parsed: 0`）しました。

### 3.4 Dependabot との違い

Dependabot が見るのは Cargo / npm / GitHub Actions の**パッケージ更新**であり、アプリケーション内部の
関数・モジュール間の依存や変更影響ではありません。`rdsh deps` は後者だけを扱い、両者を
同じ「依存関係管理」として扱いません。

## 残る制限（未解決）

1. **意味検索（2.1）は未実装**。検索は文字列スコアと依存グラフの構造であり、関数名の変更・
   別名の概念・間接呼び出しの意味的な等価性には追随しません。埋め込みや構文解析器は導入していません。
2. **検索・読み込み上限（2.2）はそのまま**。`context` の検索は走査ファイル数・読み取り量・
   行数・採用行数に上限を持ち、`working_files` は先頭と末尾の抜粋です。`.gitignore` の解釈も
   簡易実装のままです（`deps` は独自のスキップ規則を使います）。
3. **設計依存のワーカー競合検知（3.3）は未実装**。依存グラフは根拠を出しますが、別ファイルを
   編集している2人の衝突を自動判定する機能はありません。
4. **トークン数は近似**。既存の文字種ベースの見積もりで、モデル固有トークナイザーではありません。
5. **実 DSH での発火は未検証**。検証したのは (a) フック契約の JSON を DSH の
   `@deepseek-ai/dsh-hook-protocol` のコーデックでデコードできること、(b) `hooks.json` への
   冪等な追記です。実際にフックを起動するには `@deepseek-ai/dsh-hooks-claude-code` が
   プロファイルに入り、その `configPath` が `rdsh context hook install` で編集したファイルを
   指している必要があります。
6. **Windows / macOS 実機は未検証**（CI の対象外。Linux で確認）。
7. **性能・品質の実測は未実施**。起動やトークン削減の改善量は測定していません。
8. **256KiB 超のフック payload** では、プロンプト由来の検索クエリが使えません（注入自体は続行）。
9. **フックは記憶を書き換えません**。自動更新は `distill` の明示実行（または `Stop` フック等からの呼び出し）です。
10. **過去セッションの継承は記憶の撤回と照合しません**。撤回済みの決定と強く一致する過去発話が
    あれば、`sessions` 節に残ることがあります。`memory` 節（active のみ）が正であり、継承は補助です。
11. **`distill` は同一文面を1回に畳みます**。「A → 修正版B → A」のように元の文言へ戻しても、
    最後の A は既存 A と同じ文面として扱われ、B が active のまま残ります。
12. **`rdsh context hook install --rdsh <path>`** は、basename が `rdsh` のバイナリを指す前提です。
    別名のパスを指定すると再インストール時に自分の項目と認識できず、重複して追記されます
    （install 時に警告を出します）。

## 検証

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
BIN=./target/debug/rdsh sh tests/context_prototype.sh
BIN=./target/debug/rdsh sh tests/context_hook_prototype.sh
BIN=./target/debug/rdsh sh tests/deps_prototype.sh
BIN=./target/debug/rdsh node --test tests/context_inject_contract.mjs
BIN=./target/debug/rdsh node --test tests/security-boundaries.test.mjs
```

`tests/regress.sh` の `rustup-init pinned checksum` は**変更前の HEAD でも同じく失敗**します
（このマシンの rustup/cargo 環境で `Cargo.toml` の無い一時プロジェクトを扱えないため）。
変更前後で同一の失敗であることを `git worktree` 上の素の HEAD で確認したうえで、
その1件を除いた残りのスイートが通ることを確認しています。
