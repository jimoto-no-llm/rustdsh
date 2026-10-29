"""Repeated, resumable paired coding evaluation with independently trained harnesses.

Completed model calls are never retried implicitly. An interrupted native call is an
observed unavailable arm, not a license to buy another sample on resume.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import sys
import threading
import time
import uuid

from rdsh_coding import CodingBenchmarkAdapter, CodingGrader, compare_coding, load_suite, snapshot
from rdsh_harness2 import JsonRunner, fingerprint, read_harness, strict_json, validate_tree, verify_upstream


def atomic_json(path: Path, value):
    """Replace only owned metadata, through a private complete same-directory file."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(path):
    return strict_json(Path(path).read_text(encoding="utf-8"))


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class BoundedRunner:
    def __init__(self, runner, semaphore):
        self.runner, self.semaphore = runner, semaphore

    def __getattr__(self, name):
        return getattr(self.runner, name)

    def invoke(self, *args, **kwargs):
        with self.semaphore:
            return self.runner.invoke(*args, **kwargs)


def training_record(report_path, suite, provider, model):
    """Validate reused training against the frozen train specification and real adoption."""
    path = Path(report_path).resolve()
    report = read_json(path)
    train = [task for task in suite["tasks"] if task["split"] == "train"]
    expected = {"version": suite["version"], "name": report.get("suite"), "tasks": train}
    if (report.get("suiteSha256") != fingerprint(expected)
            or report.get("provider") != provider or report.get("model") != model
            or report.get("upstreamCommit") != verify_upstream()
            or report.get("benchmarkKind") != "code-edit-and-test"
            or {row.get("taskId") for row in report.get("rows", [])} != {task["id"] for task in train}
            or any(row.get("split") != "train" for row in report.get("rows", []))):
        raise ValueError("training report does not match frozen training specification/runtime")
    origin = report.get("frozenHarnessOrigin")
    eligible = bool(isinstance(origin, dict) and origin.get("aggregateFellBack") is False
                    and re.fullmatch(r"agg[1-9][0-9]*", str(origin.get("stage", "")))
                    and any(method.get("taskId") == origin.get("taskId")
                            and method.get("aggregateAdoptionEligible") is True
                            and method.get("selection", {}).get("ok") is True
                            and method.get("selection", {}).get("fallback") is False
                            and method.get("selection", {}).get("chosen_label") == origin.get("stage")
                            and method.get("selection", {}).get("chosen_run_id") == origin.get("runId")
                            and any(stage.get("label") == origin.get("stage")
                                    and stage.get("dim") == "AGG" and stage.get("fell_back") is False
                                    for stage in method.get("method", {}).get("stages", []))
                            for method in report.get("methods", [])))
    tree_dir = path.parent / "frozen-harness"
    tree = read_harness(tree_dir) if eligible else None
    if eligible:
        validate_tree(tree)
        if not tree or fingerprint(tree) != report.get("frozenHarnessSha256"):
            raise ValueError("training frozen harness hash mismatch")
    sessions = report.get("sessions", [])
    native_complete = bool(sessions) and all(
        isinstance(session.get("providerWallMs"), (int, float))
        and session["providerWallMs"] >= 0
        and (session.get("ok") or session["providerWallMs"] > 0) for session in sessions)
    extra_sessions = [session for session in sessions if session.get("role") == "improver"
                      or session.get("label") not in {task["id"] + "-base" for task in train}]
    return {"state": "available" if eligible else "unavailable", "reportPath": str(path),
            "reportSha256": file_sha(path), "frozenHarnessSha256": fingerprint(tree) if tree else None,
            "harness": tree, "adaptationComplete": report.get("adaptationComplete"),
            "warnings": report.get("fallbackWarnings", []), "wallMs": report.get("wallMs", 0),
            "nativeWallMs": sum(session["providerWallMs"] for session in sessions) if native_complete else None,
            "nativeTimingComplete": native_complete,
            "additionalNativeOverTrainingBaselineMs": sum(session["providerWallMs"] for session in extra_sessions)
                if native_complete else None,
            "transportWallMs": report.get("total", {}).get("wallMsSum", 0),
            "additionalOverTrainingBaselineMs": report.get("trainingAdditionalOverBaseline", {}).get("wallMsSum", 0),
            "sessions": report.get("sessions", []), "costUsd": None}


def code_manifest(runner_path):
    root = runner_path.resolve().parent
    paths = list(root.glob("*.mjs")) + list((root / "python").glob("*.py"))
    paths += [root / "package.json", root / "package-lock.json"]
    return {str(path.relative_to(root)): file_sha(path) for path in sorted(paths) if path.is_file()}


def runtime_manifest():
    values = {}
    for name in ("RDSH_HARNESS2_BIN", "RDSH_HARNESS2_DSH_PACKAGE", "RDSH_HARNESS2_MODEL_PATCH"):
        configured = os.environ.get(name)
        if configured:
            path = Path(configured).resolve()
            target = path / "package.json" if path.is_dir() else path
            values[name] = {"path": str(path), "sha256": file_sha(target)}
    return values


def validate_training_manifest(path, current, reports, *, provider, model, rounds,
                               timeout_ms, max_steps, allowed_changes=()):
    previous = read_json(path)
    required = {"provider": provider, "model": model, "rounds": rounds,
                "timeoutMs": timeout_ms, "maxSteps": max_steps}
    if any(previous.get(key) != value for key, value in required.items()):
        raise ValueError("external training runtime settings mismatch")
    suite_path = Path(path).resolve().parent / "suite.json"
    if not suite_path.is_file():
        raise ValueError("external training suite.json is required for raw/canonical provenance")
    raw_suite_sha = file_sha(suite_path)
    canonical_suite_sha = fingerprint(read_json(suite_path))
    manifest_suite_sha = previous.get("suiteSha256")
    if (not previous.get("codeSha256")
            or manifest_suite_sha not in (raw_suite_sha, canonical_suite_sha)
            or any(report.get("suiteSha256") != canonical_suite_sha for report in reports)):
        raise ValueError("external training suite/code provenance missing or mismatched")
    differences = {}
    for name, before in previous["codeSha256"].items():
        if name not in current:
            raise ValueError("external training source file missing from current runtime")
        if current[name] != before:
            differences[name] = {"trainingSha256": before, "evaluationSha256": current[name]}
    if set(differences) - set(allowed_changes):
        raise ValueError("external training code changed without explicit allow-training-code-change")
    if set(allowed_changes) - set(previous["codeSha256"]):
        raise ValueError("allow-training-code-change must name an actual training source file")
    return {"path": str(Path(path).resolve()), "sha256": file_sha(path),
            "suitePath": str(suite_path), "suiteRawBytesSha256": raw_suite_sha,
            "suiteCanonicalJsonSha256": canonical_suite_sha,
            "manifestSuiteHashKind": "raw-bytes" if manifest_suite_sha == raw_suite_sha else "canonical-json",
            "trainingCodeSha256": previous["codeSha256"], "explicitlyAllowedCodeChanges": differences}


def prepare(root, manifest, resume):
    root = root.resolve()
    if root.exists():
        if not resume:
            raise ValueError("output exists; exact-manifest --resume is required")
        previous = read_json(root / "manifest.json")
        if previous != manifest:
            raise ValueError("resume manifest mismatch; no model calls were started")
    else:
        root.mkdir(parents=True, mode=0o700)
        atomic_json(root / "manifest.json", manifest)
        atomic_json(root / "suite-frozen.json", manifest["suite"])
        atomic_json(root / "started.json", {"epochSeconds": time.time()})
    return root


def train_round(round_id, root, suite, runner_factory, supplied=None):
    unit = root / f"round-{round_id:02d}"
    unit.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = unit / "training-result.json"
    if result.exists():
        return read_json(result)
    started = unit / "training-started.json"
    report_path = Path(supplied) if supplied else unit / "training" / "report.json"
    if supplied or report_path.exists():
        value = training_record(report_path, suite, runner_factory().provider, runner_factory().model)
    elif started.exists():
        value = {"state": "interrupted", "harness": None, "wallMs": None,
                 "nativeWallMs": None, "additionalOverTrainingBaselineMs": None,
                 "sessions": [], "error": "started-training-has-no-complete-report"}
    else:
        atomic_json(started, {"epochSeconds": time.time()})
        train_suite = dict(suite, tasks=[task for task in suite["tasks"] if task["split"] == "train"])
        start = time.monotonic()
        try:
            compare_coding(train_suite, unit / "training", runner_factory())
            value = training_record(report_path, suite, runner_factory().provider, runner_factory().model)
        except Exception as exc:
            value = {"state": "failed", "harness": None, "wallMs": (time.monotonic() - start) * 1000,
                     "nativeWallMs": None, "additionalOverTrainingBaselineMs": None,
                     "sessions": [], "error": type(exc).__name__}
    atomic_json(result, value)
    return value


def run_arm(root, suite, task, arm, harness, runner_factory, grader_factory,
            adapter_factory=CodingBenchmarkAdapter):
    """Reuse completed artifacts and grading on resume, never relaunch a started solver."""
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = root / "arm-result.json"
    if destination.exists():
        return read_json(destination)
    started_path = root / "run-started.json"
    work = root / "adapter"
    run_dir = work / "rollouts" / "solver"
    was_started = started_path.exists()
    start = time.monotonic()
    runner = None
    try:
        if was_started:
            if not ((run_dir / "result.json").is_file() and (run_dir / "artifact.json").is_file()):
                value = {"state": "interrupted", "score": None, "wallMs": None,
                         "error": "started-solver-has-no-complete-artifacts"}
                atomic_json(destination, value)
                return value
            artifact = read_json(run_dir / "artifact.json")
            if artifact.get("files") != snapshot(run_dir / "workspace"):
                raise ValueError("completed artifact/workspace mismatch")
            # Constructor creates fresh fixture files. Scoring needs only these fields.
            adapter = adapter_factory.__new__(adapter_factory)
            adapter.root, adapter.by_id = work, {task["id"]: task}
            adapter.grader = grader_factory()
            # Interrupted grader audit directories must not be overwritten. They contain
            # no native calls, but preserve them for diagnosis and mark grading failure.
            if not (run_dir / "private-score.json").exists() and any(
                    (run_dir / name).exists() for name in ("grade-visible", "grade-hidden")):
                value = {"state": "grading-interrupted", "score": None, "wallMs": None,
                         "error": "started-grader-has-no-complete-score"}
                atomic_json(destination, value)
                return value
        else:
            atomic_json(started_path, {"epochSeconds": time.time(), "arm": arm, "taskId": task["id"]})
            runner = runner_factory()
            adapter = adapter_factory(dict(suite, tasks=[task]), work, runner, grader=grader_factory())
            harness_path = None
            if harness is not None:
                harness_path = root / "harness"
                for name, text in harness.items():
                    path = harness_path / name
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    path.write_text(text, encoding="utf-8")
                    os.chmod(path, 0o600)
            run_dir = adapter.execute(task["id"], harness_path, "solver")
        score = adapter.score(run_dir, task["id"])
        value = {"state": "completed", "score": score, "wallMs": (time.monotonic() - start) * 1000,
                 "nativeTransportWallMs": sum(record["wallMs"] for record in runner.records) if runner else None,
                 "resumedCompletedArtifact": was_started, "artifactPath": str(run_dir), "costUsd": None}
    except Exception as exc:
        value = {"state": "failed", "score": None, "wallMs": (time.monotonic() - start) * 1000,
                 "error": type(exc).__name__, "costUsd": None}
    atomic_json(destination, value)
    return value


def run_pair(round_id, task, task_index, root, suite, training, runner_factory, grader_factory,
             adapter_factory=CodingBenchmarkAdapter):
    pair_root = root / f"round-{round_id:02d}" / "pairs" / task["id"]
    destination = pair_root / "pair-result.json"
    if destination.exists():
        return read_json(destination)
    # Alternation balances early/late arms within each independent harness round.
    order = ["baseline", "improved"] if (round_id + task_index) % 2 else ["improved", "baseline"]
    arms = {}
    start = time.monotonic()
    for arm in order:
        if arm == "improved" and training.get("state") != "available":
            arms[arm] = {"state": "unavailable", "score": None,
                         "reason": "no-validated-aggregate", "wallMs": 0}
        else:
            arms[arm] = run_arm(pair_root / arm, suite, task, arm,
                training.get("harness") if arm == "improved" else None,
                runner_factory, grader_factory, adapter_factory)
    row = {"round": round_id, "taskId": task["id"], "order": order,
           "expectedHiddenTests": task.get("hiddenTestCount"), **arms,
           "wallMs": (time.monotonic() - start) * 1000}
    atomic_json(destination, row)
    return row


def binomial_p(wins, losses):
    n = wins + losses
    return min(1.0, 2 * sum(math.comb(n, k) for k in range(min(wins, losses) + 1)) / 2 ** n) if n else 1.0


def passed(arm):
    return bool(arm.get("state") == "completed" and (arm.get("score") or {}).get("passed"))


def complete_sum(values):
    values = list(values)
    return sum(values) if all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in values) else None


def difference(left, right):
    return left - right if left is not None and right is not None else None


def summarize(rows, training, *, seed, total_wall_ms):
    n = len(rows)
    wins = sum(passed(row["improved"]) and not passed(row["baseline"]) for row in rows)
    losses = sum(passed(row["baseline"]) and not passed(row["improved"]) for row in rows)
    completed_pairs = [row for row in rows if all(row[a]["state"] == "completed" for a in ("baseline", "improved"))]
    semantic_pairs = [row for row in completed_pairs if row.get("expectedHiddenTests", 0) > 0
        and all(row[a]["score"].get("nativeCompleted")
                and not row[a]["score"].get("externalGradingError")
                and row[a]["score"].get("hidden", {}).get("tests") == row["expectedHiddenTests"]
                for a in ("baseline", "improved"))]
    observed_wins = sum(passed(r["improved"]) and not passed(r["baseline"]) for r in completed_pairs)
    observed_losses = sum(passed(r["baseline"]) and not passed(r["improved"]) for r in completed_pairs)
    arms = {}
    for arm in ("baseline", "improved"):
        entries = [row[arm] for row in rows]
        scores = [entry["score"] for entry in entries if entry.get("score")]
        model_ms = [score["modelWallMs"] for score in scores if isinstance(score.get("modelWallMs"), (int, float))]
        native_values = [0 if entry["state"] == "unavailable" else
            ((entry.get("score") or {}).get("modelWallMs") if entry["state"] == "completed"
             and ((entry.get("score") or {}).get("nativeCompleted")
                  or (entry.get("score") or {}).get("modelWallMs", 0) > 0) else None) for entry in entries]
        arms[arm] = {"passed": sum(passed(entry) for entry in entries), "planned": n,
            "completed": len(scores), "successRate": sum(passed(entry) for entry in entries) / n if n else None,
            "nativeFailures": sum(not score.get("nativeCompleted", False) for score in scores),
            "externalGradingFailures": sum(bool(score.get("externalGradingError")) for score in scores),
            "unavailableOrInterrupted": sum(entry.get("score") is None for entry in entries),
            "nativeWallMs": complete_sum(native_values), "observedNativeWallMsLowerBound": sum(model_ms),
            "nativeTimingComplete": all(value is not None for value in native_values),
            "nativeTransportWallMs": complete_sum(0 if e["state"] == "unavailable" else e.get("nativeTransportWallMs") for e in entries),
            "meanNativeWallMs": statistics.mean(model_ms) if model_ms else None,
            "gradingWallMs": sum(score.get("gradingWallMs", 0) for score in scores),
            "wallMs": sum(entry.get("wallMs") or 0 for entry in entries),
            "hiddenPassed": sum(score.get("hidden", {}).get("passed", 0) for score in scores),
            "hiddenTests": sum(score.get("hidden", {}).get("tests", 0) for score in scores)}
        expected = sum(row.get("expectedHiddenTests") or 0 for row in rows)
        arms[arm]["plannedHiddenTests"] = expected
        arms[arm]["hiddenFractionOfPlanned"] = arms[arm]["hiddenPassed"] / expected if expected else None
    groups = {}
    for key, values in (("byRound", sorted({row["round"] for row in rows})),
                        ("byTask", sorted({row["taskId"] for row in rows}))):
        field = "round" if key == "byRound" else "taskId"
        groups[key] = [{field: value, "pairs": sum(row[field] == value for row in rows),
            "baselinePassed": sum(passed(row["baseline"]) for row in rows if row[field] == value),
            "improvedPassed": sum(passed(row["improved"]) for row in rows if row[field] == value)} for value in values]
    oracle = {arm: sum(any(passed(row[arm]) for row in rows if row["taskId"] == task)
                       for task in sorted({row["taskId"] for row in rows})) for arm in ("baseline", "improved")}
    task_deltas = [(item["improvedPassed"] - item["baselinePassed"]) / item["pairs"] for item in groups["byTask"]]
    rng = random.Random(seed)
    boot = sorted(statistics.mean(rng.choices(task_deltas, k=len(task_deltas))) for _ in range(10000)) if task_deltas else []
    full_training = complete_sum(t.get("wallMs") for t in training)
    native_training = complete_sum(t.get("nativeWallMs") for t in training)
    incremental_training_native = complete_sum(t.get("additionalNativeOverTrainingBaselineMs") for t in training)
    training_transport = complete_sum(t.get("transportWallMs") for t in training)
    incremental_training_transport = complete_sum(t.get("additionalOverTrainingBaselineMs") for t in training)
    delta_native = difference(arms["improved"]["nativeWallMs"], arms["baseline"]["nativeWallMs"])
    delta_transport = difference(arms["improved"]["nativeTransportWallMs"], arms["baseline"]["nativeTransportWallMs"])
    full_additional = native_training + delta_native if native_training is not None and delta_native is not None else None
    additional = incremental_training_native + delta_native if incremental_training_native is not None and delta_native is not None else None
    full_additional_transport = training_transport + delta_transport if training_transport is not None and delta_transport is not None else None
    additional_transport = incremental_training_transport + delta_transport if incremental_training_transport is not None and delta_transport is not None else None
    net = wins - losses
    available_training = [t for t in training if t["state"] == "available"]
    mean_training_native = native_training / len(training) if training and native_training is not None else None
    mean_incremental_native = incremental_training_native / len(training) if training and incremental_training_native is not None else None
    mean_delta = delta_native / n if n and delta_native is not None else None
    mean_training_transport = training_transport / len(training) if training and training_transport is not None else None
    mean_incremental_transport = incremental_training_transport / len(training) if training and incremental_training_transport is not None else None
    mean_delta_transport = delta_transport / n if n and delta_transport is not None else None
    def amortized(count, full=False, transport=False):
        overhead = ((mean_training_transport if full else mean_incremental_transport) if transport
                    else (mean_training_native if full else mean_incremental_native))
        delta = mean_delta_transport if transport else mean_delta
        return (overhead / count + delta) / 1000 if overhead is not None and delta is not None else None
    def ratio(value):
        return value / 1000 / net if value is not None and net > 0 else None
    return {"pairs": n, "completedPairs": len(completed_pairs), **arms, **groups,
        "improvementPairs": wins, "regressionPairs": losses, "netAdditionalSuccesses": net,
        "pairedCompletedOnly": {"wins": observed_wins, "losses": observed_losses,
            "exactDiscordantBinomialTwoSidedP": binomial_p(observed_wins, observed_losses),
            "interpretation": "Exploratory only: the exact calculation assumes independent discordant cells; repeated tasks and shared harnesses violate that assumption."},
        "semanticEligiblePairs": {"pairs": len(semantic_pairs),
            "baselinePassed": sum(passed(row["baseline"]) for row in semantic_pairs),
            "improvedPassed": sum(passed(row["improved"]) for row in semantic_pairs),
            "wins": sum(passed(row["improved"]) and not passed(row["baseline"]) for row in semantic_pairs),
            "losses": sum(passed(row["baseline"]) and not passed(row["improved"]) for row in semantic_pairs),
            "definition": "Both native calls succeeded, no external grading error, and both hidden graders counted exactly the frozen expected number of tests (passes or legitimate failures)."},
        "oracleAnySuccessAcrossRounds": {"tasks": len(groups["byTask"]), **oracle,
            "interpretation": "Hidden-grade oracle upper bound across observed repeats, not a deployable selector or a measured cost-matched retry policy."},
        "taskClusterBootstrap": {"unit": "task; all rounds retained within each sampled task", "draws": 10000,
            "rateDifference95Percentile": [boot[249], boot[9749]] if boot else None,
            "interpretation": "Descriptive only: few hand-authored task clusters, not an independent population confidence guarantee."},
        "timing": {"orchestratorElapsedWallMsIncludingPauses": total_wall_ms,
            "trainingWallMsSummedAcrossRounds": full_training, "trainingNativeWallMs": native_training,
            "trainingTransportWallMs": training_transport,
            "additionalOverTrainingBaselineMs": incremental_training_transport,
            "additionalNativeOverTrainingBaselineMs": incremental_training_native,
            "holdoutNativeDeltaMs": delta_native, "holdoutTransportDeltaMs": delta_transport,
            "plannedIncrementalAdditionalNativeMs": additional,
            "fullPipelineAdditionalNativeMs": full_additional,
            "plannedIncrementalAdditionalTransportMs": additional_transport,
            "fullPipelineAdditionalTransportMs": full_additional_transport,
            "additionalSecondsPerNetSuccess": ratio(additional),
            "fullPipelineAdditionalSecondsPerNetSuccess": ratio(full_additional),
            "additionalTransportSecondsPerNetSuccess": ratio(additional_transport),
            "fullPipelineAdditionalTransportSecondsPerNetSuccess": ratio(full_additional_transport),
            "nativeCostTimingComplete": additional is not None and full_additional is not None,
            "transportCostTimingComplete": additional_transport is not None and full_additional_transport is not None,
            "transportTimingMeaning": "Sum of host-measured native session durations, including process startup and failed sessions; not concurrent experiment elapsed time or grader time.",
            "missingTrainingTransportTimings": sum(t.get("transportWallMs") is None
                or t.get("additionalOverTrainingBaselineMs") is None for t in training),
            "missingTrainingTimings": sum(t.get("nativeWallMs") is None for t in training)},
        "repairTimeScenarios": [{"repairSeconds": repair,
            "savedRepairSeconds": net * repair,
            "plannedIncrementalAdditionalNativeSeconds": additional / 1000 if additional is not None else None,
            "plannedIncrementalNetSecondsSaved": net * repair - additional / 1000 if additional is not None else None,
            "fromScratchAdditionalNativeSeconds": full_additional / 1000 if full_additional is not None else None,
            "fromScratchNetSecondsSaved": net * repair - full_additional / 1000 if full_additional is not None else None,
            "plannedIncrementalAdditionalTransportSeconds": additional_transport / 1000 if additional_transport is not None else None,
            "plannedIncrementalTransportNetSecondsSaved": net * repair - additional_transport / 1000 if additional_transport is not None else None,
            "fromScratchAdditionalTransportSeconds": full_additional_transport / 1000 if full_additional_transport is not None else None,
            "fromScratchTransportNetSecondsSaved": net * repair - full_additional_transport / 1000 if full_additional_transport is not None else None}
            for repair in (60, 300, 900)],
        "amortization": [{"tasksPerFreshHarness": count,
            "meanTrainingNativeSeconds": mean_training_native / 1000 if mean_training_native is not None else None,
            "meanTrainingIncrementalNativeSeconds": mean_incremental_native / 1000 if mean_incremental_native is not None else None,
            "additionalNativeSecondsPerTask": amortized(count),
            "fromScratchAdditionalNativeSecondsPerTask": amortized(count, full=True),
            "meanTrainingTransportSeconds": mean_training_transport / 1000 if mean_training_transport is not None else None,
            "meanTrainingIncrementalTransportSeconds": mean_incremental_transport / 1000 if mean_incremental_transport is not None else None,
            "additionalTransportSecondsPerTask": amortized(count, transport=True),
            "fromScratchAdditionalTransportSecondsPerTask": amortized(count, full=True, transport=True),
            "observedNetSuccessRateDifference": net / n if n else None,
            "breakEvenRepairSeconds": amortized(count) / (net / n) if n and net > 0 and amortized(count) is not None else None,
            "fromScratchBreakEvenRepairSeconds": amortized(count, full=True) / (net / n)
                if n and net > 0 and amortized(count, full=True) is not None else None,
            "breakEvenTransportRepairSeconds": amortized(count, transport=True) / (net / n)
                if n and net > 0 and amortized(count, transport=True) is not None else None,
            "fromScratchBreakEvenTransportRepairSeconds": amortized(count, full=True, transport=True) / (net / n)
                if n and net > 0 and amortized(count, full=True, transport=True) is not None else None}
            for count in (8, 24, 100)],
        "availableTrainingRounds": len(available_training), "costUsd": None,
        "roundReproducibility": {"positive": sum(r["improvedPassed"] > r["baselinePassed"] for r in groups["byRound"]),
            "negative": sum(r["improvedPassed"] < r["baselinePassed"] for r in groups["byRound"]),
            "tied": sum(r["improvedPassed"] == r["baselinePassed"] for r in groups["byRound"])},
        "limitations": ["Training and holdout samples are dependent within each frozen harness round.",
            "The cursor regression is now a known evaluation case; heldout means excluded from these training calls, not unknown to the experiment designer.",
            "Unavailable arms count as unsuccessful in planned-pipeline rates; semantic analysis is separately restricted to eligible successful native calls.",
            "Completed pairs means both scores were collected, including native/grading failures; semantic-eligible pairs exclude these failures and invalid hidden-test counts.",
            "Native milliseconds sum provider sessions; concurrent elapsed time and human repair time are different quantities.",
            "Planned incremental time excludes the ordinary training-task baseline; from-scratch time charges all training calls. Transport and native timings are reported separately.",
            "Missing or zero-duration failed native sessions make native cost ratios and break-even estimates unavailable; observed native sums are lower bounds only. Host transport timing is independent and may remain complete.",
            "Amortization at 24/100 tasks is a timing scenario holding the observed effect fixed, not evidence that the quality benefit generalizes beyond these tasks.",
            "No token or monetary price is inferred; source-screening is conservative and not a general hostile-JavaScript trust boundary."]}


def evaluate(suite, root, runner_factory, grader_factory, *, rounds=3, workers=2, seed=271828,
             supplied_reports=None, phase="all", adapter_factory=CodingBenchmarkAdapter):
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(train_round, index + 1, root, suite, runner_factory,
            supplied_reports[index] if supplied_reports else None) for index in range(rounds)]
        training = [future.result() for future in futures]
    atomic_json(root / "training-summary.json", [{k: v for k, v in item.items() if k != "harness"} for item in training])
    if phase == "train":
        return {"phase": "train", "trainingRounds": rounds, "available": sum(t["state"] == "available" for t in training)}
    tasks = [task for task in suite["tasks"] if task["split"] == "holdout"]
    random.Random(seed).shuffle(tasks)
    jobs = [(r + 1, task, index) for r in range(rounds) for index, task in enumerate(tasks)]
    # Interleave rounds to reduce chronology bias from running all of one harness first.
    jobs.sort(key=lambda job: (job[2], job[0]))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_pair, r, task, index, root, suite, training[r - 1],
            runner_factory, grader_factory, adapter_factory) for r, task, index in jobs]
        rows = [future.result() for future in futures]
    rows.sort(key=lambda row: (row["round"], row["taskId"]))
    elapsed = (time.time() - read_json(root / "started.json")["epochSeconds"]) * 1000
    summary = summarize(rows, training, seed=seed, total_wall_ms=elapsed)
    summary["timing"]["externalTrainingExcludedFromOrchestratorElapsed"] = bool(supplied_reports)
    report = {"version": 1, "suiteSha256": fingerprint(suite), "rounds": rounds, "seed": seed,
        "workers": workers, "summary": summary, "rows": rows,
        "training": [{k: v for k, v in item.items() if k != "harness"} for item in training],
        "complete": all(row[a]["state"] == "completed" for row in rows for a in ("baseline", "improved"))}
    atomic_json(root / "report.json", report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("suite", "runner", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--seed", type=int, default=271828)
    parser.add_argument("--timeout-ms", type=int, default=600000)
    parser.add_argument("--max-steps", type=int, default=24)
    parser.add_argument("--node", default="node")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--phase", choices=("train", "all"), default="all")
    parser.add_argument("--training-reports", type=Path, nargs="+")
    parser.add_argument("--training-manifest", type=Path)
    parser.add_argument("--allow-training-code-change", action="append", default=[])
    args = parser.parse_args(argv)
    if not (1 <= args.rounds <= 10 and 1 <= args.workers <= 2 and 1 <= args.max_steps <= 32
            and 1000 <= args.timeout_ms <= 600000):
        parser.error("rounds 1..10; workers 1..2; max-steps 1..32; timeout-ms 1000..600000")
    if args.training_reports and len(args.training_reports) != args.rounds:
        parser.error("training-reports count must equal rounds")
    if args.training_reports and len({path.resolve() for path in args.training_reports}) != args.rounds:
        parser.error("independent rounds require distinct training report paths")
    if args.training_reports and not args.training_manifest:
        parser.error("training-reports requires training-manifest for runtime provenance")
    if args.allow_training_code_change and not args.training_manifest:
        parser.error("allow-training-code-change requires training-manifest")
    suite = load_suite(args.suite)
    if not any(task["split"] == "holdout" for task in suite["tasks"]):
        parser.error("repeated comparison requires holdout tasks")
    supplied = [training_record(path, suite, args.provider, args.model) for path in args.training_reports or []]
    sources = code_manifest(args.runner)
    training_manifest = validate_training_manifest(args.training_manifest, sources,
        [read_json(path) for path in args.training_reports or []], provider=args.provider,
        model=args.model, rounds=args.rounds, timeout_ms=args.timeout_ms, max_steps=args.max_steps,
        allowed_changes=args.allow_training_code_change) if args.training_manifest else None
    manifest = {"version": 1, "suite": suite, "suiteSha256": fingerprint(suite),
        "codeSha256": sources, "upstreamCommit": verify_upstream(),
        "provider": args.provider, "model": args.model, "timeoutMs": args.timeout_ms,
        "maxSteps": args.max_steps, "node": str(Path(shutil.which(args.node) or args.node).resolve()),
        "nodeSha256": file_sha(shutil.which(args.node) or args.node),
        "runtime": runtime_manifest(),
        "trainingManifest": training_manifest,
        "rounds": args.rounds, "workers": args.workers, "seed": args.seed,
        "trainingReports": [{k: value[k] for k in ("reportPath", "reportSha256", "frozenHarnessSha256", "state")} for value in supplied]}
    root = prepare(args.output, manifest, args.resume)
    semaphore = threading.BoundedSemaphore(args.workers)
    def runner_factory():
        return BoundedRunner(JsonRunner(args.runner, args.provider, args.model,
            args.timeout_ms, args.max_steps, args.node), semaphore)
    result = evaluate(suite, root, runner_factory,
        lambda: CodingGrader(args.runner.resolve().parent / "grade-coding.mjs", args.node),
        rounds=args.rounds, workers=args.workers, seed=args.seed,
        supplied_reports=args.training_reports, phase=args.phase)
    print(json.dumps({"report": str(root / "report.json"),
                      "complete": result.get("complete"), "phase": args.phase}))
    return 0 if result.get("complete", args.phase == "train") else 1


if __name__ == "__main__":
    sys.exit(main())
