"""Code-editing comparison on the actual Harness² loop; trusted tests stay private."""
from __future__ import annotations

import argparse
import difflib
from dataclasses import replace
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from harness2.core.spec import BenchPrompts
from rdsh_harness2 import (
    JsonRunner, MAX_FILE_BYTES, MAX_TREE_BYTES, RdshBenchmarkAdapter, compare,
    fingerprint, private_json, private_text, read_harness, safe_relative, strict_json,
)


def load_suite(path: Path) -> dict:
    value = strict_json(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"version", "name", "tasks"}:
        raise ValueError("coding suite requires exactly version/name/tasks")
    if type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["name"], str):
        raise ValueError("invalid coding suite version/name")
    if not isinstance(value["tasks"], list) or not 1 <= len(value["tasks"]) <= 20:
        raise ValueError("coding suite needs 1..20 tasks")
    ids = set()
    required = {"id", "split", "domain", "prompt", "files", "editableFiles", "testFiles", "hiddenTests"}
    for task in value["tasks"]:
        if not isinstance(task, dict) or not required <= task.keys() or task.keys() - required - {"hiddenTestCount"}:
            raise ValueError("invalid coding task fields")
        if not isinstance(task["id"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", task["id"]):
            raise ValueError("unsafe task id")
        if task["id"] in ids or task["split"] not in ("train", "holdout"):
            raise ValueError("duplicate task id or invalid split")
        ids.add(task["id"])
        if not all(isinstance(task[k], str) and task[k] for k in ("domain", "prompt")):
            raise ValueError("coding task domain/prompt required")
        for group in ("files", "hiddenTests"):
            files = task[group]
            if not isinstance(files, dict) or not 1 <= len(files) <= 32:
                raise ValueError("coding files must be a nonempty bounded mapping")
            for name, body in files.items():
                safe_relative(name)
                if not isinstance(body, str) or "\0" in body or len(body.encode()) > MAX_FILE_BYTES:
                    raise ValueError("invalid coding file content")
            if sum(len(body.encode()) for body in files.values()) > MAX_TREE_BYTES:
                raise ValueError("coding file group exceeds byte limit")
        for group in ("editableFiles", "testFiles"):
            paths = task[group]
            if not isinstance(paths, list) or not paths or len(set(paths)) != len(paths):
                raise ValueError("coding editableFiles/testFiles must be nonempty unique lists")
            for name in paths:
                safe_relative(name)
                if name not in task["files"]:
                    raise ValueError("editable/test paths must be initial source files")
        if set(task["editableFiles"]) & set(task["testFiles"]):
            raise ValueError("visible tests cannot be editable")
        if set(task["files"]) & set(task["hiddenTests"]):
            raise ValueError("hidden tests cannot overlap model-visible files")
        if "hiddenTestCount" in task and (type(task["hiddenTestCount"]) is not int or task["hiddenTestCount"] < 1):
            raise ValueError("hiddenTestCount must be a positive integer")
    if not any(t["split"] == "train" for t in value["tasks"]):
        raise ValueError("coding suite needs a training task")
    return value


def snapshot(workspace: Path) -> dict:
    result = {}
    for path in sorted(workspace.rglob("*")):
        name = path.relative_to(workspace).as_posix()
        if path.is_symlink():
            result[name] = {"type": "symlink"}
        elif path.is_file():
            if path.stat().st_size > MAX_FILE_BYTES:
                result[name] = {"type": "oversized"}
            else:
                try:
                    result[name] = path.read_text(encoding="utf-8")
                except UnicodeError:
                    result[name] = {"type": "binary"}
    return result


class CodingGrader:
    def __init__(self, script: Path, node="node"):
        self.command = [node, str(script.resolve())]

    def invoke(self, workspace: Path, test_root: Path, test_files: list, audit: Path, timeout_ms=15000,
               *, source_files: list):
        audit.mkdir(parents=True, exist_ok=False, mode=0o700)
        private_json(audit / "request.json", {"version": 1, "workspace": str(workspace.resolve()),
                     "testRoot": str(test_root.resolve()), "testFiles": test_files,
                     "sourceFiles": source_files, "timeoutMs": timeout_ms})
        started = time.monotonic()
        try:
            process = subprocess.run(self.command + ["--request", str(audit / "request.json"),
                "--response", str(audit / "response.json")], stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=timeout_ms / 1000 + 10, text=True)
            response_path = audit / "response.json"
            if response_path.is_symlink() or not response_path.is_file() or response_path.stat().st_size > 100_000:
                raise ValueError("invalid grader response file")
            os.chmod(response_path, 0o600)
            response = strict_json(response_path.read_text())
            required = {"version", "ok", "passed", "failed", "tests", "exitCode", "sandbox", "timedOut", "wallMs"}
            if not isinstance(response, dict) or not required <= response.keys():
                raise ValueError("invalid grader response fields")
            if response["version"] != 1 or type(response["ok"]) is not bool or type(response["timedOut"]) is not bool:
                raise ValueError("invalid grader status")
            if any(type(response[k]) is not int or response[k] < 0 for k in ("passed", "failed", "tests")):
                raise ValueError("invalid grader counts")
            if response["passed"] + response["failed"] != response["tests"]:
                raise ValueError("inconsistent grader counts")
            if (type(response["wallMs"]) not in (int, float) or not math.isfinite(response["wallMs"])
                    or response["wallMs"] < 0 or not isinstance(response["sandbox"], str)):
                raise ValueError("invalid grader timing/sandbox")
            if response["ok"] and (process.returncode != 0 or response["exitCode"] != 0
                                     or response["timedOut"] or response["failed"] or not response["tests"]
                                     or response.get("outputLimited", False)):
                raise ValueError("grader success disagrees with process or tests")
            return response
        except Exception as exc:
            return {"version": 1, "ok": False, "passed": 0, "failed": 0, "tests": 0,
                    "exitCode": None, "sandbox": "unknown", "timedOut": isinstance(exc, subprocess.TimeoutExpired),
                    "wallMs": (time.monotonic() - started) * 1000, "error": type(exc).__name__}


class CodingBenchmarkAdapter(RdshBenchmarkAdapter):
    def __init__(self, suite: dict, root: Path, runner, grader=None):
        super().__init__(suite, root, runner)
        self.grader = grader or CodingGrader(Path(__file__).resolve().parents[1] / "grade-coding.mjs")
        self.spec = replace(self.spec, prompts=BenchPrompts(
            work="Fix the source implementation and execute the supplied visible tests.",
            domain_word="JavaScript implementation repair",
            yardstick="Correct implementation that satisfies the requested behavior and tests.",
            domain_guidance="Reason about edge cases, preserve tests, edit allowed source, and run tests."))

    def _launch(self, task_ref, install, run_id, timeout):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", run_id):
            raise ValueError("unsafe run id")
        task = self.by_id[task_ref]
        rd = self.spec.runs_root / run_id
        rd.mkdir(parents=True, exist_ok=False, mode=0o700)
        workspace = rd / "workspace"
        shutil.copytree(self.task_files(task_ref), workspace)
        visible_task = {k: v for k, v in task.items() if k not in ("hiddenTests", "hiddenTestCount")}
        private_json(rd / "provenance.json", {"taskId": task_ref, "runId": run_id,
            "harnessSha256": install.fingerprint, "taskSha256": fingerprint(visible_task),
            "model": self.runner.model, "provider": self.runner.provider})
        response = self.runner.invoke("solver", workspace, self.task_prompt(task_ref),
            read_harness(install.staging_dir), rd / "session", run_id,
            coding={"editableFiles": task["editableFiles"], "testFiles": task["testFiles"], "testTimeoutMs": 15000})
        private_json(rd / "result.json", response)
        after = snapshot(workspace)
        changed = sorted(name for name in set(task["files"]) | set(after) if task["files"].get(name) != after.get(name))
        patch = "".join("".join(difflib.unified_diff(
            task["files"].get(name, "").splitlines(keepends=True),
            (after.get(name) if isinstance(after.get(name), str) else "[missing or non-text]\n").splitlines(keepends=True),
            fromfile="before/" + name, tofile="after/" + name)) for name in changed)
        private_text(rd / "changes.patch", patch)
        private_json(rd / "artifact.json", {"files": after, "changedPaths": changed, "sha256": fingerprint(after)})
        return rd

    def _artifact(self, run_dir):
        return strict_json((Path(run_dir) / "artifact.json").read_text())

    def delivered(self, run_dir):
        response = strict_json((Path(run_dir) / "result.json").read_text())
        task_id = strict_json((Path(run_dir) / "provenance.json").read_text())["taskId"]
        artifact = self._artifact(run_dir)
        return response["ok"] and bool(set(artifact["changedPaths"]) & set(self.by_id[task_id]["editableFiles"]))

    def deliverable_text(self, run_dir):
        response = strict_json((Path(run_dir) / "result.json").read_text())
        return response["text"] + "\n\nSource changes:\n" + (Path(run_dir) / "changes.patch").read_text()

    def deliverable_files(self, run_dir):
        task_id = strict_json((Path(run_dir) / "provenance.json").read_text())["taskId"]
        files = {name: body for name, body in self._artifact(run_dir)["files"].items()
                 if name in self.by_id[task_id]["editableFiles"] and isinstance(body, str)}
        files["completion-summary.txt"] = strict_json((Path(run_dir) / "result.json").read_text())["text"]
        return files

    def score(self, run_dir, task_id):
        rd, task = Path(run_dir), self.by_id[task_id]
        cached = rd / "private-score.json"
        if cached.exists():
            return strict_json(cached.read_text())
        response = strict_json((rd / "result.json").read_text())
        artifact = self._artifact(rd)
        after = artifact["files"]
        changed = artifact["changedPaths"]
        source_changed = bool(set(changed) & set(task["editableFiles"]))
        allowed = set(changed) <= set(task["editableFiles"])
        visible_unchanged = all(after.get(name) == task["files"][name] for name in task["testFiles"])
        counts = {"edit": 0, "test": 0, "read": 0}
        for event in response["trace"]:
            if event["type"] == "action":
                for kind in counts:
                    if event.get("name") == "harness2_" + kind:
                        counts[kind] += 1
        # This function is invoked only after upstream selection/adoption has completed.
        # Neither scores nor trusted test files are returned by trajectory/deliverable methods.
        trusted = self.root / "trusted-tests" / task_id
        if not trusted.exists():
            trusted.mkdir(parents=True, mode=0o700)
            for name, body in task["hiddenTests"].items():
                private_text(trusted / name, body)
        visible = self.grader.invoke(rd / "workspace", rd / "workspace", task["testFiles"],
                                    rd / "grade-visible", source_files=list(task["editableFiles"]))
        hidden = self.grader.invoke(rd / "workspace", trusted, list(task["hiddenTests"]),
                                   rd / "grade-hidden", source_files=list(task["editableFiles"]))
        expected_count = task.get("hiddenTestCount")
        hidden_complete = hidden["ok"] and hidden["tests"] > 0 and (
            expected_count is None or hidden["tests"] == expected_count)
        passed = bool(response["ok"] and source_changed and allowed and visible_unchanged
                      and counts["edit"] and counts["test"] and visible["ok"] and hidden_complete)
        score = {"passed": passed, "completed": response["ok"], "nativeCompleted": response["ok"],
                 "sourceChanged": source_changed, "allowedChanges": allowed,
                 "visibleTestsUnchanged": visible_unchanged, "nativeActions": counts,
                 "finalVisibleTestsPass": visible["ok"], "hiddenTestsComplete": hidden_complete,
                 "visible": visible, "hidden": hidden, "changedPaths": changed,
                 "artifactSha256": artifact["sha256"], "modelWallMs": response["wallMs"],
                 "gradingWallMs": visible["wallMs"] + hidden["wallMs"],
                 "nativeError": response.get("error"),
                 "externalGradingError": visible.get("error") or hidden.get("error")}
        private_json(cached, score)
        return score


def compare_coding(suite, root, runner, *, frozen_harness=None, grader=None):
    report = compare(suite, root, runner, frozen_harness=frozen_harness,
        adapter_factory=lambda s, r, run: CodingBenchmarkAdapter(s, r, run, grader=grader))
    report["benchmarkKind"] = "code-edit-and-test"
    report["limitations"] = [
        "Small deterministic coding fixture suite; no statistical quality claim.",
        "Each source starts from the same fixture; hidden grades are computed only after selection.",
        "Improvers can read visible source, native trajectories and edited artifacts, never trusted hidden tests or grades.",
        "Source editing and fixed Node test execution use restricted plugin tools, not general shell access.",
        "Conservative source screening reduces grader tampering; source review remains necessary and arbitrary hostile JavaScript is not a supported trust boundary.",
        "Train results adapt on the same task; frozen holdouts do not adapt.",
        "Provider token counts/cost remain null when native provider does not report them."]
    report["gradingWallMs"] = sum(strict_json(path.read_text())["gradingWallMs"]
                                  for path in (root / "rollouts").glob("*/private-score.json"))
    # compare already wrote the preliminary generic report; replace only this owned artifact.
    path = root / "report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("suite", "runner", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout-ms", type=int, default=180000)
    parser.add_argument("--max-steps", type=int, default=18)
    parser.add_argument("--node", default="node")
    parser.add_argument("--frozen-harness", type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.max_steps <= 32 or not 1000 <= args.timeout_ms <= 600000:
        parser.error("max-steps must be 1..32; timeout-ms must be 1000..600000")
    suite = load_suite(args.suite)
    runner = JsonRunner(args.runner, args.provider, args.model, args.timeout_ms, args.max_steps, args.node)
    report = compare_coding(suite, args.output.resolve(), runner, frozen_harness=args.frozen_harness,
        grader=CodingGrader(args.runner.resolve().parent / "grade-coding.mjs", args.node))
    print(json.dumps({"report": str(args.output.resolve() / "report.json"),
                      "complete": report["complete"], "rows": report["rows"]}, indent=2))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
