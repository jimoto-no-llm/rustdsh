#!/usr/bin/env python3
"""Plan and prepare the next semver release for the release cadence.

`plan` picks the bump — a minor when `[Unreleased]` has a `### Added`
section, or when a pull request merged since the latest stable tag carries the
`feature`, `enhancement` or `breaking` label, and a patch otherwise — and
reports the latest stable tag, the next tag, the preparation branch, the reason
and whether `[Unreleased]` has anything to release. `promote` performs the
mechanical part of a release preparation pull request: bump `Cargo.toml` and
the `rdsh` entry in `Cargo.lock`, promote the whole `[Unreleased]` section
into a dated entry, and write a `docs/releases/vX.Y.Z.md` skeleton that
records the chosen bump and its reason for review.

Tagging stays manual: docs/RELEASING.md keeps the tag on the exact SHA whose
required checks are green. This script never tags and never pushes.
"""
import argparse
from datetime import date as date_type, datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import tomllib


STABLE = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
UNRELEASED = re.compile(r"^## \[Unreleased\]\n", re.M)
NEXT_ENTRY = re.compile(r"^## \[", re.M)
ADDED = re.compile(r"^### Added\s*$", re.M)
# 利用者が新機能として認識する変更を示すラベル（docs/RELEASING.md の判定表）。
FEATURE_LABELS = ("breaking", "enhancement", "feature")
ROOT = Path(__file__).resolve().parents[1]

NOTES = """## {version} — CHANGELOG の [Unreleased] より生成

{changes}

## 更新前に確認

- 対応プラットフォームは Linux x86_64（glibc / musl）、macOS arm64・x86_64、Windows x86_64 です。
- 版の判定: {bump}（{reason}）。迷ったら「利用者が新機能として認識するか」を基準にし、この1行は残すか直してください。
- 互換性と移行の要否はこの準備 PR で確定してください。破壊的変更は CHANGELOG とこのノートで必ず明示してください（0.x の間は minor で表現してかまいません）。
- 更新後は既存の rustdsh プロセスを再起動してください。

Install/update:

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

Windows では同じ Release の `install.ps1 -FromRelease` を使用してください。

<!-- この雛形は release-cadence workflow が生成しました。要約・互換性・移行の記述を公開前にレビューしてください。 -->
<!-- previous-tag: {previous} -->
<!-- cadence-bump: {bump} -->
"""


def parse_tag(tag):
    match = STABLE.fullmatch(tag)
    if not match:
        raise ValueError(f"tag must be vX.Y.Z: {tag!r}")
    return tuple(int(part) for part in match.groups())


def latest_stable(tags):
    versions = [(parse_tag(tag), tag) for tag in tags if STABLE.fullmatch(tag)]
    if not versions:
        raise ValueError("no stable vX.Y.Z tag found")
    return max(versions)[1]


def next_patch(tag):
    major, minor, patch = parse_tag(tag)
    return f"v{major}.{minor}.{patch + 1}"


def next_minor(tag):
    major, minor, _ = parse_tag(tag)
    return f"v{major}.{minor + 1}.0"


def next_major(tag):
    major, _, _ = parse_tag(tag)
    return f"v{major + 1}.0.0"


def next_version(tag, bump):
    if bump == "patch":
        return next_patch(tag)
    if bump == "minor":
        return next_minor(tag)
    if bump == "major":
        return next_major(tag)
    raise ValueError(f"unknown bump: {bump!r}")


def release_branch(tag):
    return f"release/{tag}-prep"


def unreleased_section(changelog):
    start = UNRELEASED.search(changelog)
    if not start:
        raise ValueError("CHANGELOG.md has no '## [Unreleased]' heading")
    rest = changelog[start.end():]
    end = NEXT_ENTRY.search(rest)
    return rest[: end.start()] if end else rest


def has_release_content(changelog):
    return any(line.strip() and not line.strip().startswith("#")
               for line in unreleased_section(changelog).splitlines())


def has_added_section(changelog):
    """True when `[Unreleased]` carries a '### Added' heading."""
    return bool(ADDED.search(unreleased_section(changelog)))


def bump_decision(has_added, labels=(), major=0, labels_known=True):
    """Return (bump, reason) for the next release, following docs/RELEASING.md."""
    matched = sorted(set(labels) & set(FEATURE_LABELS))
    if "breaking" in matched and major >= 1:
        return ("major", "前回タグ以降に breaking ラベル付きの PR があるため")
    if has_added and matched:
        return ("minor", "[Unreleased] に ### Added があり、前回タグ以降に "
                         + "/".join(matched) + " ラベル付きの PR もあるため")
    if has_added:
        return ("minor", "[Unreleased] に ### Added（利用者に見える追加）があるため")
    if matched:
        return ("minor", "前回タグ以降に " + "/".join(matched)
                         + " ラベル付きの PR があるため")
    if labels_known:
        return ("patch", "[Unreleased] に ### Added が無く、"
                         "feature 系ラベル付きの PR も無いため")
    return ("patch", "[Unreleased] に ### Added（利用者に見える追加）が無いため")


def pr_labels_since(root, tag):
    """Labels of the pull requests merged into main since `tag` (raises on failure).

    The query keeps the 200 most recently merged pull requests, which is more
    than one daily cadence window holds. Merges at or before `tag` are dropped
    again by timestamp, so a same-day tag cannot pull in released labels.
    """
    if shutil.which("gh") is None:
        raise RuntimeError("gh コマンドが見つかりません")
    tagged = subprocess.run(["git", "log", "-1", "--format=%cI", tag],
                            cwd=root, check=True, text=True,
                            capture_output=True).stdout.strip()
    if not tagged:
        raise RuntimeError(f"{tag} のコミット日時を取得できません")
    since = datetime.fromisoformat(tagged.replace("Z", "+00:00"))
    listed = subprocess.run(
        ["gh", "pr", "list", "--state", "merged", "--base", "main",
         "--limit", "200", "--search", f"merged:>={since.date().isoformat()}",
         "--json", "mergedAt,labels"],
        cwd=root, check=True, text=True, capture_output=True)
    labels = set()
    for pull in json.loads(listed.stdout or "[]"):
        merged = pull.get("mergedAt")
        if not merged or datetime.fromisoformat(
                merged.replace("Z", "+00:00")) <= since:
            continue
        labels.update(label["name"] for label in pull.get("labels") or [])
    return labels


def resolve_bump(changelog, latest, labels=None):
    """Return (bump, reason, next_tag) shared by plan and promote."""
    bump, reason = bump_decision(has_added_section(changelog),
                                 () if labels is None else labels,
                                 parse_tag(latest)[0], labels is not None)
    return bump, reason, next_version(latest, bump)


def changelog_entries(body):
    entries = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            entries.append(stripped[2:].strip())
    return entries


def bump_manifest(root, version):
    path = root / "Cargo.toml"
    text = path.read_text(encoding="utf-8")
    current = tomllib.loads(text)["package"]["version"]
    if current == version:
        return current
    path.write_text(text.replace(f'version = "{current}"',
                                 f'version = "{version}"', 1), encoding="utf-8")
    return current


def bump_lock(root, version):
    path = root / "Cargo.lock"
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    named = False
    for index, line in enumerate(lines):
        if line.startswith("[[package]]"):
            named = False
        elif line.startswith('name = "rdsh"'):
            named = True
        elif named and line.startswith("version = "):
            lines[index] = f'version = "{version}"' + chr(10)
            path.write_text("".join(lines), encoding="utf-8")
            return
    raise ValueError('Cargo.lock has no version for package "rdsh"')


def promote_changelog(root, version, day):
    path = root / "CHANGELOG.md"
    text = path.read_text(encoding="utf-8")
    start = UNRELEASED.search(text)
    if not start:
        raise ValueError("CHANGELOG.md has no '## [Unreleased]' heading")
    rest = text[start.end():]
    end = NEXT_ENTRY.search(rest)
    body = (rest[: end.start()] if end else rest).strip(chr(10))
    if not body:
        raise ValueError("[Unreleased] has no entries to release")
    tail = rest[end.start():] if end else ""
    blank = chr(10) * 2
    path.write_text(f"{text[: start.start()]}## [Unreleased]{blank}"
                    f"## [{version}] - {day}{blank}{body}{blank}{tail}",
                    encoding="utf-8")
    return changelog_entries(body)


def notes_skeleton(root, tag, previous, entries, bump, reason):
    changes = chr(10).join(f"- {entry}" for entry in entries)
    if not changes:
        changes = "- CHANGELOG.md の該当バージョンの節を参照してください。"
    path = root / "docs" / "releases" / f"{tag}.md"
    path.write_text(NOTES.format(version=tag[1:], previous=previous,
                                 changes=changes, bump=bump, reason=reason),
                    encoding="utf-8")
    return path


def plan(root, github_output=None, labels=None, query_labels=False):
    tags = subprocess.run(["git", "tag", "--list"], cwd=root, check=True,
                          text=True, capture_output=True).stdout.split()
    latest = latest_stable(tags)
    label_state = "ok" if labels is not None else "unavailable"
    if query_labels:
        try:
            labels = pr_labels_since(root, latest)
            label_state = "ok"
        except (OSError, RuntimeError, subprocess.SubprocessError,
                json.JSONDecodeError) as error:
            labels = None
            label_state = f"unavailable: {error}"
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    bump, reason, next_tag = resolve_bump(changelog, latest, labels)
    if labels is None:
        reason += "（PR ラベルは未取得のため CHANGELOG 判定のみ）"
    values = {
        "latest": latest,
        "next": next_tag,
        "bump": bump,
        "reason": reason,
        "labels": label_state,
        "branch": release_branch(next_tag),
        "unreleased": "pending" if has_release_content(changelog) else "empty",
    }
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as stream:
            stream.write("".join(f"{key}={value}" + chr(10)
                                 for key, value in values.items()))
    return values


def promote(root, tag, previous=None, day=None, bump=None, reason=None):
    parse_tag(tag)
    current = tomllib.loads((root / "Cargo.toml").read_text(
        encoding="utf-8"))["package"]["version"]
    previous = previous or f"v{current}"
    if previous != f"v{current}":
        raise ValueError(f"--previous-tag must be v{current} for the current tree")
    day = day or date_type.today().isoformat()
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    derived, derived_reason, _ = resolve_bump(changelog, f"v{current}")
    bump = bump or derived
    reason = reason or derived_reason
    bump_manifest(root, tag[1:])
    bump_lock(root, tag[1:])
    entries = promote_changelog(root, tag[1:], day)
    return notes_skeleton(root, tag, previous, entries, bump, reason)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "promote"))
    parser.add_argument("tag", nargs="?", help="next tag for promote")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--previous-tag", help="released tag the notes compare from")
    parser.add_argument("--date", help="release date for the CHANGELOG entry")
    parser.add_argument("--bump", choices=("patch", "minor", "major"),
                        help="bump recorded in the notes; derived when omitted")
    parser.add_argument("--reason", help="one-line reason recorded in the notes")
    parser.add_argument("--query-pr-labels", action="store_true",
                        help="ask gh for feature/enhancement/breaking labels merged since the latest tag")
    parser.add_argument("--github-output", help="append plan values to this file")
    args = parser.parse_args()
    try:
        if args.command == "plan":
            values = plan(args.root, args.github_output,
                          query_labels=args.query_pr_labels)
            for key, value in values.items():
                print(f"{key}={value}")
            if args.query_pr_labels and values["labels"].startswith("unavailable"):
                print(f"::warning::PR ラベルを取得できませんでした"
                      f"（{values['labels']}）。CHANGELOG.md の [Unreleased]"
                      " 判定のみで版を決めました。")
        else:
            if not args.tag:
                parser.error("promote requires a tag")
            notes = promote(args.root, args.tag, args.previous_tag, args.date,
                            args.bump, args.reason)
            print(f"prepared {args.tag}: {notes.relative_to(args.root)}")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"release cadence failed: {error}" + chr(10))


if __name__ == "__main__":
    main()

