#!/usr/bin/env python3
"""Refuse incomplete or corrupt release assets before publishing a draft."""
import argparse
import hashlib
from pathlib import Path
import re
import tarfile
import zipfile


ARCHIVES = (
    "rdsh-linux-x64.tar.gz",
    "rdsh-linux-x64-musl.tar.gz",
    "rdsh-macos-arm64.tar.gz",
    "rdsh-macos-x64.tar.gz",
    "rdsh-windows-x64.zip",
)
INSTALLERS = ("install.sh", "install.ps1")


def regular_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"missing or invalid release asset: {path.name}")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def missing_assets(directory, existing):
    """Reuse identical draft assets; fail before upload if any differ."""
    directory, existing = Path(directory), Path(existing)
    verify(directory)
    names = (*ARCHIVES, *(name + ".sha256" for name in ARCHIVES), *INSTALLERS)
    for path in existing.iterdir():
        if path.name not in names:
            raise ValueError(f"unexpected draft asset: {path.name}")
        regular_file(path)
        if sha256_file(path) != sha256_file(directory / path.name):
            raise ValueError(f"draft asset differs; refusing overwrite: {path.name}")
    return [directory.resolve() / name for name in names if not (existing / name).exists()]


def verify(directory):
    directory = Path(directory)
    for name in INSTALLERS:
        regular_file(directory / name)
    for name in ARCHIVES:
        archive = directory / name
        sidecar = directory / (name + ".sha256")
        regular_file(archive)
        regular_file(sidecar)
        if sidecar.stat().st_size > 1024:
            raise ValueError(f"oversized checksum: {sidecar.name}")
        fields = sidecar.read_text(encoding="ascii").split()
        if (len(fields) not in (1, 2)
                or not re.fullmatch(r"[a-fA-F0-9]{64}", fields[0])
                or (len(fields) == 2 and fields[1].lstrip("*") != name)):
            raise ValueError(f"invalid checksum: {sidecar.name}")
        if sha256_file(archive) != fields[0].lower():
            raise ValueError(f"checksum mismatch: {name}")
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as package:
                entries = package.infolist()
                if (len(entries) != 1 or entries[0].filename != "rdsh.exe"
                        or entries[0].is_dir()
                        or (entries[0].external_attr >> 16) & 0o170000 == 0o120000
                        or not 0 < entries[0].file_size <= 64 * 1024 * 1024
                        or package.testzip() is not None):
                    raise ValueError(f"invalid binary archive: {name}")
        else:
            with tarfile.open(archive, "r:gz") as package:
                entries = package.getmembers()
                if (len(entries) != 1 or entries[0].name != "rdsh"
                        or not entries[0].isfile()
                        or not 0 < entries[0].size <= 64 * 1024 * 1024):
                    raise ValueError(f"invalid binary archive: {name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--existing-directory", type=Path)
    parser.add_argument("--missing-output", type=Path)
    arguments = parser.parse_args()
    if bool(arguments.existing_directory) != bool(arguments.missing_output):
        parser.error("--existing-directory and --missing-output must be used together")
    if arguments.existing_directory:
        pending = missing_assets(arguments.directory, arguments.existing_directory)
        arguments.missing_output.write_text("".join(f"{path}\n" for path in pending), encoding="utf-8")
    else:
        verify(arguments.directory)
    print("Verified 5 binary archives, 5 checksums and 2 installers")
