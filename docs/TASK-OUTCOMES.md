# 成果と受入条件をタスクカードで確認する

Project dashboard の「成果と受入条件」から、目的、担当、最新成果、
次の一手、ブロッカー、受入条件の検証結果を確認できます。
`done` は作業の申告です。未実施の検査や部分検査の成功を検証済みと表示しません。

既存の `dashboard_upsert_task` に次の任意情報を追加します。
従来のタスクの形と state schema 1、プロジェクトごとの MCP 6ツールは維持します。

```json
{
  "id": "release-goal",
  "title": "保存処理の成果を受け入れる",
  "status": "done",
  "milestone": "M1",
  "blocker": "レビュー待ち",
  "outcome": {
    "purpose": "保存した内容を次回起動で復元できるようにする",
    "owner": "担当者",
    "latest_outcome": "保存と読み込みを実装した",
    "next_step": "終了条件を検査する"
  },
  "milestone_contract": {
    "id": "M1",
    "title": "保存処理の受入",
    "criteria": [
      {
        "task_id": "release-goal",
        "criterion_id": "restore",
        "description": "次回起動で保存内容を復元できる"
      }
    ]
  }
}
```

`outcome` の省略した項目は前の報告を保持し、`null` で一項目を解除します。
報告されていない目的・担当・成果・次の一手は「未申告」です。
この情報は任意の `task_outcomes` メタデータとして保存し、既存の task フィールドへ
検証済みフラグを追加しません。クライアントから検証結果を設定することもできません。

マイルストーンは終了条件を固定した ID として扱います。同じ ID への同じ定義は
重複せず、条件を変えたい場合は新しい ID を作ります。条件は1〜50件、定義済みの
受入条件の `task_id`・`criterion_id`・説明を参照します。説明が一致しない条件や
未定義の条件は未充足です。タスクの追加・分割はこのリストを変えません。
従来の `milestone` 名だけでは終了条件を定義したことになりません。

分割した作業は `outcome.acceptance_task_id` で親の受入対象を参照できます。
参照を省略したタスクは自分自身の ID の受入条件を表示します。
分割した作業数ではなく、固定した条件のうち現在の証拠で満たせる数を表示します。
条件の参照はこのプロジェクトの中だけです。

## 実行と確認

検査の定義・実行・証拠保存には既存の [受入条件台帳](ACCEPTANCE-EVIDENCE.md) を使います。
次の `criteria.json` の説明はマイルストーンの参照と同一にします。

```json
[
  {
    "id": "restore",
    "description": "次回起動で保存内容を復元できる",
    "inputs": ["src/save.rs", "tests/restore.rs"]
  }
]
```

```sh
rdsh-dashboard acceptance define --project ./project --task-id release-goal --criteria-file criteria.json
rdsh-dashboard acceptance run --project ./project --task-id release-goal --criterion-id restore --argv-file argv.json --scope full
```

`argv.json` は明示的に実行するコマンドの配列で、先頭は実行ファイルの絶対パスです。
カードの「受入条件と検証を確認」は結果を読むだけで、コマンドを実行しません。
プロジェクトのブラウザー用鍵・MCP用鍵・管理用鍵で認証された
`GET /api/task-outcomes?task_id=...` または `?milestone_id=...` を使います。
返却にはログ内容、コマンド引数、非公開の証拠保存先を含めません。

関連コードの変更、証拠の欠落・破損、条件の変更を検知すると古い成功は未充足です。
報告だけの成功と部分検査も全条件の検証を満たしません。
確認結果には確認時刻を付け、その後の変更は再確認する導線を表示します。
状態の改訂中に返った古い確認結果は表示しません。
人による受入や正式採用は、自動検査の結果とは別に確認します。

確認例と実画面は [before/afterの記録](evidence/task-outcomes/README.md) に保存します。
