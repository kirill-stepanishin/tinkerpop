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
"""Load ``matrix.yaml`` and resolve it into canonical benchmark cells.

The matrix encodes the four test categories as data. :func:`resolve_cells`
expands a (filtered) matrix into a flat list of canonical cell dicts — one
per concrete GLV/point combination — that downstream phases turn into native
invocations (Phase 4) and execute (Phase 5).

A *canonical cell* always carries the same keys (see :data:`CELL_KEYS`);
fields that a given test does not constrain are left ``None`` so that later
phases (adapters) can derive them from ``config`` (e.g. pool/parallelism from
the branch's ``concurrency_model``, or latency's implicit ``pool=1``).
"""

from pathlib import Path
from typing import Dict, List, Optional, Sequence

import yaml

from .config import GLVS

# bench/orchestrator/matrix.py -> bench/matrix.yaml is one parent up.
_BENCH_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MATRIX_PATH = _BENCH_DIR / "matrix.yaml"

# Every resolved cell carries exactly these keys.
CELL_KEYS = (
    "test",
    "glv",
    "metric",
    "point_type",
    "point_value",
    "script",
    "concurrency",
    "pool",
    "parallelism",
    "requests",
    "warmups",
    "executions",
    "timeout",
)


def load_matrix(matrix_path: Optional[str] = None) -> dict:
    """Load ``matrix.yaml`` and return its parsed mapping.

    Raises ``FileNotFoundError`` if the file is missing and ``ValueError`` on
    malformed content.
    """
    path = Path(matrix_path).resolve() if matrix_path else DEFAULT_MATRIX_PATH
    if not path.exists():
        raise FileNotFoundError("matrix file not found: {}".format(path))

    with open(path, "r") as fh:
        raw = yaml.safe_load(fh) or {}

    if not isinstance(raw, dict):
        raise ValueError("matrix root must be a mapping: {}".format(path))
    return raw


def _cell(**kwargs) -> dict:
    """Build a canonical cell with all keys present (unset -> ``None``)."""
    cell = {key: None for key in CELL_KEYS}
    cell.update(kwargs)
    return cell


def _match(filter_values: Optional[Sequence], value) -> bool:
    """True when no filter is active or ``value`` is in the filter list."""
    if not filter_values:
        return True
    return value in filter_values


def _tier_lookup(tier: Optional[dict], concurrency: int) -> Optional[int]:
    """Resolve a request count from a ``<=N`` / ``>`` tier table.

    Keys are evaluated by ascending threshold: the value of the smallest
    ``"<=N"`` whose ``N >= concurrency`` wins; if none match, the ``">"``
    catch-all value is used.
    """
    if not tier:
        return None

    bounded = []
    catch_all = None
    for key, val in tier.items():
        text = str(key).strip()
        if text == ">":
            catch_all = val
        elif text.startswith("<="):
            bounded.append((int(text[2:]), val))

    for threshold, val in sorted(bounded):
        if concurrency <= threshold:
            return val
    return catch_all


def _select_glvs(spec: dict, glv_filter: Optional[Sequence]) -> List[str]:
    """GLVs a test applies to, narrowed by ``--glv`` (matrix order preserved)."""
    declared = spec.get("glvs") or list(GLVS)
    return [glv for glv in declared if _match(glv_filter, glv)]


def _resolve_test(test_name: str, spec: dict, filters: dict) -> List[dict]:
    """Expand a single test spec into canonical cells."""
    metric = spec.get("metric")
    warmups = spec.get("warmups")
    executions = spec.get("executions")
    timeout = spec.get("timeout")
    glvs = _select_glvs(spec, filters.get("glv"))

    points = spec.get("points") or {}
    sweep = spec.get("sweep") or {}
    cells: List[dict] = []

    if "size" in points:
        # Latency points: one script per size, run for every GLV. pool/
        # concurrency/parallelism are left for the adapter (latency => pool 1).
        size_filter = filters.get("size")
        for size_name, gremlin in points["size"].items():
            if not _match(size_filter, size_name):
                continue
            for glv in glvs:
                cells.append(
                    _cell(
                        test=test_name,
                        glv=glv,
                        metric=metric,
                        point_type="size",
                        point_value=size_name,
                        script=gremlin,
                        warmups=warmups,
                        executions=executions,
                        timeout=timeout,
                    )
                )

    elif "concurrency" in sweep:
        # Scaling curve: sweep concurrency, request count tiered per GLV.
        # pool/parallelism derive from concurrency in the adapter.
        conc_filter = filters.get("concurrency")
        tiers = spec.get("requests_by_concurrency") or {}
        for glv in glvs:
            tier = tiers.get(glv, tiers.get("default"))
            for concurrency in sweep["concurrency"]:
                if not _match(conc_filter, concurrency):
                    continue
                cells.append(
                    _cell(
                        test=test_name,
                        glv=glv,
                        metric=metric,
                        point_type="concurrency",
                        point_value=concurrency,
                        concurrency=concurrency,
                        requests=_tier_lookup(tier, concurrency),
                        warmups=warmups,
                        executions=executions,
                    )
                )

    elif "pool_by_glv" in sweep:
        # Pool sensitivity: fixed (per-GLV) parallelism, swept pool.
        pool_filter = filters.get("pool")
        pool_map = sweep["pool_by_glv"] or {}
        par_map = spec.get("parallelism_by_glv") or {}
        requests = spec.get("requests")
        for glv in glvs:
            parallelism = par_map.get(glv, par_map.get("default"))
            for pool in pool_map.get(glv, []):
                if not _match(pool_filter, pool):
                    continue
                cells.append(
                    _cell(
                        test=test_name,
                        glv=glv,
                        metric=metric,
                        point_type="pool",
                        point_value=pool,
                        pool=pool,
                        parallelism=parallelism,
                        requests=requests,
                        warmups=warmups,
                        executions=executions,
                    )
                )

    else:
        # Single fixed point (e.g. peak-throughput).
        for glv in glvs:
            cells.append(
                _cell(
                    test=test_name,
                    glv=glv,
                    metric=metric,
                    pool=spec.get("pool"),
                    parallelism=spec.get("parallelism"),
                    requests=spec.get("requests"),
                    warmups=warmups,
                    executions=executions,
                    timeout=timeout,
                )
            )

    return cells


def _resolve_adhoc(script: str, filters: dict) -> List[dict]:
    """Synthesize off-matrix ``test=adhoc`` cells for a bare ``--script``."""
    glvs = [glv for glv in GLVS if _match(filters.get("glv"), glv)]
    conc = filters.get("concurrency")
    pool = filters.get("pool")
    cells = []
    for glv in glvs:
        cells.append(
            _cell(
                test="adhoc",
                glv=glv,
                metric="throughput",
                point_type="adhoc",
                point_value=script,
                script=script,
                concurrency=conc[0] if conc else None,
                pool=pool[0] if pool else None,
                warmups=filters.get("warmups"),
                executions=filters.get("executions"),
            )
        )
    return cells


def resolve_cells(
    filters: Optional[dict] = None,
    matrix: Optional[dict] = None,
    matrix_path: Optional[str] = None,
) -> List[dict]:
    """Resolve the matrix into canonical cells, applying ``filters``.

    ``filters`` is a mapping of optional selectors/overrides:
    ``glv``, ``test``, ``size``, ``concurrency``, ``pool`` (lists), plus
    ``script`` (ad-hoc), and ``warmups``/``executions`` overrides. A bare
    ``script`` bypasses the matrix and yields synthetic ``adhoc`` cells.
    """
    filters = filters or {}

    if filters.get("script"):
        cells = _resolve_adhoc(filters["script"], filters)
    else:
        if matrix is None:
            matrix = load_matrix(matrix_path)
        tests = matrix.get("tests") or {}
        test_filter = filters.get("test")
        cells = []
        for test_name, spec in tests.items():
            if not _match(test_filter, test_name):
                continue
            cells.extend(_resolve_test(test_name, spec or {}, filters))

    warm_override = filters.get("warmups")
    exec_override = filters.get("executions")
    if warm_override is not None or exec_override is not None:
        for cell in cells:
            if warm_override is not None:
                cell["warmups"] = warm_override
            if exec_override is not None:
                cell["executions"] = exec_override

    return cells
