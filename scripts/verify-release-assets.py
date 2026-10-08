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
        digest = hashlib.sha256()
        with archive.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != fields[0].lower():
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
    arguments = parser.parse_args()
    verify(arguments.directory)
    print("Verified 5 binary archives, 5 checksums and 2 installers")
