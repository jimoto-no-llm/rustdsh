#!/usr/bin/env python3
"""Validate release metadata and compose notes in the v0.2.0 format (Python 3.11+)."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tomllib


TAG = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?")
ROOT = Path(__file__).resolve().parents[1]


def previous_tag(notes, requested=None):
    recorded = re.findall(r"<!--\s*previous-tag:\s*(.*?)\s*-->", notes)
    if len(recorded) > 1 or (recorded and not TAG.fullmatch(recorded[0])):
        raise ValueError("record one valid previous-tag in release notes")
    base = recorded[0] if recorded else None
    if requested is not None and requested != base:
        raise ValueError("persist --previous-tag as '<!-- previous-tag: vX.Y.Z -->' in release notes")
    return base


def validate(root, tag):
    if not TAG.fullmatch(tag):
        raise ValueError("tag must be vX.Y.Z or vX.Y.Z-{alpha,beta,rc}.N")
    version = tag[1:]
    manifest = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
    package = manifest["package"]
    lock = tomllib.loads((root / "Cargo.lock").read_text(encoding="utf-8"))
    locked = [entry["version"] for entry in lock["package"] if entry["name"] == package["name"]]
    if package["version"] != version or locked != [version]:
        raise ValueError("tag, Cargo.toml and Cargo.lock versions must match")
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    if not re.search(r"^## \[" + re.escape(version) + r"\] - \d{4}-\d{2}-\d{2}$", changelog, re.M):
        raise ValueError("CHANGELOG.md must contain a dated entry for this version")
    notes = (root / "docs" / "releases" / f"{tag}.md").read_text(encoding="utf-8").strip()
    if not re.match(r"^## " + re.escape(version) + r" — \S", notes):
        raise ValueError("release notes must start with '## X.Y.Z — summary'")
    # The generated tail may be checked in, but is always replaced when rendering.
    authored = notes.split("\n## What's Changed", 1)[0].rstrip()
    for section in ("\n## 更新前に確認\n", "\nInstall/update:\n"):
        if section not in authored:
            raise ValueError(f"missing release notes section: {section.strip()}")
    if re.search(r"<summary>|<changes>|<compatibility>|\bTODO\b", authored):
        raise ValueError("fill in all release template placeholders")
    if not re.search(r"^- \S", authored.split("\n## 更新前に確認", 1)[0], re.M):
        raise ValueError("release summary must include a change list")
    if "```sh\n" not in authored or "install.ps1" not in authored:
        raise ValueError("include Unix and Windows installation instructions")
    if "-" in tag and "/releases/latest/" in authored:
        raise ValueError("prerelease installation must use the exact tag URL, not latest")
    if "-" in tag:
        installers = re.findall(r"/releases/(latest/download|download/[^/\s`<>]+)/install\.(sh|ps1)", authored)
        if (not any(asset == "sh" for _, asset in installers)
                or any(channel != f"download/{tag}" for channel, _ in installers)):
            raise ValueError("prerelease installer URLs must use this exact tag URL")
    if previous_tag(authored) == tag:
        raise ValueError("previous-tag must differ from the release tag")
    return authored


def compose(authored, generated, repository):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
        raise ValueError("repository must be OWNER/REPO")
    if "## What's Changed" not in generated or "**Full Changelog**:" not in generated:
        raise ValueError("GitHub generated notes must include changes and the comparison link")
    # A single configured category adds a redundant subheading; v0.2.0 has one heading.
    generated = generated.replace("## What's Changed\n### What's Changed\n",
                                  "## What's Changed\n\n", 1)
    return (f"{authored}\n\n{generated.strip()}\n\n"
            f"全変更は [CHANGELOG](https://github.com/{repository}/blob/main/CHANGELOG.md) に記載しています。\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--repo", default="jimoto-no-llm/rustdsh")
    parser.add_argument("--output", type=Path, help="compose notes using GitHub's generate-notes API")
    parser.add_argument("--previous-tag", help="explicit base tag for release notes, e.g. a hotfix")
    args = parser.parse_args()
    try:
        authored = validate(args.root, args.tag)
        base = previous_tag(authored, args.previous_tag)
        if args.output:
            command = ["gh", "api", f"repos/{args.repo}/releases/generate-notes", "--method", "POST",
                       "-f", f"tag_name={args.tag}", "-f", "configuration_file_path=.github/release.yml"]
            if base:
                command += ["-f", f"previous_tag_name={base}"]
            generated = json.loads(subprocess.check_output(command, text=True, encoding="utf-8"))["body"]
            args.output.write_text(compose(authored, generated, args.repo), encoding="utf-8")
        print(f"Validated {args.tag} ({'prerelease' if '-' in args.tag else 'stable'})")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"release validation failed: {error}\n")


if __name__ == "__main__":
    main()
