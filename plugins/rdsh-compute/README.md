# rdsh-compute (opt-in PoC)

DSH Web → 常駐 `rdsh compute` → 純粋計算の橋渡しです。既定は OFF。

- 有効化: `RDSH_COMPUTE=1`（それ以外は元の Node 実装を使います）
- 対象は純粋な文字列計算のみ（`tokens.estimate` / `tokens.prune`）
- セッション・認証・モデル呼び出しは扱いません
- 失敗・タイムアウト（既定 5s）・版不一致は元の処理にフォールバック
- 1 MiB 超は送りません。大きな履歴は呼び出し側で分割します

判定は `docs/WEB-COMPUTE.md` の `T_total` 式で行います。
単体が速いだけでは採用しません。
