#!/usr/bin/env bash
# No pnpm, no dsh, no global package writes; a private runtime must be sufficient.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home with space'quote"
for tool in bash sh cat chmod cp curl dirname grep gzip id install ln mkdir mktemp mv rm sed sha256sum tar tr uname; do
  program="$(command -v "$tool")"; ln -s "$program" "$T/bin/$tool"
done
cat > "$T/bin/node" <<'NODE'
#!/bin/sh
case "${1:-}" in
  --version) echo v24.22.1 ;;
  */pnpm.cjs) echo 10.34.9 ;;
  */dsh/lib/bin.js) echo 0.2.2-alpha.3 ;;
  *) exit 9 ;;
esac
NODE
cat > "$T/bin/npm" <<'NPM'
#!/bin/sh
printf '%s\n' "$*" >> "$HOME/npm-calls"
[ "$1" = install ] && [ "$2" = --prefix ] || exit 8
mkdir -p "$3/node_modules/pnpm/bin" "$3/node_modules/@deepseek-ai/dsh/lib"
: > "$3/node_modules/pnpm/bin/pnpm.cjs"
: > "$3/node_modules/@deepseek-ai/dsh/lib/bin.js"
NPM
chmod +x "$T/bin/node" "$T/bin/npm"
HOME="$T/home with space'quote" PATH="$T/bin" DSH_ORIG_BIN= RDSH_ORIG_BIN= RDSH_SKIP_RUNTIME=0 bash "$ROOT/install.sh" --runtime-only --prefix="$T/home with space'quote/bin" > "$T/result" 2>&1
[ -x "$T/home with space'quote/bin/pnpm" ]
[ -x "$T/home with space'quote/bin/dsh" ]
[ "$(HOME="$T/home with space'quote" PATH="$T/bin" "$T/home with space'quote/bin/pnpm" --version)" = 10.34.9 ]
[ "$(HOME="$T/home with space'quote" PATH="$T/bin" "$T/home with space'quote/bin/dsh" --version)" = 0.2.2-alpha.3 ]
grep -q -- '--ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --strict-ssl=true pnpm@10.34.9 @deepseek-ai/dsh@0.2.2-alpha.3' "$T/home with space'quote/npm-calls"
! grep -q -- 'install -g' "$T/home with space'quote/npm-calls"
[ "$(cat "$T/home with space'quote/.config/rdsh/origin")" = "$T/home with space'quote/.local/share/rdsh/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" ]
# Explicit native-only install must not call npm or require a runtime.
mkdir -p "$T/skip"
HOME="$T/skip" PATH="$T/bin" bash "$ROOT/install.sh" --runtime-only --no-runtime --prefix="$T/skip/bin" > "$T/skipped" 2>&1
[ ! -e "$T/skip/npm-calls" ]
echo 'PASS: missing pnpm/dsh are prepared privately, paths with spaces work, native-only opt-out is respected'

# Full source install also prepares future shells without losing custom lines.
# The native build and package downloads are fixtures; no global tooling is used.
mkdir -p "$T/repo/target/release" "$T/shell home'quote"
cp "$ROOT/install.sh" "$T/repo/install.sh"
cat > "$T/bin/cargo" <<'CARGO'
#!/bin/sh
exit 0
CARGO
cat > "$T/repo/target/release/rdsh" <<'RDSH'
#!/bin/sh
case "${1:-}" in --version) echo 'rdsh 0.15.0' ;; doctor) echo 'fixture healthy' ;; esac
RDSH
chmod +x "$T/bin/cargo" "$T/repo/target/release/rdsh"
printf '# keep my settings\n' > "$T/shell home'quote/.zshrc"
for attempt in 1 2; do
  (cd "$T/repo" && HOME="$T/shell home'quote" PATH="$T/bin" CI=1 RDSH_SKIP_RUNTIME=0 RDSH_SKIP_PLUGINS=1 DSH_ORIG_BIN= RDSH_ORIG_BIN= bash ./install.sh --no-setup --prefix="$T/shell home'quote/bin'quote") > "$T/full-install-$attempt" 2>&1
 done
for startup in .profile .bashrc .zshrc; do
  [ "$(grep -c '# rdsh user PATH' "$T/shell home'quote/$startup")" = 1 ]
done
grep -q '# keep my settings' "$T/shell home'quote/.zshrc"
resolved="$(HOME="$T/shell home'quote" PATH="$T/bin" sh -c '. "$HOME/.config/rdsh/env"; command -v rdsh')"
[ "$resolved" = "$T/shell home'quote/bin'quote/rdsh" ]
echo 'PASS: full install persists a quoted PATH once and retains shell settings'

# A failed official Node checksum must stop before archive extraction/execution.
cat > "$T/bin/node" <<'NODE'
#!/bin/sh
echo v18.0.0
NODE
rm "$T/bin/curl"
cat > "$T/bin/curl" <<'CURL'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf 'untrusted archive' > "$1"; exit 0; fi
  shift
done
exit 9
CURL
chmod +x "$T/bin/node" "$T/bin/curl"
mkdir -p "$T/bad-digest"
if HOME="$T/bad-digest" PATH="$T/bin" RDSH_SKIP_RUNTIME=0 DSH_ORIG_BIN= RDSH_ORIG_BIN= bash "$ROOT/install.sh" --runtime-only --prefix="$T/bad-digest/bin" > "$T/bad-result" 2>&1; then
  echo 'FAIL: unverified Node archive accepted'; exit 1
fi
grep -q 'checksum mismatch' "$T/bad-result"
[ ! -e "$T/bad-digest/npm-calls" ]
echo 'PASS: corrupt runtime downloads stop before installation'
