#!/usr/bin/env python3
"""Compare rdsh native fast paths with equivalent Node.js scripts.

Two measurements run on generated fixtures only; no user data, sessions,
credentials or model calls are read:

* hook   -- PreToolUse hook cost: the native 'rdsh guard' process versus an
            equivalent Node.js judge process, including process launch and
            accumulated over a simulated tool-call sequence.
* native -- 'rdsh tokens' and 'rdsh search' versus the same algorithms
            implemented in Node.js on one fixed dataset.

Upstream 'dsh' exposes no 'tokens' or 'search' subcommand, so this harness never
invents an upstream product ratio. Pass --dsh PATH to record that absence
explicitly in the report.

Examples:
  python3 scripts/benchmark-node-vs-rust.py --bin ./target/release/rdsh \
      --mode all --output /tmp/rdsh-node-vs-rust.json
  python3 scripts/benchmark-node-vs-rust.py --bin ./target/release/rdsh --mode hook
"""

import argparse
import hashlib
import json
import math
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

WARMUPS = 3
REFERENCE_SCRIPT = Path(__file__).with_name("benchmark-node-reference.mjs")

HOOK_DENY_GLOB = "rm -rf /*"
HOOK_CREDENTIAL_GLOB = "*.credentials.yaml*"

ALLOW_PAYLOAD = (
    b'{"cwd":"/tmp","tool_name":"Bash","tool_input":'
    b'{"description":"List files","command":"ls -la /tmp"}}'
)
DENY_PAYLOAD = (
    b'{"cwd":"/tmp","tool_name":"Bash","tool_input":'
    b'{"description":"Clean root","command":"rm -rf / --no-preserve-root"}}'
)
CREDENTIAL_PAYLOAD = (
    b'{"cwd":"/tmp","tool_name":"Bash","tool_input":'
    b'{"command":"cat ~/.credentials.yaml"}}'
)
MALFORMED_PAYLOAD = b"{broken"

# name, stdin payload, expected decision, JSON adapter mode
HOOK_CASES = [
    ("allow_bash", ALLOW_PAYLOAD, "allow", False),
    ("deny_bash", DENY_PAYLOAD, "block", False),
    ("deny_credential", CREDENTIAL_PAYLOAD, "block", False),
    ("malformed_input", MALFORMED_PAYLOAD, "block", False),
    ("json_allow", ALLOW_PAYLOAD, "allow", True),
    ("json_deny", DENY_PAYLOAD, "block", True),
]


def spawn(argv, env, stdin=b"", timeout=180):
    started = time.perf_counter_ns()
    result = subprocess.run(
        argv, input=stdin, env=env, capture_output=True, timeout=timeout
    )
    return (time.perf_counter_ns() - started) / 1e6, result


def describe(samples):
    ordered = sorted(samples)
    return {
        "median_ms": statistics.median(samples),
        "p95_ms": ordered[math.ceil(len(ordered) * 0.95) - 1],
        "samples_ms": samples,
    }


def peak_rss_bytes(argv, env, stdin=b""):
    if platform.system() != "Linux" or not Path("/usr/bin/time").exists():
        return None
    result = subprocess.run(
        ["/usr/bin/time", "-f", "RSS_KIB=%M"] + argv,
        input=stdin,
        env=env,
        capture_output=True,
        timeout=180,
    )
    match = re.search(rb"RSS_KIB=(\d+)", result.stderr)
    if not match:
        return None
    return int(match.group(1)) * 1024


def isolated_env(root):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(("RDSH_", "DSH_")) or key in {
            "DEEPSEEK_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "SEARXNG_URL",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "NODE_COMPILE_CACHE",
        }:
            env.pop(key)
    env.update(
        HOME=str(root),
        USERPROFILE=str(root),
        DSH_HOME=str(root / "dsh"),
        XDG_DATA_HOME=str(root / "data"),
        XDG_CONFIG_HOME=str(root / "config"),
        XDG_CACHE_HOME=str(root / "cache"),
    )
    (root / "dsh").mkdir(exist_ok=True)
    return env


def guard_decision(result, json_mode):
    if json_mode:
        try:
            decoded = json.loads(result.stdout.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return "invalid-json-output"
        if isinstance(decoded, dict) and decoded.get("decision") == "block":
            return "block"
        return "allow"
    return "block" if result.returncode == 2 else "allow"


def matched_pattern(result):
    text = result.stderr.decode("utf-8", "replace")
    for line in text.splitlines():
        marker = "pattern hit: "
        if marker in line:
            return line.split(marker, 1)[1].strip()
    return None

def hook_argv(rdsh, node, json_mode):
    common = ["--deny", HOOK_DENY_GLOB, "--deny", HOOK_CREDENTIAL_GLOB, "--language", "en"]
    if json_mode:
        common.append("--json")
    return [str(rdsh), "guard", *common], [str(node), str(REFERENCE_SCRIPT), "guard", *common]


def measure_hook(rdsh, node, env, n, calls, deny_percent):
    report = {"correctness": [], "cumulative": None, "peak_rss_bytes": {}}

    for name, payload, expected, json_mode in HOOK_CASES:
        rdsh_argv, node_argv = hook_argv(rdsh, node, json_mode)
        _, rdsh_result = spawn(rdsh_argv, env, payload)
        _, node_result = spawn(node_argv, env, payload)
        rdsh_decision = guard_decision(rdsh_result, json_mode)
        node_decision = guard_decision(node_result, json_mode)
        entry = {
            "expected": expected,
            "stdin_bytes": len(payload),
            "json_adapter": json_mode,
            "rdsh_exit": rdsh_result.returncode,
            "node_exit": node_result.returncode,
            "rdsh_decision": rdsh_decision,
            "node_decision": node_decision,
            "decisions_equal": rdsh_decision == node_decision == expected,
            "rdsh_pattern": matched_pattern(rdsh_result),
            "node_pattern": matched_pattern(node_result),
        }
        if not json_mode:
            entry["patterns_equal"] = entry["rdsh_pattern"] == entry["node_pattern"]
        report["correctness"].append({"case": name, **entry})

    samples = {"cases": {}}
    for name, payload, expected, json_mode in HOOK_CASES:
        rdsh_argv, node_argv = hook_argv(rdsh, node, json_mode)
        for _ in range(WARMUPS):
            spawn(rdsh_argv, env, payload)
            spawn(node_argv, env, payload)
        measurements = {"rdsh": [], "node": []}
        for iteration in range(n):
            order = ["rdsh", "node"] if iteration % 2 == 0 else ["node", "rdsh"]
            for side in order:
                argv = rdsh_argv if side == "rdsh" else node_argv
                elapsed, result = spawn(argv, env, payload)
                if guard_decision(result, json_mode) != expected:
                    raise RuntimeError(f"unexpected {name} decision from {side}")
                measurements[side].append(round(elapsed, 4))
        entry = {
            "stdin_bytes": len(payload),
            "json_adapter": json_mode,
            "rdsh": describe(measurements["rdsh"]),
            "node": describe(measurements["node"]),
        }
        entry["ratio"] = statistics.median(measurements["node"]) / statistics.median(
            measurements["rdsh"]
        )
        samples["cases"][name] = entry

    # Accumulated cost over a simulated tool-call sequence: most calls pass,
    # a configurable minority is denied, exactly as a real hook sees them.
    rdsh_samples, node_samples = [], []
    rdsh_argv, node_argv = hook_argv(rdsh, node, False)
    for iteration in range(calls):
        denied = (iteration * deny_percent) % 100 < deny_percent
        payload = DENY_PAYLOAD if denied else ALLOW_PAYLOAD
        expected = "block" if denied else "allow"
        order = ["rdsh", "node"] if iteration % 2 == 0 else ["node", "rdsh"]
        for side in order:
            argv = rdsh_argv if side == "rdsh" else node_argv
            elapsed, result = spawn(argv, env, payload)
            if guard_decision(result, False) != expected:
                raise RuntimeError(f"unexpected cumulative decision from {side}")
            (rdsh_samples if side == "rdsh" else node_samples).append(elapsed)
    rdsh_total = sum(rdsh_samples)
    node_total = sum(node_samples)
    report["cumulative"] = {
        "calls": calls,
        "deny_percent": deny_percent,
        "process_launch_included": True,
        "rdsh": {
            **describe([round(value, 4) for value in rdsh_samples]),
            "total_ms": rdsh_total,
            "ms_per_1000_calls": rdsh_total / calls * 1000,
        },
        "node": {
            **describe([round(value, 4) for value in node_samples]),
            "total_ms": node_total,
            "ms_per_1000_calls": node_total / calls * 1000,
        },
        "delta_ms": node_total - rdsh_total,
        "ratio": node_total / rdsh_total,
        "stack_of_calls": "one process per tool call, alternating order",
    }

    allow_argv, _ = hook_argv(rdsh, node, False)
    node_allow_argv = [str(node), str(REFERENCE_SCRIPT), "guard", "--deny", HOOK_DENY_GLOB, "--language", "en"]
    report["peak_rss_bytes"] = {
        "case": "allow_bash",
        "rdsh": peak_rss_bytes(allow_argv, env, ALLOW_PAYLOAD),
        "node": peak_rss_bytes(node_allow_argv, env, ALLOW_PAYLOAD),
    }
    report["samples"] = samples
    return report


def token_count_from_stdout(stdout):
    match = re.search(rb"(\d+)", stdout)
    if not match:
        raise RuntimeError("tokens output has no count")
    return int(match.group(1))


def search_hits_from_stdout(stdout):
    # rdsh walks the directory in raw readdir order while Node's scandir sorts
    # names, so equal result *sets* are the oracle, not line order. The hit cap
    # must exceed the fixture's total hit count or the two orders select
    # different subsets.
    return sorted(stdout.decode("utf-8", "replace").splitlines())


def measure_native(rdsh, node, env, n, fixtures):
    report = {"cases": {}, "correctness": []}
    cases = [
        (
            "tokens_10mib_ascii",
            [str(rdsh), "tokens", str(fixtures["ascii"]), "--language", "en"],
            [str(node), str(REFERENCE_SCRIPT), "tokens", str(fixtures["ascii"])],
            token_count_from_stdout,
            {"bytes": fixtures["ascii"].stat().st_size},
        ),
        (
            "tokens_cjk",
            [str(rdsh), "tokens", str(fixtures["cjk"]), "--language", "en"],
            [str(node), str(REFERENCE_SCRIPT), "tokens", str(fixtures["cjk"])],
            token_count_from_stdout,
            {"bytes": fixtures["cjk"].stat().st_size},
        ),
        (
            "search_300_files",
            [
                str(rdsh), "search", "needle", "--dir", str(fixtures["tree"]),
                "--max", "2000", "--language", "en",
            ],
            [
                str(node), str(REFERENCE_SCRIPT), "search", "needle",
                "--dir", str(fixtures["tree"]), "--max", "2000",
            ],
            search_hits_from_stdout,
            {"files": 300, "lines": 600000, "hits": 1200, "hit_limit": 2000},
        ),
    ]
    for name, rdsh_argv, node_argv, parse, workload in cases:
        _, rdsh_result = spawn(rdsh_argv, env)
        _, node_result = spawn(node_argv, env)
        rdsh_value = parse(rdsh_result.stdout)
        node_value = parse(node_result.stdout)
        report["correctness"].append(
            {
                "case": name,
                "rdsh_exit": rdsh_result.returncode,
                "node_exit": node_result.returncode,
                "values_equal": rdsh_value == node_value,
                "rdsh_value": rdsh_value if name.startswith("tokens") else len(rdsh_value),
                "node_value": node_value if name.startswith("tokens") else len(node_value),
            }
        )
        if rdsh_value != node_value:
            raise RuntimeError(f"{name}: rdsh and reference output differ")
        for _ in range(WARMUPS):
            spawn(rdsh_argv, env)
            spawn(node_argv, env)
        measurements = {"rdsh": [], "node": []}
        for iteration in range(n):
            order = ["rdsh", "node"] if iteration % 2 == 0 else ["node", "rdsh"]
            for side in order:
                argv = rdsh_argv if side == "rdsh" else node_argv
                elapsed, result = spawn(argv, env)
                if parse(result.stdout) != rdsh_value:
                    raise RuntimeError(f"{name}: unstable {side} output")
                measurements[side].append(round(elapsed, 4))
        report["cases"][name] = {
            "workload": workload,
            "rdsh": describe(measurements["rdsh"]),
            "node": describe(measurements["node"]),
            "ratio": statistics.median(measurements["node"])
            / statistics.median(measurements["rdsh"]),
        }
    return report


def probe_upstream(dsh):
    """Record whether upstream dsh exposes tokens/search; never invent a ratio."""
    result = subprocess.run(
        [str(dsh), "--help"], capture_output=True, timeout=120
    )
    text = (result.stdout + result.stderr).decode("utf-8", "replace")
    return {
        "path": str(dsh),
        "help_exit": result.returncode,
        "exposes_tokens_subcommand": "tokens" in text,
        "exposes_search_subcommand": "search" in text,
        "equivalent_subcommand_available": False,
        "note": (
            "upstream dsh boots a profile; it has no tokens/search subcommand, "
            "so no upstream product ratio is reported"
        ),
    }


def binary_identity(path):
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return {"path": str(path), "sha256": digest}


def print_table(report):
    if not report.get("hook"):
        print_native_table(report, leading=False)
        return
    print("== PreToolUse hook: rdsh guard vs Node.js judge ==")
    print(f"{'case':<18}{'rdsh median':>14}{'node median':>14}{'ratio':>9}")
    for name, case in report["hook"]["samples"]["cases"].items():
        print(
            f"{name:<18}{case['rdsh']['median_ms']:>12.3f}ms"
            f"{case['node']['median_ms']:>12.3f}ms{case['ratio']:>8.1f}x"
        )
    cumulative = report["hook"]["cumulative"]
    print(
        f"\ncumulative over {cumulative['calls']} simulated tool calls "
        f"({cumulative['deny_percent']}% denied), process launch included:"
    )
    print(
        f"  rdsh guard {cumulative['rdsh']['total_ms']:.1f}ms "
        f"({cumulative['rdsh']['ms_per_1000_calls']:.1f}ms / 1000 calls)"
    )
    print(
        f"  node judge {cumulative['node']['total_ms']:.1f}ms "
        f"({cumulative['node']['ms_per_1000_calls']:.1f}ms / 1000 calls)"
    )
    print(
        f"  delta {cumulative['delta_ms']:.1f}ms "
        f"({cumulative['ratio']:.1f}x cumulative)"
    )
    rss = report["hook"]["peak_rss_bytes"]
    if rss["rdsh"] and rss["node"]:
        print(
            f"  peak RSS (allow_bash): rdsh {rss['rdsh'] / 1048576:.2f}MiB | "
            f"node {rss['node'] / 1048576:.2f}MiB"
        )
    print_native_table(report)


def print_native_table(report, leading=True):
    if not report.get("native"):
        return
    print(("\n" if leading else "") + "== Native commands: rdsh vs Node.js reference ==")
    print(f"{'case':<18}{'rdsh median':>14}{'node median':>14}{'ratio':>9}")
    for name, case in report["native"]["cases"].items():
        print(
            f"{name:<18}{case['rdsh']['median_ms']:>12.3f}ms"
            f"{case['node']['median_ms']:>12.3f}ms{case['ratio']:>8.1f}x"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin", required=True, type=Path, help="rdsh binary to measure")
    parser.add_argument("--node", default="node", help="node executable (default: node)")
    parser.add_argument("--mode", choices=["hook", "native", "all"], default="all")
    parser.add_argument("--n", type=int, default=15, help="samples per case (min 5)")
    parser.add_argument("--calls", type=int, default=200, help="simulated hook tool calls")
    parser.add_argument("--deny-percent", type=int, default=10, help="denied share of hook calls")
    parser.add_argument("--dsh", type=Path, help="optional upstream dsh path to probe")
    parser.add_argument("--output", type=Path, help="write the JSON report here")
    args = parser.parse_args()
    if args.n < 5:
        parser.error("--n must be at least 5")
    if args.calls < 1:
        parser.error("--calls must be at least 1")
    if not 0 <= args.deny_percent <= 100:
        parser.error("--deny-percent must be between 0 and 100")
    if not args.bin.exists():
        parser.error(f"--bin {args.bin} does not exist")
    node = shutil.which(args.node) if not Path(args.node).exists() else str(Path(args.node).resolve())
    if node is None:
        parser.error(
            f"--node {args.node!r} not found; the Node.js reference is required. "
            "No upstream dsh binary is needed."
        )
    if args.dsh and not args.dsh.exists():
        parser.error(f"--dsh {args.dsh} does not exist")

    report = {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "system": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "n": args.n,
        "warmups": WARMUPS,
        "timing": "parent wall clock, includes process launch",
        "scope": "synthetic fixtures and hook payloads; no user data or model calls",
        "binaries": {"rdsh": binary_identity(args.bin)},
        "node": None,
        "upstream_dsh": None,
        "hook": None,
        "native": None,
    }
    if node is not None:
        version = subprocess.run([node, "--version"], capture_output=True, timeout=60)
        report["node"] = {
            "path": node,
            "version": version.stdout.decode().strip(),
            "reference_script": str(REFERENCE_SCRIPT),
            "reference_sha256": hashlib.sha256(REFERENCE_SCRIPT.read_bytes()).hexdigest(),
        }
    if args.dsh:
        report["upstream_dsh"] = probe_upstream(args.dsh)

    with tempfile.TemporaryDirectory(prefix="rdsh-node-vs-rust-") as tmp:
        root = Path(tmp)
        env = isolated_env(root)
        if args.mode in ("hook", "all"):
            report["hook"] = measure_hook(
                args.bin, node, env, args.n, args.calls, args.deny_percent
            )
        if args.mode in ("native", "all"):
            ascii_file = root / "ascii.txt"
            ascii_file.write_bytes(b"abcd " * (2 * 1024 * 1024))
            cjk_file = root / "cjk.txt"
            cjk_file.write_text("日本語の文脈 Rust text\n" * 50000, encoding="utf-8")
            tree = root / "search"
            tree.mkdir()
            for index in range(300):
                (tree / f"{index:03}.txt").write_text(
                    "".join(
                        "needle\n" if row % 500 == 0 else "ordinary text line\n"
                        for row in range(2000)
                    )
                )
            fixtures = {"ascii": ascii_file, "cjk": cjk_file, "tree": tree}
            report["native"] = measure_native(args.bin, node, env, args.n, fixtures)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print_table(report)
    if args.output:
        print(f"\nreport: {args.output}")


if __name__ == "__main__":
    main()
