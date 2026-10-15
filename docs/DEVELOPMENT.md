# Development environment (開発環境)

**English summary:** Run `sh scripts/dev-setup.sh` once per clone. It checks the
toolchain (Rust MSRV, Node 22+, Python 3.11+), enables the repository hooks in
`.githooks/` and sets conflict-friendly local git options without overriding
yours. `sh scripts/check.sh` runs the CI-equivalent checks for the areas you
changed. Before pushing, `sh scripts/check-conflicts.sh` reports conflicts with
`origin/main`, and `--open-prs` lists open PRs that touch the same files. The
`conflicts` workflow labels PRs `needs-rebase` as soon as `main` moves. A dev
container (`.devcontainer/`) provides the same setup without local installs.

## 必要なもの

| ツール | 版 | 用途 |
| --- | --- | --- |
| Rust (rustup) | `Cargo.toml` の `rust-version` 以上。CI の lint は stable | 本体、`cargo fmt` と `clippy` |
| Node.js / npm | 22 以上 | dashboard、plugins、Node のテスト |
| Python | 3.11 以上 | リリース用スクリプトとテスト |
| git | 2.38 以上 | `scripts/check-conflicts.sh`（`git merge-tree --write-tree`） |
| zstd | 任意 | 一部の `cargo test` と `tests/regress.sh` |
| gh / shellcheck | 任意 | `--open-prs` と PR 作成、シェルの lint |

Windows では WSL か Git Bash からシェルスクリプトを実行します。PowerShell 側の
インストーラ試験は CI の `test (windows-latest, false)` が担います。

## セットアップ

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
sh scripts/dev-setup.sh                   # 確認と設定。何度実行しても同じ結果
sh scripts/dev-setup.sh --with-node-deps  # dashboard/ の npm ci も行う
sh scripts/dev-setup.sh --check           # 確認のみ。何も変更しない
```

`dev-setup.sh` がこのリポジトリの `git config --local` に設定する値は次のとおりです。
system・global・local・worktree のどこかで設定済みの項目は上書きせず、
設定元と推奨値との違いだけを表示します。独自の `core.hooksPath` がある場合、
このリポジトリの hooks は有効になりません。その旨と、有効にするときのコマンド
（`git config --local core.hooksPath .githooks`）を表示します。

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `core.hooksPath` | `.githooks` | 下記の hooks を有効にする |
| `rerere.enabled` / `rerere.autoupdate` | `true` | `main` を何度取り込んでも、同じ衝突は記録済みの解決を再利用する |
| `merge.conflictStyle` | `zdiff3` | 衝突箇所に共通祖先も表示し、正しく解きやすくする |
| `fetch.prune` | `true` | マージ後に削除されたリモートブランチを片付ける |

VS Code や GitHub Codespaces では、`.devcontainer/devcontainer.json` を開くと
Rust・Node 22・Python・zstd・gh・shellcheck を揃えた環境で
`dev-setup.sh --with-node-deps` まで自動で実行されます。

## 日々の確認

```sh
sh scripts/check.sh          # origin/main からの変更範囲に応じて検証を選ぶ（既定）
sh scripts/check.sh quick    # cargo fmt --check / clippy -D warnings / cargo test
sh scripts/check.sh full     # CONTRIBUTING.md の全項目（release ビルド）
sh scripts/check.sh --list   # 実行せずに、選ばれる検証だけを表示
```

既定モードでは、変更したファイルから対象を選びます。

- `src/` など: Rust 一式、`tests/regress.sh`、CI と同じ Node テスト
- `tests/*.test.mjs`、`plugins/`、`scripts/headless-runtime/`: CI の Node テスト、
  変更したテスト自体、変更した plugin の `npm test`、headless runtime の候補ビルドと
  テスト。Node テストの一覧は `.github/workflows/ci.yml` から読み取るため、main で
  増えたテストも自動で対象になります
- `dashboard/`: `npm test`
- リリース関連: Python の試験と `prepare-release.py`
- installer: 構文チェック。Linux で Docker が使える場合は
  `tests/install-isolated.sh --source local` も実行

最後に `check-conflicts.sh` も実行します。失敗があっても残りの検証は続け、
最後に一覧で表示します。依存（`node_modules`）がなく実行できないテストは、
成功と取り違えないよう失敗として扱います。手元では実行できない CI 専用の検証
（bubblewrap を使う security-boundaries、Windows、Isolated install、
browser-e2e）と、どの検証にも対応しない変更ファイルは、`todo` として一覧に
残ります。CI で結果を確認してください。

## Git hooks

| hook | 動作 | 回避 |
| --- | --- | --- |
| `pre-commit` | ステージした追加行に衝突マーカー（`<<<<<<<` など）があれば止める。`.rs` を含む場合は、ステージした内容（index）に `rustfmt --check` をかける | `git commit --no-verify` |
| `pre-push` | push する各ブランチを `origin/main` と比べ、衝突を警告する。既定では push を止めない | `git push --no-verify` |

`RDSH_SKIP_HOOKS=1` で両方を無効にできます。`RDSH_STRICT_PUSH=1` を設定すると、
衝突がある場合に加えて、`origin/main` を取得できず最新の状態と比べられない場合も
push を止めます。pre-commit の書式チェックはステージした内容だけを対象にします。
ステージしていない編集で commit が止まることはありません。rustfmt を実行できない
場合や構文エラーがある場合は、整形済みとはみなさずに止めます。

## コンフリクトを起こさない進め方

`main` は「ブランチが最新であること」を必須チェックにしているため、取り込みの
遅れはそのまま衝突と手戻りになります。過去のマージを再現すると、衝突は
`src/main.rs`、`tests/native_e2e.rs`、`README.md` と `README.ja.md`、
`.github/workflows/ci.yml` などの、多くの PR が触るファイルに集中していました。

1. **最新の `main` から分岐する。** 作業を始める直前に取得します。

   ```sh
   git fetch origin
   git switch -c fix/short-topic origin/main
   ```

2. **1 PR を 1 トピックに保ち、小さく出す。** 一括の整形、ファイル移動、
   リネームは機能変更と混ぜず、単独の PR にして Issue などで事前に知らせます。
3. **同じファイルを触る PR を先に確認する。**
   `sh scripts/check-conflicts.sh --open-prs` で、同じファイルを変更している
   open PR を一覧できます。重なる場合は、担当者と順番や分担を決めます。
4. **`main` が進んだら早めに取り込む。** `needs-rebase` ラベルが付いたら、
   `git fetch origin && git merge origin/main` で更新して push します。
   衝突が解消されると、ラベルは自動で外れます。
5. **衝突の起きやすいファイルでは、変更を局所化する。**
   - `src/main.rs`: 新しい処理は専用モジュールに置き、`main.rs` では分岐の
     追加だけにします。
   - テスト: 既存の大きなファイルの末尾に足すより、新しいテストファイルや
     テスト関数を分けます。
   - `README.md` と `README.ja.md`: 両方を同じ PR で同期し、段落の並べ替えは
     避けます。
   - `CHANGELOG.md`: `[Unreleased]` の該当見出しに 1 PR 1 項目を追加します。
     既存の項目は書き換えません。衝突した場合は両方の項目を残します。
6. **lockfile は手で混ぜない。** `Cargo.lock` や `package-lock.json` が衝突した
   場合は、`main` 側を採用してから再生成します。

   ```sh
   git checkout origin/main -- Cargo.lock && cargo build
   git checkout origin/main -- dashboard/package-lock.json && (cd dashboard && npm install)
   ```

7. **並行作業ではブランチごとに worktree を分ける。** 人と AI エージェントが
   同時に作業する場合も、1 つの worktree に書き込むのは 1 人（1 エージェント）
   だけにします。

   ```sh
   git worktree add ../rustdsh-short-topic -b fix/short-topic origin/main
   ```

## CI 上の衝突検知

`.github/workflows/conflicts.yml` は、`main` への push、PR の更新、PR の base 変更のたびに
`scripts/label-conflicts.sh` を実行します。base と衝突している open PR には
`needs-rebase` ラベルと案内のコメントを 1 度だけ付け、解消後にラベルを外します。
通知 workflow はリポジトリ共通のキューで直列実行し、main 更新と PR 更新が重なっても
同じ PR へ並行して投稿しません。実行中の処理は取り消さず、待機する更新は最新の確認へ
まとめます。毎回すべての open PR を取得するため、まとめられた更新の対象も確認します。
`pull_request_target` で動きますが、チェックアウトするのは base ブランチだけで、
PR のコードは実行しません。手元で結果を確認するには、`gh` で認証したうえで
`DRY_RUN=1 sh scripts/label-conflicts.sh` を実行します。

開発用スクリプト自体の回帰試験は `sh tests/dev-tooling.sh` です。
