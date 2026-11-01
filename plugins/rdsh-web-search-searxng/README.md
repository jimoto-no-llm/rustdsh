# rdsh-web-search-searxng

dsh エージェントの `web_search` を手元の rustxng / SearXNG に差し替える rdsh 同梱プラグインです。

- `rdsh` は `web_search_bridge` 機能（既定 ON）が有効で、rustxng または
  `SEARXNG_URL` が実際に応答するときだけ、委譲した dsh へ
  `DSH_WEB_SEARCH_PROVIDER=rdsh-rustxng` と `RDSH_SEARXNG_URL` を注入します。
- 本プラグインは注入された env があるときだけ provider（`rdsh-rustxng`）を
  `ctx.web` に登録します。rustxng が届かない環境では何も登録せず、dsh 既定の
  `deepseek-official` 検索がそのまま動きます（Web 検索の設定切替も壊しません）。
- 登録済みで検索の途中にこけた場合はエラーとして明示し、検索の途中で DeepSeek に
  黙ってフォールバックしません（dsh-web-search-deepseek と同一の方針）。

オフにする: `rdsh features off web_search_bridge`、または起動環境
`RDSH_WEB_SEARCH_BRIDGE=0`。
