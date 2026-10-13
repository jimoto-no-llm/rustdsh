# ブランチ・PR・Issue の整理

関連する修正は既存の topic branch と PR にまとめます。小さな lint 置換ごとに
ブランチを増やさず、現在の作業へ含めるか、まとまった整理 PR に集約します。
自動マージ後の head branch 削除は、GitHub の既存設定で有効です。

## 削除する範囲

`scripts/prune-merged-branches.py` は、最新 `origin/main` の祖先に含まれる
ブランチだけを候補にします。次のものは保持します。

- `main` / `master`、別 worktree を含む作業中のブランチ。
- Open PR の head、main に未統合の履歴。
- `release/` / `archive/` 以下の履歴。
- GitHub の実 head とキャッシュした SHA が異なるブランチ。

GitHub の取得に失敗した場合や、一覧が上限に達した場合は停止します。
適用直前にも Open PR と worktree を確認します。ローカル参照の削除には旧 SHA、
リモート削除にはその SHA の lease を使い、途中で変化した参照を削除しません。

## 確認・適用・復元

まず最新の参照を取得して、変更せずに JSON の一覧を確認します。

```sh
git fetch origin
python3 scripts/prune-merged-branches.py
```

適用するときは、すべての worktree の外側に新しいバックアップ先を指定します。
この環境では外部保存先のマウントを確認してから使います。

```sh
mountpoint /home/sahen/Projects/external-migration
RDSH_BRANCH_BACKUP="/home/sahen/Projects/external-migration/rustdsh-maintenance/branches-$(date +%Y%m%d-%H%M%S)"
python3 scripts/prune-merged-branches.py --apply --backup-dir "$RDSH_BRANCH_BACKUP"
```

`refs.bundle` を作成・検証した後で削除します。`plan.json` は基準 SHA と全参照、
`result.json` は削除した参照を記録します。同じバックアップ先は上書きしません。
GitHub 上の削除も含める場合だけ `--include-remote` を付けます。

復元は bundle の一覧を確認し、必要な参照だけを戻します。次の `fix/example` は
実際のブランチ名へ置き換えます。既存の同名ブランチを上書きしないでください。

```sh
git bundle verify "$RDSH_BRANCH_BACKUP/refs.bundle"
git bundle list-heads "$RDSH_BRANCH_BACKUP/refs.bundle"
git fetch "$RDSH_BRANCH_BACKUP/refs.bundle" refs/heads/fix/example:refs/heads/fix/example
```

削除済みの GitHub ブランチを指す remote-tracking ref は、実リモートの削除とは別です。
bundle 保存後に `git remote prune origin --dry-run` を確認し、対象が既に GitHub に
存在しないことを照合してから `git remote prune origin` を実行します。

## 2026-10-13 の整理結果

マージ済みのローカル44本と、GitHub では削除済みの追跡参照9本を削除しました。
最初のリモート削除候補6本は既に GitHub に存在せず、lease で停止しました。
そこで実 head の照合をスクリプトへ追加し、追跡参照を整理しました。
GitHub 上の実ブランチは、この作業では削除していません。

復元用 bundle は
`/home/sahen/Projects/external-migration/rustdsh-maintenance/branch-backups-20261013-1f36c90/refs.bundle`
に保存済みです。別エージェントの作業中にも新しい参照が追加されるため、
本数だけで削除を進めず、未統合・Open PR の差分を保持します。

[PR・Issue 台帳](reviews/2026-10-13-pr-issues.md)は、全 Open PR の head・CI・競合と、
Open Issue の対応先・残る確認を記録しています。受け入れ条件の未確認を
コードの存在だけで完了とせず、ラベルと担当者を保持します。
