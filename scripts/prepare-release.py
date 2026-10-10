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


def without_shell_comment(command):
    quote = None
    escaped = False
    index = 0
    while index < len(command):
        char = command[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if quote == "'":
            if char == "'":
                if index + 1 < len(command) and command[index + 1] == "'":
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if quote == '"':
            if char == "\\":
                escaped = True
            elif char == '"':
                quote = None
            index += 1
            continue
        if char == "\\":
            escaped = True
        elif char in "'\"":
            quote = char
        elif char == "#" and (
            index == 0
            or command[index - 1].isspace()
            or command[index - 1] in ";|&"
        ):
            return command[:index]
        index += 1
    return command


def without_powershell_comments(code):
    """Remove PowerShell comments without interpreting comment markers in strings."""
    output = []
    quote = None
    in_block_comment = False
    index = 0
    while index < len(code):
        char = code[index]
        if in_block_comment:
            if code.startswith("#>", index):
                in_block_comment = False
                output.append(" ")
                index += 2
            else:
                if char in "\r\n":
                    output.append(char)
                index += 1
            continue
        if quote == "'":
            output.append(char)
            if char == "'":
                if index + 1 < len(code) and code[index + 1] == "'":
                    output.append(code[index + 1])
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if quote == '"':
            output.append(char)
            if char == "`" and index + 1 < len(code):
                output.append(code[index + 1])
                index += 2
                continue
            if char == '"':
                quote = None
            index += 1
            continue
        if char in "'\"":
            quote = char
            output.append(char)
            index += 1
            continue
        previous_is_boundary = (
            index == 0
            or code[index - 1].isspace()
            or code[index - 1] in ";|&(),{}[]"
        )
        if code.startswith("<#", index) and previous_is_boundary:
            in_block_comment = True
            output.append(" ")
            index += 2
            continue
        if char == "#" and previous_is_boundary:
            while index < len(code) and code[index] not in "\r\n":
                index += 1
            continue
        output.append(char)
        index += 1
    return "".join(output)


def command_pipelines(code, powershell=False):
    """Split simple documented commands while preserving quoted arguments."""
    pipelines = []
    pipeline = []
    command = []
    word = []
    quote = None
    index = 0

    def line_continuation_end(position):
        if position + 1 >= len(code) or code[position + 1] not in "\r\n":
            return None
        if code[position + 1] == "\r" and position + 2 < len(code) and code[position + 2] == "\n":
            return position + 3
        return position + 2

    def finish_word():
        if word:
            command.append("".join(word))
            word.clear()

    def finish_command():
        finish_word()
        if command:
            pipeline.append(command.copy())
            command.clear()

    def finish_pipeline():
        finish_command()
        if pipeline:
            pipelines.append(pipeline.copy())
            pipeline.clear()

    while index < len(code):
        char = code[index]
        if quote is not None:
            if powershell and quote == "'" and code.startswith("''", index):
                word.append("'")
                index += 2
            elif char == quote:
                quote = None
                index += 1
            elif ((powershell and quote == '"' and char == "`")
                  or (not powershell and quote == '"' and char == "\\")) and index + 1 < len(code):
                continuation_end = line_continuation_end(index)
                if continuation_end is not None:
                    index = continuation_end
                else:
                    word.append(code[index + 1])
                    index += 2
            else:
                word.append(char)
                index += 1
            continue
        if char in "'\"":
            quote = char
            index += 1
        elif ((powershell and char == "`") or (not powershell and char == "\\")) and index + 1 < len(code):
            continuation_end = line_continuation_end(index)
            if continuation_end is not None:
                index = continuation_end
            else:
                word.append(code[index + 1])
                index += 2
        elif char in "\r\n":
            finish_word()
            # A physical newline terminates a command, except after a pipeline
            # operator where both shells allow the next pipeline stage to continue.
            if command:
                finish_pipeline()
            index += 1
            if char == "\r" and index < len(code) and code[index] == "\n":
                index += 1
        elif char.isspace():
            finish_word()
            index += 1
        elif char in "|;&":
            finish_word()
            operator = code[index:index + 2]
            if operator in ("&&", "||"):
                index += 2
            else:
                operator = char
                index += 1
            if operator == "|":
                finish_command()
            else:
                finish_pipeline()
        else:
            word.append(char)
            index += 1
    if quote is not None:
        raise ValueError("unclosed quote in prerelease installer instructions")
    finish_pipeline()
    return pipelines


def is_installer_file(token, extension):
    normalized = token.replace("\\", "/").lower().rstrip("/")
    return normalized == f"install.{extension}" or normalized.endswith(f"/install.{extension}")


def is_installer_url(token, extension):
    if "://" not in token:
        return False
    path = token.split("?", 1)[0].split("#", 1)[0]
    return is_installer_file(path, extension)


def skip_sudo(tokens):
    index = 1 if tokens and tokens[0] == "sudo" else 0
    while index < len(tokens) and tokens[index] in ("-E", "-H", "-n", "--preserve-env"):
        index += 1
    if index < len(tokens) and tokens[index] in ("-u", "--user"):
        index += 2
    if index < len(tokens) and tokens[index] == "--":
        index += 1
    return index


def unix_installer_arguments(tokens):
    index = skip_sudo(tokens)
    if index >= len(tokens):
        return None
    program = tokens[index].lower()
    if is_installer_file(tokens[index], "sh"):
        return tokens[index + 1:]
    if program in ("sh", "bash"):
        for script_index in range(index + 1, len(tokens)):
            if is_installer_file(tokens[script_index], "sh"):
                before_script = tokens[index + 1:script_index]
                if any(token in ("-c", "--command") or token.startswith("--command=")
                       or (token.startswith("-") and not token.startswith("--")
                           and "c" in token[1:]) for token in before_script):
                    return None
                return tokens[script_index + 1:]
    return None


def stdin_installer_arguments(tokens):
    index = skip_sudo(tokens)
    if index >= len(tokens) or tokens[index].lower() not in ("sh", "bash"):
        return None
    arguments = tokens[index + 1:]
    return arguments if len(arguments) >= 2 and arguments[:2] == ["-s", "--"] else None


def powershell_installer_arguments(tokens):
    if tokens and is_installer_file(tokens[0], "ps1"):
        return tokens[1:]
    return None


def installer_source(tokens, extension, powershell=False):
    if not tokens:
        return False
    if powershell:
        downloader = tokens[0].lower() in ("invoke-webrequest", "invoke-restmethod", "curl", "wget")
        return downloader and any(is_installer_url(token, extension) for token in tokens[1:])
    index = skip_sudo(tokens)
    downloader = tokens[index].lower() in ("curl", "wget") if index < len(tokens) else False
    return downloader and any(is_installer_url(token, extension) for token in tokens[index + 1:])


def has_installer_reference(tokens, extension):
    marker = f"install.{extension}"
    return any(marker in token.lower() for token in tokens)


def unix_version_selectors(arguments):
    return [token.partition("=")[2] for token in arguments if token.startswith("--version=")]


def powershell_version_selectors(arguments):
    return [arguments[index + 1] for index, token in enumerate(arguments[:-1])
            if token.lower() == "-version"]


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
        instructions = re.sub(r"<!--.*?-->", "", authored, flags=re.S)
        snippets = re.findall(r"```([^\n]*)\n(.*?)\n```|`([^`\n]+)`", instructions, re.S)
        unix_commands, windows_commands = [], []
        for language, block, inline in snippets:
            code = re.sub(r"[\\`]\r?\n", " ", block or inline)
            language = language.strip().lower().split(maxsplit=1)[0] if language.strip() else ""
            is_powershell = language in ("powershell", "pwsh", "ps1")
            if not is_powershell:
                is_powershell = re.search(
                    r"(?i)(?:^|[\s;&|])(?:&\s+)?(?:\S*[/\\])?install\.ps1(?:\s|$)", code
                ) is not None
            if is_powershell:
                code = without_powershell_comments(code)
                pipelines = command_pipelines(code, powershell=True)
                for pipeline in pipelines:
                    for index, command in enumerate(pipeline):
                        arguments = powershell_installer_arguments(command)
                        if arguments is not None:
                            windows_commands.append(arguments)
                        elif has_installer_reference(command, "ps1"):
                            if not installer_source(command, "ps1", powershell=True):
                                raise ValueError("unsupported prerelease installer command")
                            if index + 1 < len(pipeline):
                                raise ValueError("unsupported prerelease installer pipeline")
                        elif installer_source(command, "ps1", powershell=True) and index + 1 < len(pipeline):
                            raise ValueError("unsupported prerelease installer pipeline")
            else:
                code = "\n".join(without_shell_comment(line) for line in code.splitlines())
                pipelines = command_pipelines(code)
                for pipeline in pipelines:
                    for index, command in enumerate(pipeline):
                        arguments = unix_installer_arguments(command)
                        if arguments is not None:
                            unix_commands.append(arguments)
                        elif installer_source(command, "sh"):
                            if index + 1 < len(pipeline):
                                arguments = stdin_installer_arguments(pipeline[index + 1])
                                if arguments is None:
                                    raise ValueError("unsupported prerelease installer pipeline")
                                unix_commands.append(arguments)
                        elif has_installer_reference(command, "sh"):
                            raise ValueError("unsupported prerelease installer command")
        for commands, selectors in ((unix_commands, unix_version_selectors),
                                    (windows_commands, powershell_version_selectors)):
            if not commands or any(not (values := selectors(command))
                                   or any(value != tag for value in values)
                                   for command in commands):
                raise ValueError("prerelease installers require --version=TAG and -Version TAG matching this tag")
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
