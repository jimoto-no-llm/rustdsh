# 推論量（reasoning effort）を自動で決める：2 つの参考実装の要点

rdsh に「自動で推論量を決める」機能を入れるときの材料。
外部の 2 本を読み、**そのまま真似できる部分**と**rdsh では採らない部分**を分けて書く。

- [ReasoningEffortLLM（KaiserWhoLearns）](https://github.com/KaiserWhoLearns/ReasoningEffortLLM) — 論文「What Effort Level Should I Choose?」の実験コード（MIT）
- [hermes-switchyard（bgrablin）](https://github.com/bgrablin/hermes-switchyard) — Hermes Agent 用プラグインの実装（適応的 effort が既定で有効）

---

## 1. 論文側の実測（案の根拠）

8 モデル × 4 ベンチ（AIME 2026 / GPQA Diamond / Terminal-Bench 2.1 / SWE-Bench Pro）で、
タスク・プロンプト・ハーネスを固定して **effort だけを振った**結果。要点は 4 つ。

| 主張 | 中身 | 実装への意味 |
| --- | --- | --- |
| 高い effort は低い effort の上位互換ではない | 平均精度は上がるが、低い effort で解けたタスクを高い effort で落とすことが頻繁にある | 「常に最大」を既定にしない |
| 易しいタスクで過剰に払う | どの段階でも解けるタスクで、最高段階は最低段階の最大 42 倍のコスト | 易しいと分かる仕事は下げる価値が大きい |
| effort は仕事の進め方を変える | 高い effort では自己検証が増え、解く代わりに検索へ逃げ、軌道が長くなる | 長さは成果の代理指標にならない |
| **失敗したら上げるのが良い** | 最低段階から始め、検証済みの失敗のときだけ上げると、固定の最高 effort と同等以上・多くの有料モデルでは安い | 既定は「低く始めて、失敗で上げる」 |

実装の核は `routing/make_laddering.py` の `ladder()`。段は最低 → 最高の 2 段だけで、
失敗した unit だけ再試行し、`first_pass_cost` と `escalation_cost` を分けて数える。

## 2. プラグイン側の作り（安全に効かせる型）

`hermes_switchyard/reasoning_effort_adapter.py` と `docs/ADAPTIVE-REASONING-EFFORT.md`。

### 2.1 利用者の指定は「上限」であって「指示」ではない

- 送出する effort は **利用者が選んだ段階以下**。上げるのは、利用者が明示的に許可したとき
  （`allow_raise`）の 1 段だけ、しかも**ツール失敗の後**に限る。
- 迷ったら利用者の段階をそのまま出す（タイムアウト・不正な応答・プライバシー拒否・
  テキストが取れない、はすべて「そのまま」）。
- 状態表示は「上限（cap）」と「実際に送った段階（sent）」を分けて出す。

### 2.2 易しいターンはローカルで判定（クラウドを呼ばない）

`trivial_turn.py` は**閉じた語彙リスト**で判定する。長さでは判定しない
（`fix ci` のような短い依頼を易しいと誤判定しないため）。

- 挨拶・お礼・相槌の語（`hi` / `thanks` / `ok` / `lgtm` …）だけのターン
- 語数 6 以下、記号のみ 8 文字以下、など

### 2.3 判断の材料は「そのターンの利用者メッセージ本文だけ」

- 送るのは **現在のユーザーメッセージの抜粋**（最大 1,200 文字）だけ。
- プロバイダへのリクエスト本文（メモリ・履歴・ツール結果を含む）は**読まない**。
- 制限された内容らしき文字列があるときは送らず、利用者の段階をそのまま使う。
- レシート（記録）に本文は残さない。
- 判断の期限は 0.1〜1.5 秒（既定 0.4 秒）。過ぎたら利用者の段階。

### 2.4 記録（レシート）と節約量

- 返答の下に 1 行出す：`Reasoning: high→low · 180 ms`。
- 節約量は**測れたときだけ**出す。同じモデル・同じ段階の基準サンプルが 3 件以上あるとき、
  `median(基準) − 実測` を出す。無ければ「不明」と書く。**数字を作らない。**

### 2.5 「重要な依頼」では下げない

- ツール失敗の後、書き込みの後、依頼の変更、`stakes` スコアが閾値以上、のどれかで下げない。

## 3. rdsh に取り入れるときの形（提案）

rdsh は dsh に委譲するランチャーなので、**effort を決めるのも委譲先の dsh 側**になる。
rdsh が持てるのは次の 3 つ。

1. **方針を決めて設定へ書く**（モデルごとの上限・自動調整の可否）。既存の
   `rdsh provider add --effort` と `rdsh models efforts` の延長で扱える。
2. **記録を見せる**（どのターンでどれだけ下がったか）。これは dsh の usage を読む形になる。
3. **失敗で上げる動きを用意する**（`ladder`）。dsh 側に再試行の仕組みが要るため、
   rdsh 単体では完結しない。まずは方針の設定と可視化から。

### 採らないもの

- クラウドの判断モデル（Jev 相当）への依存。rdsh は追加の API キーを要求しない方針なので、
  既定では**ローカルの閉じた語彙判定**だけにする。
- 依頼本文を外部へ送る形。送る必要があるなら明示的な同意を設定で求める。

## 4. 出典

- 論文と実験コード: <https://github.com/KaiserWhoLearns/ReasoningEffortLLM>
- 実装（適応的 effort）: <https://github.com/bgrablin/hermes-switchyard>
  - `docs/ADAPTIVE-REASONING-EFFORT.md`
  - `hermes_switchyard/reasoning_effort_adapter.py`
  - `hermes_switchyard/trivial_turn.py`
