# WindowsのNode TCPクラッシュ診断

2026-10-29に、実際のWebホストが使用していたNode 24.15.0だけで
`0xC0000409`を再現した。DSH、プラグイン、外部モデルへの接続は不要だった。
Node 24系では、修正を含む24.16.0以降を使用する。

## 再現と比較

`scripts/diagnostics/windows-node-tcp.cjs`は、ループバックに一時HTTPサーバーを立て、
keep-aliveを無効にした最大96並列のクライアントを実行する。実サービスのポート、
認証情報、設定、会話を使わず、外部通信もしない。手動診断用で、CIからは実行しない。

```powershell
& 'C:\path\to\old\node.exe' .\scripts\diagnostics\windows-node-tcp.cjs 60000
$LASTEXITCODE
& 'C:\path\to\fixed\node.exe' .\scripts\diagnostics\windows-node-tcp.cjs 60000
$LASTEXITCODE
```

| 条件 | 結果 |
| --- | --- |
| Node 24.15.0 / libuv 1.51.0、通常起動 | 開始直後に`-1073740791` / `0xC0000409`で終了 |
| 同版、ProcDumpで監視 | 別試行で同じ異常を捕捉、ミニダンプ取得 |
| Node 24.22.1 / libuv 1.52.1、通常起動 | 60.191秒で正常終了、43,441要求中14,920完了・28,521失敗 |

失敗要求には短時間の大量接続による制約があるため、この試験をHTTP性能や全要求成功の
証明として扱わない。比較対象はネイティブクラッシュの有無。旧版もデバッガー下の
15秒の別試行では正常終了しており、毎回必ず発生する不具合ではない。
修正版の有限時間での成功は、将来のすべてのクラッシュを否定する証拠ではない。

修正版で既存DSH 0.2.1-rc.2を別のホーム・一時ポートで起動し、ホストと4プリセットで
各120スキルの読込みに成功した（23.471秒）。同版のKoffiによるWin32呼出しも成功。
クラウド推論要求は0回。

## ネイティブ証拠

公式Node 24.15.0のPDBを公開SHA256で照合し、Windows DbgHelpの`StackWalk64`で
取得したダンプのネイティブフレームを巻き戻した。JIT領域に入った後は解析対象外。

```text
Exception: 0xc0000409
ExceptionInformation[0]: 2 (FAST_FAIL_STACK_COOKIE_CHECK_FAILURE)
__report_gsfailure+0x1d
uv__tcp_connect+0x3af
uv_tcp_connect+0x3b
node::TCPWrap::Connect<sockaddr_in>+0x248
node::TCPWrap::Connect+0x7f
```

再現プロセスにはKoffiやDSHのネイティブアドオンはロードされていなかった。
通常起動の再現時刻付近には、GPUイベントもApplicationクラッシュイベントもなかった。
生ダンプ、ローカルパス、環境変数、署名用認証情報はこの記録へ含めない。

## 原因と修正の対応

旧版の`deps/uv/src/win/tcp.c`にある`uv__is_fast_loopback_fail_supported()`は、
スタック上の`OSVERSIONINFOW`のサイズなどを初期化せず`RtlGetVersion()`に渡す。
上流ではこの初期化不足を修正している。再現したTCPスタックとサブコードは、
Node側の既知報告と一致する。

- [Nodeの再現報告とメンテナーによる修正確認](https://github.com/nodejs/node/issues/63620)
- [Nodeへの修正取り込み](https://github.com/nodejs/node/pull/62561)
- [libuvの初期化修正](https://github.com/libuv/libuv/commit/aabb7651de)
- [Node 24.16.0リリース](https://nodejs.org/en/blog/release/v24.16.0)

過去の本番停止そのもののダンプは残っていない。今回確定したのは、その本番で使った
NodeのTCPクラッシュと修正版での比較結果であり、過去の全終了が同じスタックだったと
証明したものではない。旧Node製監視自身の最終終了スタックも未採取。
以前同時刻に観測したGPUエラーだけを原因とは扱わない。
