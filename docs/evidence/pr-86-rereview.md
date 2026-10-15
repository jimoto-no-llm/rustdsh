# PR #86 re-review evidence

The original sections below are historical evidence for their named commits.
The 2026-10-15 integration and its verification limits are recorded separately.

## Current scope

This update integrates the PR branch at `bc9a6568e2382722e5299e764187296f48ddbe59`
with current `main` at `c73183a964ec4c3c0637f4e2beeb860b5a0c908a`. It keeps the
low-end host guide in both READMEs, documents the saved default-profile setting,
adds low-priority systemd guidance, expands isolated release and CLI regressions,
and makes Windows job-membership reporting consistent when kernel observations
race.

## Reviewer requests

- The release sync path checks the downloaded asset against its published
  `.sha256` sidecar before replacing the installed binary. Missing, empty, or
  mismatched sidecars leave the current binary in place; `tests/regress.sh`
  exercises these cases. The READMEs now state that checksum behavior.
- A profile-less `rdsh boot` uses `RDSH_DEFAULT_PROFILE`, then the saved
  `general.default_profile`, then an existing local `tui` profile, and otherwise
  exits with guidance. Explicit profile names continue to be passed through.
  The README examples and regression cases now describe and cover this order.

## Verification status

The updated regression suite covers saved-profile precedence, explicit profile
delegation, Node compile-cache opt-out and passthrough behavior, zstd header and
CLI paths, release checksum failures, and bounded test-side filesystem writes.
Markdown lint passed for both READMEs and this evidence note. The dashboard
process-scope test file passed all 8 tests, and `bash -n tests/regress.sh` passed.
The Rust toolchain is unavailable in this Windows worktree, so the Linux release
build, Rust tests, and full CLI regression run still need to pass in CI before
the PR is considered ready. The existing `REQUEST_CHANGES` review remains for
the reviewer to reassess; no review state is cleared by this evidence note.

## 2026-10-15: main 29e9a5c との統合

元head `34cf3d144db5d435927bc4b066623c87bbfcbf6b` を
main `29e9a5c161ea81a6f3500215c1c2168743302c8c` へ統合した段階の記録です。
Rust・installer・syncの製品実装は変更していません。上記の古いsidecar検証や
過去のCIを、今回の固定digest台帳と統合結果の証拠には置き換えていません。

- mainのWindows検証ディスパッチ、sandbox内の元DSHスタブ、認証共有の選択と
  dry-run無書込、doctor各fixture、legacy tokens cacheのJSON変換、
  installer・rustup・syncの固定digest検証を保持しました。
- 呼び出し元からの相対BIN、repo基準の既定BIN、単一の一時領域とTMPDIR、
  default profileの優先順位、compile cacheのopt-out、FCSとzstdの分岐を保持しました。
- 通常のagent起動は成功してcompile cacheを作成し、`RDSH_SECURITY=1` による
  拒否ではcacheを作成しない、というmainの契約へテストを合わせました。
- libc選択fixtureはsidecarを使わず、版付きの合成アーカイブと固定digest台帳を使います。
  mainのglibc下限は2.39なので、元のldd 2.36入力はmuslを期待し、ldd 2.41のGNU対照も追加しました。

この段階で実行した検証:

- Git Bashでの`bash -n`と`sh -n`は成功。
- Nodeのprocess-scope試験は10件中9成功・1除外、失敗0。
- 空白を含むBINで、実regressの先頭処理とversion検査だけを合成コマンドへ実行。
  元headでは失敗し、引用を補った統合後は成功しました。full CLIの検証ではありません。
- 実installerと一時的なfile配布物でgetconf 2.41/2.31、ldd 2.36/2.41、
  明示muslの5対照が成功。正した遮断fixtureでは、元のsidecar型fixtureは台帳取得を拒否して失敗しました。
  実インストール先・実設定・資格情報・プロバイダは使用していません。

fixture初回試行ではWindowsパスをPOSIXとして扱えず、tarとPATH選択が失敗しました。
次のbefore試行ではPATHの遮断が効かず、公開canonical digest台帳を1回GETしました。
取得物の実インストール前に停止し、一時HOME・DSH_HOME・prefix以外は更新していません。
遮断PATHをBash内でPOSIX形式に固定してから、上記のbefore/afterを再実行しています。

Linux full regress、systemd実運用、実DSH・モデル、統合後のexact-head CIはこの段階では未確認です。
Windows上の合成fixture試験やNode試験から、それらの成功は主張していません。
