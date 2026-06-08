#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
#
"""Execute canonical cells: launch, capture, parse, score, record.

For each resolved cell the runner:

1. Builds the native ``(argv, env)`` via :func:`orchestrator.adapters.build_invocation`.
2. Runs it with :func:`subprocess.run` under a timeout, capturing stdout/stderr
   and *teeing* the captured output to ``<output_dir>/logs/<run_id>-<glv>-<test>-<point>.log``.
3. Greps the single ``RESULT_JSON:`` line (see ``bench/SCHEMA.md``). If it is
   missing — or the process timed out / failed to launch — the cell is marked
   **failed**, logged, and the batch *continues* (one bad cell never aborts a
   whole run).
4. Computes mean / median / population-stddev and a nearest-rank p99 over the
   raw ``measurements``.
5. Appends exactly one wide row to the ledger (see :mod:`orchestrator.ledger`).

Provenance (git sha + dirty flag, host, run id, label) is captured once per
batch and stamped onto every row. A dirty working tree with no ``--label`` is
warned about, since the recorded git sha alone will not capture uncommitted
changes.
"""

import json
import math
import os
import statistics
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .adapters import build_invocation
from . import ledger

# Subprocess timeout (seconds) when a cell does not carry its own ``timeout``
# (which is expressed in milliseconds, matching the apps' per-request budget).
DEFAULT_SUBPROCESS_TIMEOUT_S = 3600.0
# Extra wall-clock head-room added on top of a cell's own (ms) timeout so the
# app gets to print its RESULT_JSON line before we pull the plug.
SUBPROCESS_TIMEOUT_BUFFER_S = 120.0

# The one-line machine-readable marker every profiling app prints (SCHEMA.md).
RESULT_MARKER = "RESULT_JSON:"


class ResultParseError(Exception):
    """Raised when stdout does not carry exactly one valid RESULT_JSON line."""


# ─────────────────────────────────────────────────────────────────────────
# Provenance helpers.
# ─────────────────────────────────────────────────────────────────────────
def make_run_id() -> str:
    """A sortable, collision-resistant run id: ``YYYYMMDD-HHMMSS-<rand>`` (UTC)."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return "{}-{}".format(stamp, uuid.uuid4().hex[:6])


def _git(repo_root, *args) -> Optional[subprocess.CompletedProcess]:
    try:
        return subprocess.run(
            ["git", "-C", str(repo_root), *args],
            capture_output=True,
            text=True,
        )
    except OSError:
        return None


def git_sha(repo_root) -> str:
    """Current HEAD sha, or ``"unknown"`` outside a git checkout."""
    proc = _git(repo_root, "rev-parse", "HEAD")
    if proc is not None and proc.returncode == 0:
        return proc.stdout.strip()
    return "unknown"


def git_dirty(repo_root) -> bool:
    """True when the working tree has uncommitted changes."""
    proc = _git(repo_root, "status", "--porcelain")
    if proc is not None and proc.returncode == 0:
        return bool(proc.stdout.strip())
    return False


# ─────────────────────────────────────────────────────────────────────────
# Parsing + statistics.
# ─────────────────────────────────────────────────────────────────────────
def parse_result_json(stdout: str) -> dict:
    """Extract and parse the single ``RESULT_JSON:`` line from ``stdout``.

    Raises :class:`ResultParseError` if zero or more than one marker line is
    present, or if the payload is not valid JSON.
    """
    payloads: List[str] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith(RESULT_MARKER):
            payloads.append(stripped[len(RESULT_MARKER):].strip())

    if not payloads:
        raise ResultParseError("no RESULT_JSON line found in stdout")
    if len(payloads) > 1:
        raise ResultParseError(
            "expected exactly one RESULT_JSON line, found {}".format(len(payloads))
        )

    try:
        return json.loads(payloads[0])
    except json.JSONDecodeError as exc:
        raise ResultParseError("RESULT_JSON payload is not valid JSON: {}".format(exc))


def percentile_nearest_rank(values: Sequence[float], pct: float) -> float:
    """Nearest-rank percentile.

    ``rank = ceil(pct/100 * N)`` (clamped to ``[1, N]``), returning the
    ``rank``-th smallest value. For p99 of N values this is the largest value
    whenever ``N <= 100``.
    """
    ordered = sorted(values)
    n = len(ordered)
    rank = math.ceil((pct / 100.0) * n)
    rank = max(1, min(rank, n))
    return ordered[rank - 1]


def compute_stats(measurements: Sequence) -> Dict[str, Optional[float]]:
    """Compute mean / median / population-stddev / p99 / min / max.

    Returns ``None`` for every statistic when ``measurements`` is empty.
    Population stddev (``statistics.pstdev``) is used because the measured
    executions are the full population for this cell, not a sample; it is
    well-defined (``0.0``) for a single measurement.
    """
    if not measurements:
        return {
            "count": 0,
            "mean": None,
            "median": None,
            "stddev": None,
            "p99": None,
            "min": None,
            "max": None,
        }

    values = [float(m) for m in measurements]
    return {
        "count": len(values),
        "mean": statistics.mean(values),
        "median": statistics.median(values),
        "stddev": statistics.pstdev(values),
        "p99": percentile_nearest_rank(values, 99),
        "min": min(values),
        "max": max(values),
    }


# ─────────────────────────────────────────────────────────────────────────
# Cell execution.
# ─────────────────────────────────────────────────────────────────────────
def _point_label(cell: dict) -> str:
    """Filesystem-safe label for a cell's point (for the log filename)."""
    value = cell.get("point_value")
    if value is None:
        value = cell.get("point_type") or "na"
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in str(value))
    safe = safe.strip("_")
    return safe or "na"


def _subprocess_timeout(cell: dict) -> float:
    """Wall-clock timeout (seconds) for a cell's subprocess.

    A cell's own ``timeout`` is in *milliseconds* and expresses the app's
    *per-iteration* request budget (it is forwarded to the app as ``timeout``/
    ``--timeout`` by the adapters) — NOT a whole-run wall-clock ceiling. A
    single cell, however, runs ``warmups + executions`` iterations
    back-to-back, so the kill budget must be the per-iteration budget scaled by
    that iteration count before the safety margin is added. Without the scale a
    slow-but-valid multi-iteration cell can be SIGKILLed mid-run. Absent a cell
    timeout, fall back to the module default.
    """
    cell_timeout_ms = cell.get("timeout")
    if cell_timeout_ms is None:
        return DEFAULT_SUBPROCESS_TIMEOUT_S
    iterations = (cell.get("warmups") or 0) + (cell.get("executions") or 0)
    iterations = max(1, iterations)
    per_iteration_s = float(cell_timeout_ms) / 1000.0
    return (per_iteration_s * iterations) + SUBPROCESS_TIMEOUT_BUFFER_S


def _write_log(log_path: Path, argv, env_overlay, stdout: str, stderr: str) -> None:
    """Tee captured output (plus the invocation header) to the raw log."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w") as fh:
        fh.write("# argv: {}\n".format(argv))
        if env_overlay:
            fh.write("# env:  {}\n".format(env_overlay))
        fh.write("# ---- stdout ----\n")
        fh.write(stdout or "")
        if not (stdout or "").endswith("\n"):
            fh.write("\n")
        fh.write("# ---- stderr ----\n")
        fh.write(stderr or "")
        if stderr and not stderr.endswith("\n"):
            fh.write("\n")


def run_cell(
    cell: dict,
    config,
    *,
    run_id: str,
    label: Optional[str],
    sha: str,
    dirty: bool,
    logs_dir: Path,
    echo: bool = False,
) -> Tuple[Dict, str]:
    """Execute one cell and return ``(ledger_row, status)``.

    ``status`` is ``"ok"`` when a valid RESULT_JSON line was parsed, else
    ``"failed"``. A failed cell still yields a fully-formed ledger row (with
    empty stats and an ``error_reason``) so the failure is recorded rather
    than silently dropped.
    """
    glv = cell["glv"]
    test = cell["test"]
    argv, env_overlay = build_invocation(cell, config)

    full_env = dict(os.environ)
    full_env.update(env_overlay)

    point = _point_label(cell)
    log_path = logs_dir / "{}-{}-{}-{}.log".format(run_id, glv, test, point)
    timeout_s = _subprocess_timeout(cell)

    status = "ok"
    error_reason = ""
    returncode: Optional[int] = None
    stdout = ""
    stderr = ""
    result: Optional[dict] = None

    try:
        proc = subprocess.run(
            argv,
            env=full_env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        returncode = proc.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = _as_text(exc.stdout)
        stderr = _as_text(exc.stderr)
        status = "failed"
        error_reason = "timeout after {:.0f}s".format(timeout_s)
    except OSError as exc:
        status = "failed"
        error_reason = "launch failed: {}".format(exc)

    _write_log(log_path, argv, env_overlay, stdout, stderr)
    if echo and stdout:
        sys.stdout.write(stdout)

    if status == "ok":
        try:
            result = parse_result_json(stdout)
        except ResultParseError as exc:
            status = "failed"
            error_reason = str(exc)

    measurements = (result or {}).get("measurements") or []
    errors = (result or {}).get("errors") or []
    # Stats over the raw measurements can still blow up on a malformed-but-
    # present payload (e.g. non-numeric / null measurement values that parsed
    # as valid JSON but are not floats). Such a cell must be marked failed on
    # its own — never propagate and abort the batch.
    try:
        stats = compute_stats(measurements)
    except Exception as exc:  # noqa: BLE001 — invariant: one bad cell never aborts the run
        if status == "ok":
            status = "failed"
            error_reason = "stats computation failed: {}".format(exc)
        stats = compute_stats([])

    row = {
        "run_id": run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "host": config.host,
        "git_sha": sha,
        "dirty": dirty,
        "glv": glv,
        "test": test,
        "metric": cell.get("metric"),
        "point_type": cell.get("point_type"),
        "point_value": cell.get("point_value"),
        "script": cell.get("script"),
        "concurrency": cell.get("concurrency"),
        "pool": cell.get("pool"),
        "parallelism": cell.get("parallelism"),
        "requests": cell.get("requests"),
        "warmups": cell.get("warmups"),
        "executions": cell.get("executions"),
        "timeout": cell.get("timeout"),
        "status": status,
        "returncode": returncode,
        "error_reason": error_reason,
        "count": stats["count"],
        "mean": stats["mean"],
        "median": stats["median"],
        "stddev": stats["stddev"],
        "p99": stats["p99"],
        "min": stats["min"],
        "max": stats["max"],
        "measurements": measurements,
        "errors": errors,
        "log_path": str(log_path),
    }
    return row, status


def _as_text(value) -> str:
    """Coerce captured stream (bytes/str/None) to str."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def _failed_row(
    cell: dict,
    config,
    *,
    run_id: str,
    label: Optional[str],
    sha: str,
    dirty: bool,
    error_reason: str,
) -> Dict:
    """A fully-formed, empty-stats ledger row for a cell that failed outright.

    Used as the batch-level backstop: if ``run_cell`` raises for any reason
    (rather than returning its own failed row), the batch still records the
    failure and moves on, upholding the invariant that one bad cell never
    aborts the run.
    """
    stats = compute_stats([])
    return {
        "run_id": run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "host": config.host,
        "git_sha": sha,
        "dirty": dirty,
        "glv": cell.get("glv"),
        "test": cell.get("test"),
        "metric": cell.get("metric"),
        "point_type": cell.get("point_type"),
        "point_value": cell.get("point_value"),
        "script": cell.get("script"),
        "concurrency": cell.get("concurrency"),
        "pool": cell.get("pool"),
        "parallelism": cell.get("parallelism"),
        "requests": cell.get("requests"),
        "warmups": cell.get("warmups"),
        "executions": cell.get("executions"),
        "timeout": cell.get("timeout"),
        "status": "failed",
        "returncode": None,
        "error_reason": error_reason,
        "count": stats["count"],
        "mean": stats["mean"],
        "median": stats["median"],
        "stddev": stats["stddev"],
        "p99": stats["p99"],
        "min": stats["min"],
        "max": stats["max"],
        "measurements": [],
        "errors": [],
        "log_path": "",
    }


def run_batch(
    cells: List[dict],
    config,
    *,
    label: Optional[str] = None,
    output_dir=None,
    echo: bool = True,
) -> Dict:
    """Execute every cell, appending one ledger row each.

    Returns a summary dict: ``{run_id, total, ok, failed, ledger_path,
    output_dir}``. Failed cells are counted but never abort the batch.
    """
    out_dir = Path(output_dir).expanduser() if output_dir else Path(config.output_dir)
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    run_id = make_run_id()
    sha = git_sha(config.repo_root)
    dirty = git_dirty(config.repo_root)

    if dirty and not label:
        print(
            "WARNING: working tree is dirty and no --label was given; the "
            "recorded git sha will not capture uncommitted changes.",
            file=sys.stderr,
        )

    led_path = ledger.ledger_path(out_dir)
    ok = 0
    failed = 0

    for cell in cells:
        try:
            row, status = run_cell(
                cell,
                config,
                run_id=run_id,
                label=label,
                sha=sha,
                dirty=dirty,
                logs_dir=logs_dir,
                echo=echo,
            )
        except Exception as exc:  # noqa: BLE001 — invariant: one bad cell never aborts the batch
            status = "failed"
            row = _failed_row(
                cell,
                config,
                run_id=run_id,
                label=label,
                sha=sha,
                dirty=dirty,
                error_reason="run_cell crashed: {}".format(exc),
            )
        ledger.append_row(led_path, row)
        if status == "ok":
            ok += 1
        else:
            failed += 1
            print(
                "FAILED: {} {} ({}): {}".format(
                    cell.get("glv"),
                    cell.get("test"),
                    _point_label(cell),
                    row["error_reason"],
                ),
                file=sys.stderr,
            )

    return {
        "run_id": run_id,
        "total": len(cells),
        "ok": ok,
        "failed": failed,
        "ledger_path": led_path,
        "output_dir": out_dir,
    }
