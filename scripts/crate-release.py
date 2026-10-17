#!/usr/bin/env python3
"""Check and publish the `rdsh` crate on crates.io.

`check` validates what `cargo package` would upload without contacting the
registry: every file the binary embeds at compile time is present, the
release-only trees stay out, and the `.crate` file stays inside the crates.io
limits. `publish` repeats those checks, skips a version that is already on the
registry, and otherwise runs `cargo publish --locked`.

Only `publish` writes to the network, and it needs `CARGO_REGISTRY_TOKEN` in
the environment. The token is a repository secret in CD; nothing here prints it.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request

CRATE_NAME = "rdsh"
REGISTRY_URL = f"https://crates.io/api/v1/crates/{CRATE_NAME}"
# crates.io refuses a .crate file larger than 10 MB. Without the Cargo.toml
# exclude list the packaging included every media and docs asset and produced
# ~173 MiB, so this limit is the reason the check exists.
MAX_CRATE_BYTES = 10_000_000
# crates.io requires a descriptive User-Agent and answers 403 without one.
USER_AGENT = "rdsh-crate-release (+https://github.com/jimoto-no-llm/rustdsh)"

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Compile-time inputs. `build.rs`, `assets/` (icon, .rc), `security/` (preload
# and isolation scripts) and `install.sh` are read by include_str!,
# include_bytes! or embed-resource, so a crate without them does not build.
REQUIRED_MEMBERS = (
    "Cargo.toml",
    "build.rs",
    "install.sh",
    "LICENSE",
    "README.md",
    "assets/",
    "security/",
    "src/",
)
# Release-only trees. The published archives carry the binary alone, so the
# crate matches them instead of shipping the marketing media and docs.
FORBIDDEN_MEMBERS = (
    ".github/",
    "dashboard/",
    "desktop/",
    "docs/",
    "examples/",
    "media/",
    "mock/",
    "plugins/",
    "promo-video/",
    "scripts/",
    "tests/",
)


def crate_version(manifest: pathlib.Path) -> str:
    with manifest.open("rb") as handle:
        return tomllib.load(handle)["package"]["version"]


def check_tag(tag: str | None, version: str) -> list[str]:
    """The release tag and Cargo.toml must name the same version."""
    if tag is None:
        return []
    if tag != f"v{version}":
        return [f"tag {tag} does not match the Cargo.toml version {version}"]
    return []


def validate_members(
    members: list[str],
    required: tuple[str, ...] = REQUIRED_MEMBERS,
    forbidden: tuple[str, ...] = FORBIDDEN_MEMBERS,
) -> list[str]:
    """Report missing build inputs and release-only paths in the package."""
    errors: list[str] = []
    for entry in required:
        present = any(name.startswith(entry) for name in members) if entry.endswith("/") else entry in members
        if not present:
            errors.append(f"missing from the crate: {entry}")
    for entry in forbidden:
        offenders = [name for name in members if name.startswith(entry)] if entry.endswith("/") else [n for n in members if n == entry]
        if offenders:
            errors.append(f"release-only path inside the crate: {entry} ({len(offenders)} file(s))")
    return errors


def package_members(root: pathlib.Path = ROOT) -> list[str]:
    """Return the file list `cargo package` would upload."""
    result = subprocess.run(
        ["cargo", "package", "--list", "--allow-dirty"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip() and not line.startswith(("warning:", "error:"))
    ]


def package_size(version: str, root: pathlib.Path = ROOT) -> int:
    """Build the .crate without the verification build and return its size."""
    subprocess.run(
        ["cargo", "package", "--no-verify", "--allow-dirty"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    metadata = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    target = pathlib.Path(json.loads(metadata.stdout)["target_directory"])
    return (target / "package" / f"{CRATE_NAME}-{version}.crate").stat().st_size


def registry_has_version(version: str) -> bool:
    request = urllib.request.Request(f"{REGISTRY_URL}/{version}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status == 200
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise


def check(version: str, tag: str | None, root: pathlib.Path = ROOT) -> list[str]:
    errors = check_tag(tag, version)
    members = package_members(root)
    if not members:
        errors.append("cargo package listed no files")
    errors.extend(validate_members(members))
    if errors:
        return errors
    size = package_size(version, root)
    if size > MAX_CRATE_BYTES:
        errors.append(f"crate is {size} bytes; crates.io rejects more than {MAX_CRATE_BYTES}")
    else:
        print(f"crate {CRATE_NAME} {version}: {len(members)} files, {size} bytes")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "publish"))
    parser.add_argument("--tag", help="release tag to match against Cargo.toml (for example v0.4.1)")
    parser.add_argument("--dry-run", action="store_true", help="with publish: stop after the checks")
    args = parser.parse_args(argv)

    version = crate_version(ROOT / "Cargo.toml")
    errors = check(version, args.tag)
    if errors:
        for error in errors:
            print(f"crate-release: {error}", file=sys.stderr)
        return 1
    if args.command == "check" or args.dry_run:
        return 0

    if registry_has_version(version):
        print(f"crate {CRATE_NAME} {version} is already published; nothing to upload")
        return 0
    subprocess.run(["cargo", "publish", "--locked"], cwd=ROOT, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
