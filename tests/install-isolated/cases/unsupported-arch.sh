#!/usr/bin/env bash
# An unsupported architecture must fail closed before downloading anything.
set -euo pipefail
. /cases/lib.sh

mkdir -p /tmp/fakebin
cat > /tmp/fakebin/uname <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) echo Linux ;;
  -m) echo riscv64 ;;
  *) echo Linux ;;
esac
EOF
chmod 755 /tmp/fakebin/uname

if PATH="/tmp/fakebin:$PATH" bash /install.sh --from-release --prefix="$PREFIX" >"$HOME/install.log" 2>&1; then
  echo "installer accepted an unsupported architecture" >&2
  exit 1
fi
grep -q 'no prebuilt binary' "$HOME/install.log"
if [ -e "$PREFIX/rdsh" ]; then
  echo "installer left a binary behind on an unsupported architecture" >&2
  exit 1
fi
echo "CASE OK: unsupported-arch"
