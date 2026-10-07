#!/usr/bin/env python3
"""Benchmark synthetic rdsh workloads without reading user data or credentials."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


def run(command, env):
    started = time.perf_counter_ns()
    result = subprocess.run(command, env=env, capture_output=True, check=True, timeout=60)
    return (time.perf_counter_ns() - started) / 1e6, result.stdout


def rss(command, env):
    if platform.system() == "Darwin":
        prefix, pattern, scale = ["/usr/bin/time", "-l"], rb"(\d+)\s+maximum resident set size", 1
    elif platform.system() == "Linux" and Path("/usr/bin/time").exists():
        prefix, pattern, scale = ["/usr/bin/time", "-f", "RSS_KIB=%M"], rb"RSS_KIB=(\d+)", 1024
    else:
        return None
    result = subprocess.run(prefix + command, env=env, capture_output=True, check=True, timeout=60)
    match = re.search(pattern, result.stderr)
    if not match:
        raise RuntimeError("time did not report peak RSS")
    return int(match.group(1)) * scale


def describe(samples):
    ordered = sorted(samples)
    return {
        "median_ms": statistics.median(samples),
        "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
        "samples_ms": samples,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin", required=True, type=Path)
    parser.add_argument("--baseline", type=Path, help="before-change rdsh binary")
    parser.add_argument("--dsh", type=Path, help="optional original dsh; runs --version only")
    parser.add_argument("--n", type=int, default=15)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.n < 5:
        parser.error("--n must be at least 5")
    binaries = {"candidate": str(args.bin.resolve())}
    if args.baseline:
        binaries["baseline"] = str(args.baseline.resolve())
    report = {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "system": platform.platform(), "machine": platform.machine(), "cpu_count": os.cpu_count(),
        "n": args.n, "warmups": 3, "timing": "parent wall clock, includes process launch",
        "scope": "synthetic CLI workloads; no Desktop startup or model calls",
        "binaries": {}, "cases": {},
    }
    for label, binary in binaries.items():
        report["binaries"][label] = {"sha256": hashlib.sha256(Path(binary).read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory(prefix="rdsh-benchmark-") as tmp:
        root = Path(tmp)
        env = os.environ.copy()
        for key in list(env):
            if key.startswith(("RDSH_", "DSH_")) or key in {
                "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SEARXNG_URL",
                "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "NODE_COMPILE_CACHE",
            }:
                env.pop(key)
        env.update(HOME=tmp, USERPROFILE=tmp, DSH_HOME=str(root / "dsh"),
                   XDG_DATA_HOME=str(root / "data"), XDG_CONFIG_HOME=str(root / "config"),
                   XDG_CACHE_HOME=str(root / "cache"))
        (root / "dsh").mkdir()
        ascii_file = root / "ascii.txt"
        ascii_file.write_bytes(b"abcd " * (2 * 1024 * 1024))
        cjk_file = root / "cjk.txt"
        cjk_file.write_text("日本語の文脈 Rust text\n" * 50000, encoding="utf-8")
        search_dir = root / "search"
        search_dir.mkdir()
        for index in range(300):
            (search_dir / f"{index:03}.txt").write_text(
                "".join("needle\n" if row % 500 == 0 else "ordinary text line\n" for row in range(2000))
            )
        cases = {
            "version": (["--version"], {"operation": "native startup"}),
            "tokens_ascii": (["tokens", str(ascii_file)], {"bytes": ascii_file.stat().st_size}),
            "tokens_cjk": (["tokens", str(cjk_file)], {"bytes": cjk_file.stat().st_size}),
            "search": (["search", "needle", "--dir", str(search_dir), "--max", "100"],
                       {"files": 300, "lines": 600000, "hit_limit": 100}),
            "prune": (["prune", "--max-tokens", "4000", str(cjk_file)],
                      {"bytes": cjk_file.stat().st_size, "budget": 4000}),
        }
        if shutil.which("zstd"):
            source = root / "session.txt"
            source.write_bytes(b"a" * (1024 * 1024))
            compressed = subprocess.check_output(["zstd", "-q", "-c", str(source)])
            for index in range(20):
                folder = root / "dsh" / "sessions" / "fixture" / f"session-{index:02}"
                folder.mkdir(parents=True)
                (folder / "messages.jsonl.zstd").write_bytes(compressed)
                os.utime(folder / "messages.jsonl.zstd", (1700000000 + index, 1700000000 + index))
            cases["sessions_tokens"] = (["sessions", "--limit", "20", "--tokens", "--json"],
                                        {"sessions": 20, "raw_bytes_per_session": 1048576,
                                         "compression": "zstd frames with known content size", "cache": "warm"})
        else:
            report["sessions_skipped"] = "zstd not installed"
        for name, (arguments, workload) in cases.items():
            outputs, samples = {}, {label: [] for label in binaries}
            for label, binary in binaries.items():
                for _ in range(3):
                    _, outputs[label] = run([binary] + arguments, env)
            for iteration in range(args.n):
                # Alternate order to reduce drift from concurrent host load.
                labels = list(binaries)
                if iteration % 2:
                    labels.reverse()
                for label in labels:
                    elapsed, output = run([binaries[label]] + arguments, env)
                    if output != outputs[label]:
                        raise RuntimeError(f"unstable output for {name}/{label}")
                    samples[label].append(elapsed)
            equal = len(set(outputs.values())) == 1
            if not equal:
                raise RuntimeError(f"before/after stdout differs for {name}")
            if name == "sessions_tokens":
                sessions = json.loads(outputs["candidate"])["sessions"]
                if len(sessions) != 20 or any(s["tokens"] != 262144 or not s["tokens_exact"] for s in sessions):
                    raise RuntimeError("session estimates do not match fixture sizes")
            report["cases"][name] = {
                "workload": workload, "stdout_equal": equal,
                "stdout_sha256": hashlib.sha256(outputs["candidate"]).hexdigest(),
                "results": {label: {**describe(values), "peak_rss_bytes": rss([binaries[label]] + arguments, env)}
                            for label, values in samples.items()},
            }
        if args.dsh:
            command = [str(args.dsh.resolve()), "--version"]
            for _ in range(3):
                run(command, env)
            samples = [run(command, env)[0] for _ in range(args.n)]
            report["original_dsh_version"] = {**describe(samples), "peak_rss_bytes": rss(command, env)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({name: {label: round(r["median_ms"], 3) for label, r in case["results"].items()}
                      for name, case in report["cases"].items()}, indent=2))


if __name__ == "__main__":
    main()
