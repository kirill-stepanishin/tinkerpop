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
"""Translate a canonical cell into a native GLV invocation.

Each GLV exposes the same load generator with a different CLI dialect. This
module owns that dialect table (previously spread across ``common.sh`` and
the ``cat*.sh`` scripts) and turns a canonical cell (see
:data:`orchestrator.matrix.CELL_KEYS`) plus the branch :class:`Config` into a
concrete ``(argv_list, env_dict)`` pair, ready for ``subprocess.run``.

Dialect summary (this branch — HTTP, ``concurrency_model: pool``):

============ ============== ==================== ====================
GLV          CLI style      mode flag            pool flag
============ ============== ==================== ====================
java         positional kv  ``testType 0|1``     ``min/maxConnectionPoolSize``
go           ``--flag``     ``--test-type``      ``--pool-size``
dotnet       ``--flag``     ``--test-type``      ``--pool-size``
javascript   ``--flag``     ``--test-type``      ``--pool-size``
python       ``--flag``     ``--test-type``      ``--pool-size``
============ ============== ==================== ====================

Cross-branch knobs that the *config* drives (not hard-coded here):
  * ``config.host``                — server host passed to every GLV.
  * ``config.transport``           — python gets ``--transport ws`` only when
    the branch transport is websockets (3.7); on 4.0 (http) it is omitted.
  * ``config.concurrency_model``   — ``pool`` (4.0/HTTP) maps concurrency
    C onto a connection pool of size C. ``multiplex`` (3.7/WS) realizes C
    in-flight requests via pool × maxInProcess (java/dotnet) or a small fixed
    pool driven by parallelism (js); see :func:`_multiplex_knobs`.

Concurrency realization (model == ``pool``):
  * latency cells run sequentially: pool = 1, no parallelism arg.
  * scaling-curve cells (``point_type == "concurrency"``) derive
    ``pool = concurrency`` and ``parallelism = concurrency`` (java caps
    parallelism at 64 — submission threads, not connections, drive HTTP
    concurrency there) and create the pool *eagerly* (java sets both
    ``min`` and ``maxConnectionPoolSize``).
  * peak-throughput / pool-sensitivity cells carry an explicit ``pool`` and
    ``parallelism`` and grow the pool *lazily* (java sets only
    ``maxConnectionPoolSize``).
"""

from typing import Dict, List, Optional, Tuple

# Java caps submission parallelism at this value on HTTP: beyond it, more
# submission threads stop helping (the pool, sized to C, supplies concurrency).
_JAVA_MAX_PARALLELISM = 64

# Default per-request timeout (ms) for the .NET app. The old common.sh
# wrapper always launched .NET with ``--timeout 600000``; we preserve that
# floor when a cell does not specify its own timeout.
_DOTNET_DEFAULT_TIMEOUT_MS = 600000

# ── WebSocket-multiplexing knobs (concurrency_model == "multiplex", 3.7) ──
# Lifted verbatim from the old 3.7 ``cat4-scaling-curve.sh``. There, each GLV
# realises C in-flight requests over websockets differently:
#   * Java / .NET multiplex: pool × maxInProcess ≈ C, with maxInProcess
#     capped at a per-GLV ceiling and the pool sized to cover the remainder
#     (``POOL = ceil(C / cap)``; for C ≤ cap, ``POOL = 1`` and the single
#     connection carries ``maxInProcess = C``). Java pins submission
#     ``parallelism`` at 16 (connections, not threads, drive concurrency);
#     .NET drives ``parallelism = C``.
#   * JS multiplex: a small fixed pool with ``parallelism = C`` — no explicit
#     in-process knob.
#   * Go / Python: no multiplexing (``pool = C``); their ``pool``-model argv
#     already matches cat4, so they need no multiplex branch here.
_JAVA_MULTIPLEX_MAX_IN_PROCESS = 64
_JAVA_MULTIPLEX_PARALLELISM = 16
_DOTNET_MULTIPLEX_MAX_IN_PROCESS = 16
_JS_MULTIPLEX_POOL_SIZE = 8


def _multiplex_knobs(concurrency: int, max_in_process_cap: int) -> Tuple[int, int]:
    """Map concurrency ``C`` onto ``(pool, max_in_process)`` for WS multiplexing.

    Mirrors the old ``cat4-scaling-curve.sh`` arithmetic exactly::

        MAX_IP=cap
        POOL=$(( (C + MAX_IP - 1) / MAX_IP ))   # ceil(C / cap)
        if [ $C -le $MAX_IP ]; then
            MAX_IP=$C
            POOL=1
        fi

    So for ``C <= cap`` a single connection carries all ``C`` in-process
    requests; beyond ``cap`` the in-process count pins at ``cap`` and the pool
    grows to ``ceil(C / cap)`` (e.g. java ``C=256`` → ``pool=4, maxIP=64``).
    """
    if concurrency <= max_in_process_cap:
        return 1, concurrency
    pool = (concurrency + max_in_process_cap - 1) // max_in_process_cap
    return pool, max_in_process_cap


def _launcher_path(config, glv: str) -> str:
    """Resolved launcher path for ``glv``.

    Uses the path discovered by :mod:`orchestrator.config` when the app is
    built; otherwise falls back to the configured pattern resolved against
    the repo root so ``--dry-run`` still shows a meaningful command even
    before the apps are built (the harness is run-only).
    """
    launcher = config.launcher(glv)
    if launcher.path is not None:
        return str(launcher.path)
    return str(config.repo_root / launcher.pattern)


def _derive_concurrency(cell: dict, glv: str) -> Tuple[Optional[int], Optional[int]]:
    """Derive ``(pool, parallelism)`` for a throughput cell.

    Honours an explicitly-set ``pool``/``parallelism`` (peak-throughput,
    pool-sensitivity) and otherwise derives them from ``concurrency`` under
    the ``pool`` concurrency model (scaling-curve).
    """
    pool = cell["pool"]
    parallelism = cell["parallelism"]
    concurrency = cell["concurrency"]

    if pool is None and concurrency is not None:
        pool = concurrency
    if parallelism is None and concurrency is not None:
        parallelism = (
            min(concurrency, _JAVA_MAX_PARALLELISM) if glv == "java" else concurrency
        )
    return pool, parallelism


# ─────────────────────────────────────────────────────────────────────────
# Java — positional ``key value`` pairs.
# ─────────────────────────────────────────────────────────────────────────
def _build_java(cell: dict, config) -> Tuple[List[str], Dict[str, str]]:
    argv: List[str] = [_launcher_path(config, "java")]
    # common.sh's run_java always prepends this guard so the warmup gate
    # never aborts a measured run.
    argv += ["minExpectedRps", "1"]

    if cell["metric"] == "latency":
        # Sequential, single connection. Pool created eagerly at size 1.
        argv += ["testType", "0"]
        argv += ["host", config.host]
        argv += ["script", cell["script"]]
        argv += ["parallelism", "1"]
        argv += ["minConnectionPoolSize", "1", "maxConnectionPoolSize", "1"]
        argv += ["warmups", str(cell["warmups"])]
        argv += ["executions", str(cell["executions"])]
        if cell["timeout"] is not None:
            argv += ["timeout", str(cell["timeout"])]
        return argv, {}

    # Throughput.
    if config.concurrency_model == "multiplex":
        return _build_java_multiplex(argv, cell, config)

    pool, parallelism = _derive_concurrency(cell, "java")
    argv += ["testType", "1"]
    argv += ["host", config.host]
    if parallelism is not None:
        argv += ["parallelism", str(parallelism)]
    if cell["requests"] is not None:
        argv += ["requests", str(cell["requests"])]
    argv += ["executions", str(cell["executions"])]
    argv += ["warmups", str(cell["warmups"])]
    if pool is not None:
        if cell["point_type"] == "concurrency":
            # Scaling curve: create the pool eagerly (min == max == C).
            argv += [
                "minConnectionPoolSize",
                str(pool),
                "maxConnectionPoolSize",
                str(pool),
            ]
        else:
            # Peak throughput / pool sensitivity: lazy growth (cap only).
            argv += ["maxConnectionPoolSize", str(pool)]
    return argv, {}


def _build_java_multiplex(
    argv: List[str], cell: dict, config
) -> Tuple[List[str], Dict[str, str]]:
    """Java throughput under WS multiplexing (3.7 ``cat4`` realization).

    ``argv`` already carries ``[launcher, "minExpectedRps", "1"]`` from the
    caller. Concurrency-driven (scaling-curve) cells derive
    ``pool``/``maxInProcessPerConnection`` from ``concurrency`` via
    :func:`_multiplex_knobs`; cells with an explicit ``pool`` (peak-throughput,
    pool-sensitivity) pass it through without in-process knobs. Submission
    ``parallelism`` is pinned at 16 — connections, not threads, drive
    concurrency over websockets.
    """
    concurrency = cell["concurrency"]
    argv += ["testType", "1"]
    argv += ["host", config.host]
    if cell["requests"] is not None:
        argv += ["requests", str(cell["requests"])]
    argv += ["executions", str(cell["executions"])]
    argv += ["warmups", str(cell["warmups"])]
    argv += ["parallelism", str(_JAVA_MULTIPLEX_PARALLELISM)]

    if concurrency is not None:
        pool, max_ip = _multiplex_knobs(concurrency, _JAVA_MULTIPLEX_MAX_IN_PROCESS)
        argv += ["minConnectionPoolSize", str(pool), "maxConnectionPoolSize", str(pool)]
        argv += ["minInProcessPerConnection", "1", "maxInProcessPerConnection", str(max_ip)]
        argv += [
            "minSimultaneousUsagePerConnection",
            str(max_ip),
            "maxSimultaneousUsagePerConnection",
            str(max_ip),
        ]
    elif cell["pool"] is not None:
        pool = cell["pool"]
        argv += ["minConnectionPoolSize", str(pool), "maxConnectionPoolSize", str(pool)]
    return argv, {}


# ─────────────────────────────────────────────────────────────────────────
# Shared ``--flag`` dialect (go / dotnet / javascript / python).
# ─────────────────────────────────────────────────────────────────────────
def _build_flag_style(
    cell: dict,
    config,
    glv: str,
    *,
    leading: Optional[List[str]] = None,
    trailing: Optional[List[str]] = None,
) -> List[str]:
    """Build the common ``--flag`` argv used by every non-java GLV.

    ``leading`` is inserted right after the launcher (used by .NET's
    ``--timeout``); ``trailing`` is appended at the end (used by python's
    ``--transport``/``--concurrency``).
    """
    argv: List[str] = [_launcher_path(config, glv)]
    if leading:
        argv += leading

    if cell["metric"] == "latency":
        argv += ["--test-type", "latency"]
        argv += ["--host", config.host]
        argv += ["--script", cell["script"]]
        argv += ["--pool-size", "1"]
        argv += ["--parallelism", "1"]
        argv += ["--warmups", str(cell["warmups"])]
        argv += ["--executions", str(cell["executions"])]
        # .NET carries its timeout in ``leading``; the rest pass it here when
        # the cell sets one (matches cat1's latency-medium scripts).
        if cell["timeout"] is not None and glv != "dotnet":
            argv += ["--timeout", str(cell["timeout"])]
    else:
        pool, parallelism = _derive_concurrency(cell, glv)
        argv += ["--test-type", "throughput"]
        argv += ["--host", config.host]
        if parallelism is not None:
            argv += ["--parallelism", str(parallelism)]
        if pool is not None:
            argv += ["--pool-size", str(pool)]
        if cell["requests"] is not None:
            argv += ["--requests", str(cell["requests"])]
        argv += ["--executions", str(cell["executions"])]
        argv += ["--warmups", str(cell["warmups"])]
        # Throughput runs disable the warmup RPS gate (cat4/cat5).
        argv += ["--min-expected-rps", "1"]

    if trailing:
        argv += trailing
    return argv


def _build_go(cell: dict, config) -> Tuple[List[str], Dict[str, str]]:
    return _build_flag_style(cell, config, "go"), {}


def _build_dotnet(cell: dict, config) -> Tuple[List[str], Dict[str, str]]:
    # common.sh's run_dotnet exports server-GC + a large min threadpool and
    # always launches with a 600s timeout floor.
    timeout = cell["timeout"] if cell["timeout"] is not None else _DOTNET_DEFAULT_TIMEOUT_MS
    env = {"DOTNET_GCServer": "1", "DOTNET_ThreadPool_MinThreads": "1024"}
    if config.concurrency_model == "multiplex" and cell["metric"] != "latency":
        argv = _build_dotnet_multiplex(cell, config, timeout)
    else:
        argv = _build_flag_style(
            cell, config, "dotnet", leading=["--timeout", str(timeout)]
        )
    return argv, env


def _build_dotnet_multiplex(cell: dict, config, timeout: int) -> List[str]:
    """.NET throughput under WS multiplexing (3.7 ``cat4`` realization).

    ``pool``/``--max-in-process`` derive from ``concurrency`` (cap 16) for
    scaling-curve cells; explicit-``pool`` cells pass the pool through without
    an in-process knob. Submission ``parallelism`` tracks ``C`` directly.
    """
    argv: List[str] = [_launcher_path(config, "dotnet"), "--timeout", str(timeout)]
    concurrency = cell["concurrency"]
    max_ip: Optional[int] = None
    if concurrency is not None:
        pool, max_ip = _multiplex_knobs(concurrency, _DOTNET_MULTIPLEX_MAX_IN_PROCESS)
        parallelism: Optional[int] = concurrency
    else:
        pool = cell["pool"]
        parallelism = cell["parallelism"]

    argv += ["--test-type", "throughput"]
    argv += ["--host", config.host]
    if parallelism is not None:
        argv += ["--parallelism", str(parallelism)]
    if pool is not None:
        argv += ["--pool-size", str(pool)]
    if max_ip is not None:
        argv += ["--max-in-process", str(max_ip)]
    if cell["requests"] is not None:
        argv += ["--requests", str(cell["requests"])]
    argv += ["--executions", str(cell["executions"])]
    argv += ["--warmups", str(cell["warmups"])]
    argv += ["--min-expected-rps", "1"]
    return argv


def _build_javascript(cell: dict, config) -> Tuple[List[str], Dict[str, str]]:
    if config.concurrency_model == "multiplex" and cell["metric"] != "latency":
        return _build_javascript_multiplex(cell, config), {}
    return _build_flag_style(cell, config, "javascript"), {}


def _build_javascript_multiplex(cell: dict, config) -> List[str]:
    """JS throughput under WS multiplexing (3.7 ``cat4`` realization).

    JS multiplexes via a small fixed pool driven by ``parallelism = C`` and
    has no explicit in-process knob. Explicit-``pool`` cells (pool-sensitivity)
    override the fixed pool size.
    """
    argv: List[str] = [_launcher_path(config, "javascript")]
    concurrency = cell["concurrency"]
    parallelism = concurrency if concurrency is not None else cell["parallelism"]
    pool = cell["pool"] if cell["pool"] is not None else _JS_MULTIPLEX_POOL_SIZE

    argv += ["--test-type", "throughput"]
    argv += ["--host", config.host]
    if parallelism is not None:
        argv += ["--parallelism", str(parallelism)]
    argv += ["--pool-size", str(pool)]
    if cell["requests"] is not None:
        argv += ["--requests", str(cell["requests"])]
    argv += ["--executions", str(cell["executions"])]
    argv += ["--warmups", str(cell["warmups"])]
    argv += ["--min-expected-rps", "1"]
    return argv


def _build_python(cell: dict, config) -> Tuple[List[str], Dict[str, str]]:
    trailing: List[str] = []
    # The python app has no native concurrency knob (only pool + parallelism),
    # so for scaling-curve cells we stamp the canonical concurrency through
    # the dedicated passthrough flag added in Phase 1 (provenance only).
    if cell["metric"] != "latency" and cell["concurrency"] is not None:
        trailing += ["--concurrency", str(cell["concurrency"])]
    # Websocket branches (3.7) need an explicit transport; HTTP (4.0) does not.
    if config.transport == "ws":
        trailing += ["--transport", "ws"]
    return _build_flag_style(cell, config, "python", trailing=trailing), {}


_DISPATCH = {
    "java": _build_java,
    "go": _build_go,
    "dotnet": _build_dotnet,
    "javascript": _build_javascript,
    "python": _build_python,
}


def build_invocation(cell: dict, config) -> Tuple[List[str], Dict[str, str]]:
    """Build the native ``(argv, env)`` for a canonical ``cell``.

    ``argv`` is a list (never a shell string) so callers can pass it straight
    to ``subprocess.run`` without shell interpolation. ``env`` holds only the
    *extra* environment variables to overlay on the process environment
    (empty for every GLV but .NET).
    """
    glv = cell["glv"]
    builder = _DISPATCH.get(glv)
    if builder is None:
        raise ValueError("no adapter for GLV: {!r}".format(glv))
    return builder(cell, config)
