"""Restricted rdsh substrate and benchmark seam for Google's actual Harness² core.

No provider SDK lives here: every model session uses rdsh through runner.mjs.
Only authored Markdown is editable. Answers are scored after adoption, outside context.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

from harness2.core import prompts as upstream_prompts, recursion, selection, tree as ht
from harness2.core.proposer import ProposerError, Reply
from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec, RunView
from harness2.substrate.base import Install

UPSTREAM_COMMIT = "1cfe254e8d25b15f37048c3730134686abe60335"
MAX_FILE_BYTES = 48_000
MAX_TREE_BYTES = 96_000
MAX_RESPONSE_BYTES = 2_000_000
SURFACE = ht.SurfaceSpec(
    name="rdsh", always_on=("systemprompt.md", "tool-guidance.md"),
    always_on_max=24_000, always_on_cap_reason="keep native rdsh prompt bounded",
    skill_dir="skills", skill_name_rule="must_match", trigger_hint="Name {name} in guidance.",
    autotrigger_file="tool-guidance.md", trigger_line="Use the {name} skill when {desc}.",
    subagent_requires_mode=False, plugin_dir=None, hooks_file=None,
)
BASE_TREE = {
    "systemprompt.md": "",
    "tool-guidance.md": "",
}


def register_rdsh_prompt_surface():
    """Pinned compatibility shim: upstream does not yet expose surface registration.

    Add only the rdsh prompt fragments. Upstream proposal/aggregation/recursion remain
    untouched; changing or aliasing a built-in surface would misdescribe our permissions.
    """
    if not hasattr(upstream_prompts, "_SurfaceText") or not isinstance(
        getattr(upstream_prompts, "_SURFACE_TEXTS", None), dict
    ):
        raise RuntimeError("unsupported harness2 prompt API; use the pinned upstream commit")
    surface_text = (
        "# RDSH EDITABLE SURFACE\n"
        "Only systemprompt.md and tool-guidance.md (always on), plus "
        "skills/<lowercase_name>/SKILL.md (Markdown procedure) are editable. "
        "Skills require name and description frontmatter, and their names in always-on text. "
        "Never edit policies, hooks, tools, auth, scripts or executable files. "
        "Return a JSON Markdown-file patch through the transport contract below; "
        "the host validates and materialises it into context/harness. "
        "Omitted paths inherit their current content. Keep the user's task scope and output format."
    )
    upstream_prompts._SURFACE_TEXTS.setdefault("rdsh", upstream_prompts._SurfaceText(
        surface_md=surface_text,
        inv=("Improve reusable reasoning procedure and source reading for {deliverable}. "
             "Ground each edit in a specific trajectory. Only always-on Markdown guidance "
             "and generic skills may change; never add permissions or executable tools."),
        dom=("Improve mechanics specific to this {domain}. Encode reusable source analysis "
             "in skills with a name and description; add a trigger naming each skill "
             "in tool-guidance.md. Do not memorize this task's answer."),
        tts_surface=surface_text,
    ))


register_rdsh_prompt_surface()


def verify_upstream() -> str:
    """Only claim the pinned revision after checking the imported source checkout."""
    source_root = Path(recursion.__file__).resolve().parents[2]
    try:
        revision = subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"],
                                           text=True, stderr=subprocess.DEVNULL).strip()
        changed = subprocess.check_output(
            ["git", "-C", str(source_root), "status", "--porcelain", "--untracked-files=no",
             "--", "harness2"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("install harness2 editable from the documented pinned checkout") from exc
    if revision != UPSTREAM_COMMIT or changed:
        raise RuntimeError("harness2 source differs from the pinned clean upstream commit")
    return revision


def safe_relative(name: str) -> str:
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("invalid relative path")
    if name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/")):
        raise ValueError("path must be canonical and inside workspace")
    return name


def validate_tree(value: dict) -> None:
    if not isinstance(value, dict) or len(value) > 32:
        raise ValueError("harness must be an object with at most 32 Markdown files")
    total = 0
    for name, body in value.items():
        safe_relative(name)
        if name not in SURFACE.always_on and not re.fullmatch(
            r"skills/[a-z0-9][a-z0-9_-]*/SKILL\.md", name
        ):
            raise ValueError(f"off-surface harness path: {name}")
        if not isinstance(body, str) or "\0" in body:
            raise ValueError("harness bodies must be NUL-free text")
        size = len(body.encode("utf-8"))
        if size > MAX_FILE_BYTES:
            raise ValueError("harness file byte limit exceeded")
        total += size
    if total > MAX_TREE_BYTES:
        raise ValueError("harness total byte limit exceeded")


def read_harness(root: Path) -> dict[str, str]:
    if root.is_symlink():
        raise ValueError("symlink harness root")
    out = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("symlink in harness")
        if path.is_file():
            if path.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("harness file byte limit exceeded")
            out[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
    validate_tree(out)
    return out


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def strict_json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result

    def reject_constant(_):
        raise ValueError("nonfinite JSON number")

    return json.loads(text, object_pairs_hook=pairs, parse_constant=reject_constant)


def private_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def private_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        stream.write(text)


def validate_response(response: dict) -> None:
    required = {"version", "ok", "text", "usage", "wallMs", "trace", "model", "provider"}
    if not isinstance(response, dict) or not required <= response.keys() or (
        response.keys() - required - {"error"}
    ):
        raise ValueError("runner response fields invalid")
    if type(response["version"]) is not int or response["version"] != 1 or type(response["ok"]) is not bool:
        raise ValueError("runner response version/ok invalid")
    if not all(isinstance(response[k], str) for k in ("text", "model", "provider")):
        raise ValueError("runner response text identity invalid")
    usage = response["usage"]
    if not isinstance(usage, dict) or set(usage) != {
        "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"
    }:
        raise ValueError("runner usage fields invalid")
    for number in [response["wallMs"], *usage.values()]:
        if number is not None and (type(number) not in (int, float)
                                   or not math.isfinite(number) or number < 0):
            raise ValueError("runner timing/usage must be finite nonnegative numbers or null")
    if any(v is not None and type(v) is not int for v in usage.values()):
        raise ValueError("runner token counts must be integers or null")
    if response["wallMs"] is None:
        raise ValueError("runner wallMs is required")
    if not isinstance(response["trace"], list):
        raise ValueError("runner trace invalid")
    for event in response["trace"]:
        if not isinstance(event, dict) or set(event) - {"type", "name", "text"}:
            raise ValueError("runner trace event fields invalid")
        if event.get("type") not in ("action", "observation", "answer", "error"):
            raise ValueError("runner trace event type invalid")
        if not isinstance(event.get("text"), str) or (
            "name" in event and not isinstance(event["name"], str)
        ):
            raise ValueError("runner trace event text invalid")
    if "error" in response and (not isinstance(response["error"], dict)
                               or set(response["error"]) != {"code"}
                               or not isinstance(response["error"]["code"], str)):
        raise ValueError("runner error schema invalid")
    if response["ok"] == ("error" in response):
        raise ValueError("runner ok/error status disagrees")


class JsonRunner:
    def __init__(self, runner: Path, provider: str, model: str, timeout_ms: int,
                 max_steps: int, node: str = "node"):
        self.command = [node, str(runner.resolve())]
        self.provider, self.model = provider, model
        self.timeout_ms, self.max_steps = timeout_ms, max_steps
        self.records = []
        self.lock = threading.Lock()

    def invoke(self, role: str, workspace: Path, prompt: str, harness: dict,
               audit: Path, label: str, *, coding: dict | None = None) -> dict:
        validate_tree(harness)
        audit.mkdir(parents=True, exist_ok=False, mode=0o700)
        request = {"version": 1, "role": role, "workspace": str(workspace.resolve()),
                   "prompt": prompt, "harness": harness, "provider": self.provider,
                   "model": self.model, "timeoutMs": self.timeout_ms,
                   "maxSteps": self.max_steps}
        if coding is not None:
            if role != "solver":
                raise ValueError("coding tools are solver-only")
            request["coding"] = coding
        private_json(audit / "request.json", request)
        started = time.monotonic()
        try:
            process = subprocess.run(
                self.command + ["--request", str(audit / "request.json"),
                                "--response", str(audit / "response.json")],
                cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=self.timeout_ms / 1000 + 10, text=True,
            )
            response_path = audit / "response.json"
            if response_path.is_symlink() or not response_path.is_file():
                raise RuntimeError("runner produced no regular response file")
            if response_path.stat().st_size > MAX_RESPONSE_BYTES:
                raise ValueError("runner response byte limit exceeded")
            os.chmod(response_path, 0o600)
            response = strict_json(response_path.read_text(encoding="utf-8"))
            validate_response(response)
            if response["model"] != self.model or response["provider"] != self.provider:
                raise ValueError("runner response model/provider mismatch")
            if process.returncode and response["ok"]:
                raise ValueError("runner exit status disagrees with response")
        except Exception as exc:
            # Never surface captured stderr: provider diagnostics may contain credentials.
            response = {"version": 1, "ok": False, "text": "", "error": {
                "code": type(exc).__name__}, "usage": {"inputTokens": None,
                "outputTokens": None, "cacheReadTokens": None, "cacheWriteTokens": None}, "wallMs": 0,
                "trace": [], "model": self.model, "provider": self.provider}
            private_json(audit / "transport-error.json", response)
        record = {"label": label, "role": role, "ok": response["ok"],
                  "wallMs": (time.monotonic() - started) * 1000,
                  "providerWallMs": response["wallMs"], "usage": response["usage"],
                  "costUsd": None, "audit": str(audit)}
        with self.lock:
            self.records.append(record)
        return response


class RdshSubstrate:
    name = "rdsh"

    def __init__(self, launcher=None):
        self.launcher = launcher

    def surface(self):
        return SURFACE

    def materialise(self, tree_dir: Path, spec, ctx) -> Install:
        if spec.install_mode != "workspace_config":
            raise ValueError("rdsh requires workspace_config install mode")
        if ctx:
            raise ValueError("context interpolation and integration files are not editable")
        value = read_harness(tree_dir)
        ht.validate(SURFACE, value, allow_subagents=False)
        return Install(tree_dir.resolve(), fingerprint(value))

    def execute(self, task_ref, install, run_ids, timeout):
        if self.launcher is None:
            raise RuntimeError("benchmark launcher is missing")
        return [self.launcher(task_ref, install, run_id, timeout) for run_id in run_ids]

    def read_trajectory(self, stream_path, *, obs_trunc, max_chars, args_trunc=400):
        response = json.loads(Path(stream_path).read_text(encoding="utf-8"))
        parts = []
        for event in response["trace"]:
            limit = args_trunc if event["type"] == "action" else obs_trunc
            text = event["text"]
            if len(text) > limit:
                text = text[:limit] + "\n[renderer truncated this event]"
            parts.append(f"[{event['type'].upper()}] {event.get('name', '')}\n{text}")
        return "\n\n".join(parts)[:max_chars]

    def preflight(self):
        return None


def load_suite(path: Path) -> dict:
    value = strict_json(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"version", "name", "tasks"}:
        raise ValueError("suite requires exactly version/name/tasks")
    if type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["name"], str):
        raise ValueError("invalid suite version/name")
    if not isinstance(value["tasks"], list) or not 1 <= len(value["tasks"]) <= 20:
        raise ValueError("suite needs 1..20 tasks")
    ids = set()
    for task in value["tasks"]:
        if not isinstance(task, dict) or set(task) != {
            "id", "split", "domain", "prompt", "files", "expected"
        }:
            raise ValueError("task fields must be id/split/domain/prompt/files/expected")
        if not isinstance(task["id"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", task["id"]):
            raise ValueError("task id must be a safe basename")
        if task["id"] in ids or task["split"] not in ("train", "holdout"):
            raise ValueError("duplicate task id or invalid split")
        ids.add(task["id"])
        if not all(isinstance(task[k], str) and task[k] for k in ("domain", "prompt")):
            raise ValueError("task domain/prompt must be nonempty strings")
        if not isinstance(task["files"], dict) or len(task["files"]) > 32:
            raise ValueError("invalid task source files")
        for name, body in task["files"].items():
            safe_relative(name)
            if not isinstance(body, str) or len(body.encode()) > MAX_FILE_BYTES:
                raise ValueError("invalid task source file body")
        if sum(len(body.encode()) for body in task["files"].values()) > MAX_TREE_BYTES:
            raise ValueError("task source bytes exceeded")
        json.dumps(task["expected"], allow_nan=False)
    if not any(t["split"] == "train" for t in value["tasks"]):
        raise ValueError("at least one training task is required")
    return value


class RdshBenchmarkAdapter:
    def __init__(self, suite: dict, root: Path, runner):
        self.suite, self.root, self.runner = suite, root, runner
        self.by_id = {task["id"]: task for task in suite["tasks"]}
        self.substrate = RdshSubstrate(self._launch)
        # ChannelSpec's standard enum describes upstream transports; the custom proposer
        # never invokes it. Its model identifier remains explicit in our runner/report.
        channel = ChannelSpec("opencode", f"{runner.provider}/{runner.model}")
        self.spec = BenchSpec(
            name=suite["name"], runs_root=root / "rollouts", install_mode="workspace_config",
            prompts=BenchPrompts(work="Read fixture source materials and return exact JSON.",
                domain_word="fixture analysis", yardstick="Correct source-backed JSON output.",
                domain_guidance="Use only source materials and keep the requested JSON shape."),
            channels={"proposer": channel, "selector": channel},
            allow_subagents=False, leak_globs=("expected.json", "suite.json", "report.json"),
        )
        self._base = root / "base-harness"
        ht.write_tree(SURFACE, BASE_TREE, self._base, stubs=False)
        for task in suite["tasks"]:
            source = root / "sources" / task["id"]
            source.mkdir(parents=True, mode=0o700)
            for name, body in task["files"].items():
                private_text(source / name, body)

    def tasks(self, split="all"):
        return [t["id"] for t in self.suite["tasks"] if split == "all" or t["split"] == split]

    def domain_of(self, task_id):
        return self.by_id[task_id]["domain"]

    def task_prompt(self, task_id):
        return self.by_id[task_id]["prompt"]

    def task_files(self, task_id):
        return self.root / "sources" / task_id

    def base_harness(self):
        return self._base

    def validate_tree(self, tree):
        validate_tree(tree)

    def _launch(self, task_ref, install, run_id, timeout):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", run_id):
            raise ValueError("unsafe run id")
        rd = self.spec.runs_root / run_id
        rd.mkdir(parents=True, exist_ok=False, mode=0o700)
        workspace = rd / "workspace"
        shutil.copytree(self.task_files(task_ref), workspace)
        value = read_harness(install.staging_dir)
        provenance = {"taskId": task_ref, "runId": run_id,
                      "harnessSha256": install.fingerprint,
                      "taskSha256": fingerprint({k: v for k, v in self.by_id[task_ref].items()
                                                 if k != "expected"}),
                      "model": self.runner.model, "provider": self.runner.provider}
        private_json(rd / "provenance.json", provenance)
        response = self.runner.invoke("solver", workspace, self.task_prompt(task_ref),
                                      value, rd / "session", run_id)
        private_json(rd / "result.json", response)
        return rd

    def execute(self, task_id, harness_dir, run_id, *, timeout=None):
        install = self.substrate.materialise(harness_dir or self._base, self.spec, {})
        return self.substrate.execute(task_id, install, [run_id], timeout)[0]

    def delivered(self, run_dir):
        value = json.loads((Path(run_dir) / "result.json").read_text())
        return value["ok"] and bool(value["text"].strip())

    def trajectory(self, run_dir, *, obs_trunc):
        return self.substrate.read_trajectory(Path(run_dir) / "result.json",
                                             obs_trunc=obs_trunc, max_chars=2_000_000)

    def deliverable_text(self, run_dir):
        return json.loads((Path(run_dir) / "result.json").read_text())["text"]

    def deliverable_files(self, run_dir):
        return {"answer.json": self.deliverable_text(run_dir)}

    def score(self, run_dir, task_id):
        response = json.loads((Path(run_dir) / "result.json").read_text())
        try:
            actual = strict_json(response["text"])
            # Canonical JSON keeps booleans distinct from integers and key order irrelevant.
            exact = fingerprint(actual) == fingerprint(self.by_id[task_id]["expected"])
            return {"passed": bool(response["ok"] and exact), "validJson": True,
                    "completed": response["ok"]}
        except (ValueError, TypeError):
            return {"passed": False, "validJson": False, "completed": response["ok"]}


class RdshProposer:
    def __init__(self, runner, audit_root: Path):
        self.runner, self.audit_root = runner, audit_root
        self.validation_errors = []
        self._previous_errors = {}
        self._lock = threading.Lock()

    def call(self, mission, context_dir, label, *, system="", timeout=None,
             max_attempts=None, harvest=None):
        if harvest != "context/harness":
            raise ProposerError("this restricted proposer supports harness edits only", attempts=1)
        audit = self.audit_root / label
        workspace = audit / "workspace"
        workspace.mkdir(parents=True, exist_ok=False, mode=0o700)
        source = Path(context_dir)
        for path in source.rglob("*"):
            if path.is_symlink():
                raise ProposerError("symlink in improvement context", attempts=1)
        shutil.copytree(source, workspace / "context")
        current = read_harness(source / "harness")
        stage_key = re.sub(r"\.a\d+$", "", label)
        with self._lock:
            previous_error = self._previous_errors.get(stage_key, "")
        contract = (
            "\n\n# RDSH EDIT TRANSPORT CONTRACT\n"
            "The above mission is the actual Harness² improvement task. Read its context files. "
            "Batch independent context reads by issuing multiple harness2_read tool calls "
            "in the same step, up to eight calls; then inspect their results before dependent reads. "
            "The tool environment is read-only, so return edits in your final answer, not via writes. "
            "Return ONLY JSON with exactly {\"version\":1,\"harness\":{\"relative/path\":\"text\"},"
            "\"notes\":\"specific trajectory evidence for each change\"}. "
            "The harness object is a patch: omitted files are inherited. Allowed paths are ONLY "
            "systemprompt.md, tool-guidance.md, skills/<lowercase_name>/SKILL.md. "
            "Never modify tools, permissions, hooks, authentication, executable scripts, or policies. "
            "Do not paste the task answer into reusable guidance. Keep skills frontmatter name/description "
            "and name each skill in always-on guidance. Each file <=48000 UTF-8 bytes, total <=96000."
        )
        if previous_error:
            contract += (
                "\n\n# PREVIOUS PATCH VALIDATION FAILURE\n"
                + previous_error
                + "\nCorrect this exact JSON/patch error in this upstream retry."
            )
        manifest = "\n\n# AVAILABLE CONTEXT FILES\n" + "\n".join(
            "context/" + p.relative_to(source).as_posix()
            for p in sorted(source.rglob("*")) if p.is_file()
        )
        started = time.monotonic()
        response = self.runner.invoke("improver", workspace,
                                      system + "\n" + mission + contract + manifest,
                                      current, audit / "session", label)
        if not response["ok"]:
            raise ProposerError("rdsh improver session failed", attempts=1)
        try:
            doc = strict_json(response["text"])
            if not isinstance(doc, dict) or set(doc) != {"version", "harness", "notes"}:
                raise ValueError("improvement JSON fields invalid")
            if type(doc["version"]) is not int or doc["version"] != 1 or not isinstance(doc["notes"], str):
                raise ValueError("improvement JSON version/notes invalid")
            validate_tree(doc["harness"])
            merged = {**current, **doc["harness"]}
            validate_tree(merged)
            target = audit / "harvest"
            ht.write_tree(SURFACE, merged, target, stubs=False)
            private_json(audit / "proposal.json", doc)
            return Reply(label=label, text="<notes>" + doc["notes"] + "</notes>", ok=True,
                         wall_s=time.monotonic() - started, attempts=1, channel="rdsh",
                         workspace=target, audit=audit)
        except (ValueError, TypeError) as exc:
            # A failed harvest lets the actual upstream stage retry with feedback.
            error = {"version": 1, "label": label, "stage": stage_key,
                     "code": type(exc).__name__, "message": str(exc)}
            private_json(audit / "validation-error.json", error)
            with self._lock:
                self.validation_errors.append(error)
                self._previous_errors[stage_key] = str(exc)
            return Reply(label=label, text=str(exc), ok=True, attempts=1, channel="rdsh",
                         workspace=None, error=str(exc), audit=audit)


def totals(records):
    usage = {}
    for name in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
        values = [r["usage"][name] for r in records]
        usage[name] = sum(values) if all(v is not None for v in values) else None
    input_parts = [usage[name] for name in ("inputTokens", "cacheReadTokens", "cacheWriteTokens")]
    usage["inputTotalTokens"] = sum(input_parts) if all(v is not None for v in input_parts) else None
    return {"sessions": len(records), "failedSessions": sum(not r["ok"] for r in records),
            "wallMsSum": sum(r["wallMs"] for r in records), "usage": usage, "costUsd": None}


def compare(suite: dict, root: Path, runner, *, frozen_harness: Path | None = None,
            adapter_factory=RdshBenchmarkAdapter) -> dict:
    upstream_commit = verify_upstream()
    supplied_frozen = None
    if frozen_harness is not None:
        if not any(task["split"] == "holdout" for task in suite["tasks"]):
            raise ValueError("frozen-only comparison requires at least one holdout task")
        supplied_frozen = read_harness(frozen_harness)
        if not supplied_frozen:
            raise ValueError("supplied frozen harness contains no Markdown files")
        ht.validate(SURFACE, supplied_frozen, allow_subagents=False)
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(root, 0o700)
    adapter = adapter_factory(suite, root, runner)
    rows, methods, frozen = [], [], supplied_frozen
    fallback_warnings = []
    frozen_origin = None
    started = time.monotonic()
    for task_id in ([] if frozen_harness is not None else adapter.tasks("train")):
        prop = RdshProposer(runner, root / "improvers" / task_id)
        task_root = root / "method" / task_id
        base_id = f"{task_id}-base"
        rd = adapter.execute(task_id, None, base_id)
        base = RunView("base1", base_id, rd, True, adapter.delivered(rd))
        result = recursion.run_parallel(task_id, 1, [base], adapter=adapter, prop=prop,
            work_dir=task_root, run_id_of=lambda label: f"{task_id}-{label}",
            base_tree=dict(BASE_TREE), propose_workers=1, rollout_workers=1)
        pool = selection.selection_pool("agg", 1, result.rollouts, [base])
        chosen = selection.trivial_selection(task_id, 1, "agg", pool, adapter=adapter,
                                              work_dir=task_root)
        # Upstream accounting's cost default is unknown on rdsh; never publish its 0 as cost.
        method_record = result.to_dict()
        for stage in method_record["stages"]:
            stage["usd"] = None
        if method_record["ledger"]:
            method_record["ledger"] = {"upstreamAccountingOnly": True,
                                       "method": "4k rollouts / 3k improvements", "k": 1}
        final = pool.get(chosen.chosen_label)
        final_stage = next((stage for stage in result.stages
                            if stage.label == chosen.chosen_label), None)
        adoption_eligible = bool(chosen.ok and final and final.delivered and final_stage
                                 and not final_stage.fell_back)
        methods.append({"taskId": task_id, "method": method_record,
                        "aggregateAdoptionEligible": adoption_eligible,
                        "proposalValidationErrors": list(prop.validation_errors),
                        "selection": {k: (None if k == "usd" else v)
                                      for k, v in chosen.to_dict().items()}})
        complete = result.ok and not result.fell_back and chosen.ok and all(
            rv.delivered for rv in result.rollouts.values())
        for stage in result.stages:
            if stage.fell_back:
                fallback_warnings.append({"taskId": task_id, "stage": stage.label,
                                          "reason": stage.error})
        for label, rollout in result.rollouts.items():
            if not rollout.delivered:
                fallback_warnings.append({"taskId": task_id, "stage": label,
                                          "reason": rollout.error or "rollout produced no deliverable"})
        rows.append({"taskId": task_id, "split": "train", "mode": "task-local-adaptation",
                     "complete": complete, "adaptationComplete": complete,
                     "baseline": adapter.score(rd, task_id),
                     "improved": adapter.score(final.run_dir, task_id) if final else None})
        if adoption_eligible:
            frozen = dict(result.trees[chosen.chosen_label])
            frozen_origin = {"taskId": task_id, "stage": chosen.chosen_label,
                             "runId": chosen.chosen_run_id,
                             "adaptationComplete": complete,
                             "aggregateFellBack": False}
    if frozen is not None:
        frozen_dir = root / "frozen-harness"
        ht.write_tree(SURFACE, frozen, frozen_dir, stubs=False)
        for task_id in adapter.tasks("holdout"):
            base_dir = adapter.execute(task_id, None, f"{task_id}-base")
            final_dir = adapter.execute(task_id, frozen_dir, f"{task_id}-frozen")
            rows.append({"taskId": task_id, "split": "holdout",
                         "mode": "supplied-frozen-harness" if frozen_harness is not None
                                 else "frozen-training-harness",
                         "complete": adapter.delivered(base_dir) and adapter.delivered(final_dir),
                         "baseline": adapter.score(base_dir, task_id),
                         "improved": adapter.score(final_dir, task_id)})
    else:
        for task_id in adapter.tasks("holdout"):
            rows.append({"taskId": task_id, "split": "holdout", "mode": "not-run",
                         "complete": False, "baseline": None, "improved": None})
    train_ids = set(adapter.tasks("train"))
    holdout_records = [r for r in runner.records if any(
        r["label"].startswith(task_id + "-") for task_id in adapter.tasks("holdout"))]
    train_records = [r for r in runner.records if r not in holdout_records]
    overhead = [r for r in train_records if r["role"] == "improver" or not any(
        r["label"] == f"{task_id}-base" for task_id in train_ids)]
    report = {"version": 1, "suite": suite["name"], "suiteSha256": fingerprint(suite),
              "runId": root.name, "upstreamCommit": upstream_commit,
              "method": "frozen-only" if frozen_harness is not None else
                        "harness2.core.recursion.run_parallel(k=1) + trivial_selection",
              "model": runner.model, "provider": runner.provider,
              "complete": all(row["complete"] for row in rows),
              "adaptationComplete": (None if frozen_harness is not None else
                                     all(row["complete"] for row in rows if row["split"] == "train")),
              "fallbackWarnings": fallback_warnings,
              "costUsd": None, "wallMs": (time.monotonic() - started) * 1000,
              "training": totals(train_records), "trainingAdditionalOverBaseline": totals(overhead),
              "holdout": totals(holdout_records), "total": totals(runner.records),
              "rows": rows, "methods": methods, "sessions": runner.records,
              "frozenHarnessSha256": fingerprint(frozen) if frozen is not None else None,
              "frozenHarnessOrigin": frozen_origin,
              "frozenHarnessSource": {
                  "selection": "explicit supplied path; no adoption inferred",
                  "path": str(frozen_harness.absolute()),
                  "sha256": fingerprint(supplied_frozen),
              } if frozen_harness is not None else None,
              "limitations": ["Small deterministic JSON fixture suite; no statistical quality claim.",
                               ("Explicit supplied harness; no training/adaptation ran in this report."
                                if frozen_harness is not None else
                                "Train results adapt on the same task; holdout does not adapt."),
                               "Provider cost is unavailable, recorded as null.",
                               "Read-only fixture tools only; ordinary shell tools are outside this comparison.",
                               ("Prior training/model/selection provenance is supplied separately, not inferred."
                                if frozen_harness is not None else
                                "No cross-task library/reflection; k=1 single final uses upstream trivial selection.")]}
    private_json(root / "report.json", report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout-ms", type=int, default=120_000)
    parser.add_argument("--max-steps", type=int, default=12)
    parser.add_argument("--node", default="node")
    parser.add_argument("--frozen-harness", type=Path,
                        help="skip adaptation; compare baseline vs this validated harness on holdouts only")
    args = parser.parse_args(argv)
    if not 1 <= args.max_steps <= 32 or not 1000 <= args.timeout_ms <= 600_000:
        parser.error("max-steps must be 1..32 and timeout-ms 1000..600000")
    suite = load_suite(args.suite)
    runner = JsonRunner(args.runner, args.provider, args.model, args.timeout_ms,
                        args.max_steps, args.node)
    report = compare(suite, args.output.resolve(), runner, frozen_harness=args.frozen_harness)
    print(json.dumps({"report": str(args.output.resolve() / "report.json"),
                      "complete": report["complete"], "rows": report["rows"]}, indent=2))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
