# コンテキスト保持とリポジトリ依存関係: 指摘への対応記録

対象は、レビューで共有された `rdsh_context_dependency_issues.md` の指摘
（2026年10月14日時点の `main` に対するレビュー）です。実装はこのリポジトリの
未リリース変更（`CHANGELOG.md` の Unreleased）に含まれ、検証は下表のテストで行っています。

## 結論

指摘のうち 1.1〜1.4、2.3、3.1〜3.2、および 4 の一部（再走査・完全性の可視化）に対応しました。
一方、2.1（意味検索）、2.2（走査上限と `.gitignore` 互換）、3.3（設計依存の競合検知）、
トークン数の厳密性は**未対応のまま**です。未対応の項目を「解決済み」と表記しないため、
残る制限として末尾に明示します。

## 対応表

| 指摘 | 対応 | 実装 | 検証 |
| --- | --- | --- | --- |
| 1.1 会話ターンへ自動注入されない | `rdsh context inject` が DSH `UserPromptSubmit` フック契約に基づいて文脈を出力。`rdsh context hook install` が `hooks.json` へ冪等に追記 | `src/context.rs`, `src/context_hook.rs` | `tests/context_hook_prototype.sh`, `tests/context_inject_contract.mjs` |
| 1.2 会話の進展で記憶が更新されない | 記憶ストア（schema 1）と `remember` / `distill` / `memory` / `forget`。撤回・重複は決定的な規則で `superseded_by` を付与して履歴を保持 | `src/context.rs` | `tests/context_hook_prototype.sh`, `cargo test` |
| 1.3 圧縮で中間の重要情報が消える | `rdsh compact` が切り捨てた中間から制約・決定・エラー・差分・コマンド行を予算の25%以内で残し、カテゴリ別の digest を付与 | `src/compact.rs` | `cargo test`（`compact::tests`） |
| 1.4 過去セッション参照が既定で0 | 注入は既定で直近2セッションを継承（`context.inject_sessions` / `inject_session_count`）。`build --sessions N` で1回のみ上書き可能 | `src/context.rs` | `tests/context_hook_prototype.sh` |
| 2.3 収集断片が単一時点を保証しない | 開始時と終了時で git HEAD・branch・dirty と読み取りファイルの size+mtime を比較し `snapshot` を出力。`--require-stable` は変化検知時および git 状態が不明な場合に exit 3 | `src/context.rs` | `cargo test`（snapshot テスト）, 手動CLI確認 |
| 2.3 / 3.1 抜粋に依存先が揃わない | 検索でヒットしたファイルを依存グラフ近傍（被 import 元・import 先）で展開して `retrieved` に追加 | `src/context.rs` + `src/deps.rs` | `tests/deps_prototype.sh` |
| 3.1 依存関係が構造化されていない | `rdsh deps build\|query\|impact`。Rust / JS・TS / Python / Go の import・定義・静的呼び出しをファイル単位で保持 | `src/deps.rs` | `tests/deps_prototype.sh` |
| 3.2 変更影響範囲が特定できない | `rdsh deps impact <file\|symbol>` が直接・推移（既定3、上限8）の依存元、影響を受けるテスト（テスト用パスおよび `#[cfg(test)]` を持つ依存ファイル）、未解決エッジ数を出力 | `src/deps.rs` | `tests/deps_prototype.sh` |
| 4 索引が無く毎回再走査する | `$DSH_HOME/rdsh-index/<root-key>.json` の増分索引。size+mtime が同一のファイルは再解析せず、`--force` で全体を再構築 | `src/deps.rs` | `tests/deps_prototype.sh` |
| 3.4 Dependabot とコード解析の混同 | 用語を区別して本ドキュメントと README に明記（下記） | `docs` | - |

## 各項目の補足

### 1.1 自動注入

注入は「フックが stdout に返す JSON」のみを経路とします。DSH 側は
`hookSpecificOutput.additionalContext` を次のリクエストの文脈として扱うため、
rdsh 側の作業メモとモデルが参照する文脈が同じ経路に乗ります。フックは **fail-open** です。

- どの失敗時でもプロンプトを中断せず exit 0 を返します。**何も出さない**のは設定ファイルが読めない場合と
  stdin を解釈できない場合のみです。索引が壊れている場合は「(dependencies: unknown; run rdsh deps build)」を
  付与し、期限超過の場合は検索節を落としたうえで、goal・constraints・記憶を出力し続けます。
- 期限（`context.inject_deadline_ms`、既定1200ms）を過ぎた場合はコード検索と依存閉包を省略し、
  goal・constraints・記憶のみを出力します。
- 予算は専用（`context.inject_budget`、既定1200トークン）であり、通常のターン予算とは別枠です。
- 記憶ファイルが壊れている場合は「(memory unreadable: unknown; using settings)」を1節に含めて
  設定値のみで続行し、注入そのものは中断しません。
- フック payload が 256KiB を超える場合は、本文を切り詰めたうえでプロンプト由来の検索クエリのみを
  使わずに注入します（goal・constraints・記憶は出力されます）。

### 1.2 記憶

フック（`inject`）は**記憶を書き換えません**。会話から記憶を生成するのは `distill` の明示的な実行時のみです。
プロンプトを毎ターン自動で記憶へ追記すると、(a) 生の会話が上限まで蓄積し、(b) 抽出した `[mem]` が
次の文脈に再注入されて自身のプロンプトを読み返す feedback loop に陥り、(c) 貼り付けた機密情報が
そのまま永続化されかねないためです。自動化したい場合は `Stop` フックなどから
`rdsh context distill --apply` を明示的に呼び出す運用とします。`--session` を省略すると
最新セッションが選択されます（`--latest` オプションはありません）。

記憶は会話ログの複製ではなく、種類（goal / decision / constraint / task / file / note）を持つ
項目の集合です。`distill` は**ユーザー発話だけ**を読み込み、`source.kind` が `hooks-*` の生成発話を除外したうえで、
マーカーによって決定・制約・撤回を抽出します。source を持たない従来形式の user message も引き続き読み込みます。
新しい項目が既存項目と正規化トークンで60%以上重複する場合、または撤回マーカーを含む場合は、
古い項目を `superseded_by` で無効化します（削除はしません）。規則で解決できない矛盾は双方を
active のまま残し、conflict として警告します。明示的な書き込みは 0600・原子的置換に加え、
Unix の `flock` / Windows の `LockFileEx` で直列化します。競合時はロックの解放まで待機します。
フック注入は記憶ロックを取得せず、記憶の変更も行いません。

### 1.3 圧縮

予算内であればバイト単位で同一のまま通過させる契約は維持しています。超過時は、先頭（system）と新しい行を
優先しつつ、切り捨てられた中間から重要行（制約・決定・エラー・差分パス・コマンド）を予算の25%以内で
元の順序のまま残し、カテゴリ別の件数を digest として出力します。出力は常に予算以下となります。

### 2.3 鮮度

`build` は開始時と終了時で git HEAD・branch・dirty パスと、実際に読み込んだファイルの
size+mtime を比較します。変化があれば `snapshot.stable=false` と変化したファイルの一覧を出力し、
`--require-stable` 指定時は（変化がなくても git 状態を読み取れない場合を含め）exit 3、注入時は1行の警告を付与します。「収集途中で変更された断片を
単一時点の事実として渡さない」ための最小限の保証であり、ファイル内容の意味的な整合性までは保証しません。

### 3.1 / 3.2 依存グラフ

抽出は静的な近似です。動的 dispatch、間接呼び出し、マクロ生成、生成コードは `unknown` として
明示し、`unresolved` 件数として報告します。索引がない場合は「情報がない」ことを意味し、「依存がない」ことでは
ありません（`related_files` は空を返し、注入は閉包なしで続行します）。

`impact` の `tests` は「依存元のうちテストを持つファイル」です。このリポジトリのように
各モジュールが `#[cfg(test)]` を持つ構成では、推移的な依存元が広範囲にわたるため一覧も肥大化します。
「この変更で何を走らせるか」の絞り込みとしては、パスがテストを示すファイル（`tests/**` など）と、
単体テストを持つ依存元を合わせて確認するのが現実的です。実測では 231 ファイル・512 エッジを
0.55 秒で構築し、2回目は 231 ファイルすべてを再利用（`parsed: 0`）しました。

### 3.4 Dependabot との違い

Dependabot が対象とするのは Cargo / npm / GitHub Actions の**パッケージ更新**であり、アプリケーション内部の
関数・モジュール間の依存や変更の影響ではありません。`rdsh deps` は後者のみを扱い、両者を
同一の「依存関係管理」としては扱いません。

## 残る制限（未解決）

1. **意味検索（2.1）は未実装**。検索は文字列スコアと依存グラフの構造に基づいており、関数名の変更・
   別名の概念・間接呼び出しの意味的な等価性には追随しません。埋め込みや構文解析器は導入していません。
2. **検索・読み込み上限（2.2）はそのまま**。`context` の検索は走査ファイル数・読み取り量・
   行数・採用行数に上限があり、`working_files` は先頭と末尾の抜粋にとどまります。`.gitignore` の解釈も
   簡易実装のままです（`deps` は独自のスキップ規則を使用します）。
3. **設計依存のワーカー競合検知（3.3）は未実装**。依存グラフは判断材料を提供しますが、別ファイルを
   編集している2名の競合を自動判定する機能はありません。
4. **トークン数は近似**。既存の文字種ベースの見積もりであり、モデル固有のトークナイザーではありません。
5. **実 DSH での発火は未検証**。検証したのは (a) フック契約の JSON を DSH の
   `@deepseek-ai/dsh-hook-protocol` のコーデックでデコードできること、(b) `hooks.json` への
   冪等な追記です。実際にフックを起動するには `@deepseek-ai/dsh-hooks-claude-code` が
   プロファイルに含まれ、その `configPath` が `rdsh context hook install` で編集したファイルを
   指している必要があります。
6. **Windows / macOS 実機での DSH フック発火は未検証**。GitHub Actions の各 OS CI は通過しますが、
   対象端末に導入した DSH プロファイルでのフック発火までは保証しません。
7. **性能・品質の実測は未実施**。起動時間やトークン削減の改善量は測定していません。
8. **256KiB 超のフック payload** では、プロンプト由来の検索クエリが使用できません（注入自体は続行されます）。
9. **フックは記憶を書き換えません**。自動更新には `distill` の明示実行（または `Stop` フック等からの呼び出し）が必要です。
10. **過去セッションの継承は記憶の撤回と照合しません**。撤回済みの決定と強く一致する過去発話が
    あれば、`sessions` 節に残ることがあります。`memory` 節（active のみ）が正の情報であり、継承は補助にとどまります。
11. **`distill` は同一文面を1回に畳みます**。「A → 修正版B → A」のように元の文言へ戻した場合でも、
    最後の A は既存の A と同一の文面として扱われ、B が active のまま残ります。
12. **`rdsh context hook install --rdsh <path>`** は、basename が `rdsh` のバイナリを指す前提です。
    別名のパスを指定すると再インストール時に自身の項目と認識できず、重複して追記されます
    （install 時に警告を出力します）。

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

`tests/regress.sh` の `rustup-init pinned checksum` は**変更前の HEAD でも同様に失敗**します
（このマシンの rustup/cargo 環境で `Cargo.toml` のない一時プロジェクトを扱えないため）。
変更前後で同一の失敗であることを `git worktree` 上の素の HEAD で確認したうえで、
その1件を除いた残りのスイートが通過することを確認しています。
