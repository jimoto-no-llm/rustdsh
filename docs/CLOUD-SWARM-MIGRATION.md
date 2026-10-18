# swarm-rdshからの移行・互換性

既存`swarm-rdsh`の`gt-dsh`起動契約、固定profile、モデル経路、Gas Town /
Beads / DSHの責務は変更しない。既存のGas Town fixtureで得た実モデル1ジョブ
記録は、Gas CityまたはAgent SandboxでのE2E合格を意味しない。

新しい`rdsh swarm`は固定した`gc`バイナリのCLIを呼ぶ。Gas TownとGas Cityを
同じcity、同じtask集合へ同時起動しない。既存のGas Town構成を残す場合は
`rdsh swarm start`を使わず、既存`gt-dsh`経路を利用する。

Gas CityのKubernetes Providerは現状Podを直接作る。Agent Sandboxの
`SandboxClaim`と統合するには、Gas City側でRuntime ProviderがClaimの
Acquire / Ready / Exec / Nudge / Stopを扱う変更と、Dolt接続・Session名・
Refinery結果のE2Eが必要。今回の`rdsh cloud` ClaimをGas City Podと並列に
払い出すと二重実行になるため、その結線は行っていない。

移行の判定順は、公開fixtureで1 SandboxのDSH起動と成果物回収、Gas City
Runtime Provider接続、既存Gas Town fixture回帰、手動復旧・Refinery確認、
16/32/100並列、最後に容量と費用を審査した実環境負荷試験とする。
