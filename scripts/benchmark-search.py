#!/usr/bin/env python3
"""Compare two rdsh binaries using generated files and an isolated HOME.

Example: python3 scripts/benchmark-search.py /path/to/before target/release/rdsh
No providers, credentials, or network are used. Outputs must match exactly.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import tempfile
import time


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--n", type=int, default=10)
    parser.add_argument("--cpus", type=int, help="Linux CPU affinity width")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.n < 1 or (args.cpus is not None and args.cpus < 1):
        parser.error("n and cpus must be positive")
    if args.cpus:
        os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:args.cpus])
    binaries = {"before": args.before.resolve(), "after": args.after.resolve()}
    cpu = "unknown"
    if Path("/proc/cpuinfo").exists():
        cpu = next((line.split(":", 1)[1].strip() for line in
                    Path("/proc/cpuinfo").read_text().splitlines()
                    if line.startswith("model name")), cpu)
    report = {"os": platform.platform(), "cpu": cpu, "n": args.n,
              "warmups_per_binary": 2, "order": "alternating before/after",
              "affinity_cpus": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
              "binaries_sha256": {key: sha256(path.read_bytes()) for key, path in binaries.items()},
              "cases": {}, "compatibility": []}
    with tempfile.TemporaryDirectory(prefix="rdsh-search-benchmark-") as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir()
        env = {"HOME": str(home), "DSH_HOME": str(home / "dsh"), "PATH": "/usr/bin:/bin"}

        def run(binary, command, rss=False):
            argv = [str(binary), "search", *command]
            if rss:
                argv = ["/usr/bin/time", "-f", "%M", "-o", str(root / "rss"), *argv]
            start = time.perf_counter()
            result = subprocess.run(argv, cwd=root, env=env, capture_output=True, check=True, timeout=30)
            return result.stdout, result.stderr, (time.perf_counter() - start) * 1000

        for case, count, lines, matching, depth in [
            ("dense", 160, 6000, True, 0), ("sparse", 1500, 40, False, 0),
            ("deep", 800, 40, False, 5), ("mixed", 160, 1000, True, 2),
        ]:
            directory = root / case
            directory.mkdir()
            for i in range(count):
                parent = directory
                for level in range(depth):
                    parent /= f"d{level}-{i % 4}"
                parent.mkdir(parents=True, exist_ok=True)
                marker = "DUMMY_MATCH" if matching and (case != "mixed" or i % 13 == 0) else "dummy_ordinary"
                (parent / f"{i:05}.txt").write_text((marker + " generated benchmark line\n") * lines)
            command = ["DUMMY_MATCH", "--dir", case, "--max", "10"]
            expected = run(binaries["before"], command)[:2]
            measurements = {name: [] for name in binaries}
            for binary in binaries.values():
                for _ in range(2):
                    assert run(binary, command)[:2] == expected
            for iteration in range(args.n):
                order = list(binaries) if iteration % 2 == 0 else list(reversed(binaries))
                for name in order:
                    out, err, elapsed = run(binaries[name], command)
                    assert (out, err) == expected, (case, name, "output changed")
                    measurements[name].append(round(elapsed, 3))
            result = {"files": count, "lines_per_file": lines, "depth": depth,
                      "max": 10, "output_equal": True,
                      "stdout": expected[0].decode(), "stderr": expected[1].decode()}
            for name, binary in binaries.items():
                assert run(binary, command, rss=True)[:2] == expected
                result[name] = {"samples_ms": measurements[name],
                                "median_ms": round(statistics.median(measurements[name]), 3),
                                "peak_rss_kib": int((root / "rss").read_text().strip())}
            report["cases"][case] = result

        # Exercise both sides of the parallel threshold, limits, truncation,
        # Unicode, CRLF, excluded trees, oversized/binary files, and link/FIFO denial.
        outside = root / "outside.txt"
        outside.write_text("DUMMY_SECRET_MATCH\n")
        for count in [1, 31, 32, 65]:
            case = f"compat-{count}"
            directory = root / case
            directory.mkdir()
            for i in range(count):
                (directory / f"{i}.txt").write_bytes(("日本語 MATCH\r\nordinary\r\n" + "MATCH " + "あ" * 250 + "\n").encode())
            (directory / "binary").write_bytes(b"MATCH\xff")
            (directory / "large").write_bytes(b"MATCH" * 400001)
            (directory / ".hidden-dir").mkdir()
            (directory / ".hidden-dir" / "ignored").write_text("MATCH\n")
            (directory / "target").mkdir()
            (directory / "target" / "ignored").write_text("MATCH\n")
            if hasattr(os, "symlink"):
                (directory / "link").symlink_to(outside)
                os.link(outside, directory / "hardlink")
                os.mkfifo(directory / "fifo")
            for pattern in ["MATCH", "日本語", "", "DUMMY_SECRET_MATCH"]:
                for limit in [0, 1, 17, 1000]:
                    command = [pattern, "--dir", case, "--max", str(limit)]
                    before = run(binaries["before"], command)[:2]
                    after = run(binaries["after"], command)[:2]
                    assert before == after, (case, pattern, limit, "output changed")
                    assert b"DUMMY_SECRET_MATCH" not in after[0]
                    report["compatibility"].append({"files": count, "pattern": pattern, "max": limit,
                                                    "output_equal": True, "stdout_sha256": sha256(after[0]),
                                                    "stderr_sha256": sha256(after[1])})
    text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(json.dumps({case: {name: value[name] for name in binaries}
                      for case, value in report["cases"].items()}, indent=2))
    print(f"Output equality: 4 performance cases and {len(report['compatibility'])} compatibility cases")


if __name__ == "__main__":
    main()
