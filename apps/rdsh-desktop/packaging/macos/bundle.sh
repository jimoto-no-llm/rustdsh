#!/bin/sh
# Build rdsh-desktop.app from the release binary (run from this directory).
set -eu
app="rdsh-desktop.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp ../../target/release/rdsh-desktop "$app/Contents/MacOS/rdsh-desktop" 2>/dev/null || \
  cp "${CARGO_TARGET_DIR:-../../target}/release/rdsh-desktop" "$app/Contents/MacOS/rdsh-desktop"
cp Info.plist "$app/Contents/Info.plist"
cp ../icon.icns "$app/Contents/Resources/icon.icns" 2>/dev/null || true
echo "built $app"
