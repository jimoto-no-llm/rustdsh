#!/usr/bin/env python3
"""Compare coding harnesses on the same tasks, prompt and model.

Each task is a directory with a stub solution and a pytest grader. The harness
gets an identical prompt and the same working copy; the grader decides pass or
fail. Nothing here measures output style or subjective quality.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent
TASKS = ROOT / "tasks"

MODEL = "deepseek-v4.1-flash"
MODEL_SPEC = f"opencode-go/{MODEL}"

PROMPT = (
    "You are in a small Python project. Make the test suite pass.\n"
    "Rules:\n"
    "- Only edit solution.py. Never edit anything under tests/.\n"
    "- Run the tests yourself until they pass or you are sure they cannot.\n"
    "- Do not add dependencies. Standard library only.\n"
    "When you are done, reply with DONE."
)


def harness_command(name: str, prompt: str) -> list[str]:
    if name == "dsh":
        return ["dsh", "--profile", "headless", "--patch", str(ROOT / "dsh-patch.yml"), prompt]
    if name == "codex":
        return ["codex", "exec", "--skip-git-repo-check", prompt]
    if name == "opencode":
        return ["opencode", "run", "-m", MODEL_SPEC, prompt]
    raise SystemExit(f"unknown harness: {name}")


def harness_env(name: str) -> dict:
    env = dict(os.environ)
    if name == "codex":
        env["CODEX_HOME"] = str(ROOT / ".codex-home")
    if name == "opencode":
        # Keep the config outside the checkout: opencode resolves its project
        # root from the config location and would otherwise edit the tasks here.
        config = pathlib.Path(tempfile.gettempdir()) / "harness-compare-opencode.json"
        if not config.exists():
            shutil.copyfile(ROOT / "opencode.json", config)
        env["OPENCODE_CONFIG"] = str(config)
    return env


def grade(workdir: pathlib.Path) -> bool:
    # pytest is not guaranteed on the host; grade.py is a dependency-free runner.
    result = subprocess.run(
        [sys.executable, str(ROOT / "grade.py")],
        cwd=workdir, capture_output=True, text=True, timeout=180,
    )
    if os.environ.get("BENCH_VERBOSE"):
        print(result.stdout, result.stderr, file=sys.stderr)
    return result.returncode == 0


def run_one(harness: str, task: pathlib.Path, timeout: int) -> dict:
    with tempfile.TemporaryDirectory(prefix=f"cmp-{harness}-{task.name}-") as tmp:
        workdir = pathlib.Path(tmp) / "project"
        shutil.copytree(task, workdir)
        started = time.monotonic()
        timed_out = False
        try:
            subprocess.run(
                harness_command(harness, PROMPT), cwd=workdir, env=harness_env(harness),
                capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            timed_out = True
        elapsed = round(time.monotonic() - started, 2)
        passed = False if timed_out else grade(workdir)
        return {"task": task.name, "harness": harness, "passed": passed,
                "seconds": elapsed, "timed_out": timed_out}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harness", action="append", choices=["dsh", "codex", "opencode"], required=True)
    parser.add_argument("--task", action="append", help="task directory name; default all")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--out", type=pathlib.Path, default=ROOT / "results.json")
    arguments = parser.parse_args()

    tasks = [TASKS / name for name in arguments.task] if arguments.task else sorted(
        path for path in TASKS.iterdir() if path.is_dir()
    )
    rows = []
    for harness in arguments.harness:
        for task in tasks:
            row = run_one(harness, task, arguments.timeout)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            rows.append(row)
    arguments.out.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
