#!/usr/bin/env python3
"""Pin a published release's archive digests into the two installer registries.

The installers verify downloads against the registries pinned on main, so a
release that is never pinned is invisible to install.sh --from-release, to the
automatic updater and to install.ps1 -FromRelease even though GitHub publishes
it. This script turns that follow-up into one reviewed command instead of
hand-editing rows.

The ledgers are separate on purpose. release-digests.tsv stays Unix-only: the
published installers (v0.3.1-v0.3.3) read it from the fixed canonical URL and
refuse the whole file as soon as it names any other asset. The Windows archive
is pinned in release-digests-windows.tsv, which only install.ps1 reads.

Usage:
    python3 scripts/pin-release-digests.py vX.Y.Z
    python3 scripts/pin-release-digests.py vX.Y.Z --from-json assets.json
    python3 scripts/pin-release-digests.py vX.Y.Z --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = "jimoto-no-llm/rustdsh"
UNIX_REGISTRY = Path("release-digests.tsv")
WINDOWS_REGISTRY = Path("release-digests-windows.tsv")
UNIX_ASSETS = (
    "rdsh-linux-x64.tar.gz",
    "rdsh-linux-x64-musl.tar.gz",
    "rdsh-macos-arm64.tar.gz",
    "rdsh-macos-x64.tar.gz",
)
WINDOWS_ASSET = "rdsh-windows-x64.zip"
ASSETS = UNIX_ASSETS + (WINDOWS_ASSET,)
UNIX_HEADER = (
    "# Trusted SHA-256 registry for the exact release archives supported by install.sh.",
    "# Regenerate each entry from the published release asset digest; do not copy .sha256 sidecars.",
)
WINDOWS_HEADER = (
    "# Trusted SHA-256 registry for the windows release archive (install.ps1).",
    "# Regenerate each entry from the published release asset digest; do not copy .sha256 sidecars.",
)
# (path, header, assets) per ledger the installers read.
LEDGERS = (
    (UNIX_REGISTRY, UNIX_HEADER, UNIX_ASSETS),
    (WINDOWS_REGISTRY, WINDOWS_HEADER, (WINDOWS_ASSET,)),
)
TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
LATEST_RE = re.compile(r"^latest\s+(\S+)\s*$")


def parse_tag(tag: str) -> tuple:
    match = TAG_RE.match(tag)
    if not match:
        raise ValueError(f"unsupported release tag: {tag}")
    if match.group(4):
        raise ValueError(f"refusing to pin a prerelease tag: {tag}")
    return tuple(int(part) for part in match.groups()[:3])


def parse_asset_lines(lines) -> dict:
    digests = {}
    for line in lines:
        parts = str(line).split()
        if len(parts) != 2:
            continue
        name, digest = parts
        digest = digest.removeprefix("sha256:")
        if name in ASSETS:
            digests[name] = digest
    return digests


def fetch_asset_digests(tag: str) -> dict:
    """Read GitHub's own asset digests (gh release view does not expose them)."""
    raw = subprocess.run(
        [
            "gh", "api", f"repos/{REPO}/releases/tags/{tag}",
            "--jq", r'.assets[] | "\(.name) \(.digest)"',
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    return parse_asset_lines(raw.splitlines())


def load_assets_json(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload if isinstance(payload, list) else payload.get("assets", [])
    digests = {}
    for asset in entries:
        name = str(asset.get("name", ""))
        digest = str(asset.get("digest", "")).removeprefix("sha256:")
        if name in ASSETS:
            digests[name] = digest
    return digests


def require_assets(tag: str, digests: dict, assets=UNIX_ASSETS) -> list:
    missing = [name for name in assets if name not in digests]
    if missing:
        raise SystemExit(f"{tag}: release is missing required assets: {', '.join(missing)}")
    rows = []
    for name in assets:
        digest = digests[name]
        if not DIGEST_RE.match(digest):
            raise SystemExit(f"{tag}: {name} has an unusable digest: {digest!r}")
        rows.append((name, digest))
    return rows


def split_registry(text: str) -> tuple:
    comments = []
    latest = None
    versions = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            comments.append(stripped)
            continue
        latest_match = LATEST_RE.match(stripped)
        if latest_match:
            latest = latest_match.group(1)
            continue
        parts = stripped.split()
        if len(parts) != 3:
            raise SystemExit(f"malformed registry row: {stripped!r}")
        version, name, digest = parts
        parse_tag(version)
        versions.setdefault(version, []).append((name, digest))
    return comments, latest, versions


def render_registry(tag: str, versions: dict, assets=UNIX_ASSETS, header=UNIX_HEADER) -> str:
    ordered = sorted(versions, key=parse_tag, reverse=True)
    lines = list(header)
    lines.append(f"latest {tag}")
    for version in ordered:
        rows = sorted(
            versions[version],
            key=lambda row: ASSETS.index(row[0]) if row[0] in ASSETS else len(ASSETS),
        )
        for name, digest in rows:
            lines.append(f"{version} {name} {digest}")
    return "\n".join(lines) + "\n"


def pin(text: str, tag: str, digests: dict, assets=UNIX_ASSETS, header=UNIX_HEADER) -> str:
    parse_tag(tag)
    rows = require_assets(tag, digests, assets)
    comments, _latest, versions = split_registry(text)
    if comments != list(header):
        raise SystemExit("registry header changed; update the header in this script first")
    versions[tag] = rows
    return render_registry(tag, versions, assets, header)


def pin_all(tag: str, digests: dict, ledgers=LEDGERS) -> list:
    """Render every ledger for one release before anything is written."""
    updates = []
    for path, header, assets in ledgers:
        updated = pin(path.read_text(encoding="utf-8"), tag, digests, assets, header)
        updates.append((path, updated, assets))
    return updates


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="published stable tag, e.g. v0.3.4")
    parser.add_argument("--registry", type=Path, default=UNIX_REGISTRY,
                        help=f"Unix ledger to update (default: {UNIX_REGISTRY})")
    parser.add_argument("--windows-registry", type=Path, default=WINDOWS_REGISTRY,
                        help=f"Windows ledger to update (default: {WINDOWS_REGISTRY})")
    parser.add_argument("--from-json", type=Path, help="offline asset list instead of gh api")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    digests = load_assets_json(args.from_json) if args.from_json else fetch_asset_digests(args.tag)
    ledgers = ((args.registry, UNIX_HEADER, UNIX_ASSETS),
               (args.windows_registry, WINDOWS_HEADER, (WINDOWS_ASSET,)))
    updates = pin_all(args.tag, digests, ledgers)
    if args.dry_run:
        for path, updated, _assets in updates:
            sys.stdout.write(f"# --- {path} (dry run) ---\n{updated}")
        return 0
    for path, updated, _assets in updates:
        path.write_text(updated, encoding="utf-8")
    summary = ", ".join(f"{path} ({len(assets)} archives)" for path, _text, assets in updates)
    print(f"pinned {args.tag} in {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
