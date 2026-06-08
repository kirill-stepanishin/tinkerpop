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
"""Append-only wide-row benchmark ledger.

Every executed cell contributes exactly one row to a single CSV file
(``<output_dir>/ledger.csv``). The header is written once, when the file is
created; every subsequent row is *appended*. This is the core fix for the
legacy exporter, which overwrote ``results.csv`` and silently dropped data
when a single GLV was re-run.

CSV is chosen for append-simplicity (open in ``"a"`` mode, no rewrite of
prior rows) and because it is pandas-native; a Parquet sink can be layered on
later without changing this contract.

A row is "wide": it carries the full provenance (run id, label, git sha,
dirty flag, host, log path), the canonical cell parameters, the run status,
the computed statistics, and the raw ``measurements``/``errors`` arrays as
JSON strings so nothing is lost.
"""

import csv
import json
from pathlib import Path
from typing import Mapping, Union

# Column order for the ledger. New columns must be appended here (never
# inserted/reordered) so existing ledgers stay readable.
LEDGER_COLUMNS = (
    # ── Provenance ──────────────────────────────────────────────────
    "run_id",
    "timestamp",
    "label",
    "host",
    "git_sha",
    "dirty",
    # ── Canonical cell parameters ───────────────────────────────────
    "glv",
    "test",
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
    # ── Outcome ─────────────────────────────────────────────────────
    "status",
    "returncode",
    "error_reason",
    # ── Statistics (computed by the runner over measurements) ───────
    "count",
    "mean",
    "median",
    "stddev",
    "p99",
    "min",
    "max",
    # ── Raw values (JSON strings) + log pointer ─────────────────────
    "measurements",
    "errors",
    "log_path",
)

DEFAULT_LEDGER_NAME = "ledger.csv"


def ledger_path(output_dir: Union[str, Path]) -> Path:
    """Return the ledger file path for a given output directory."""
    return Path(output_dir) / DEFAULT_LEDGER_NAME


def _serialize(value) -> str:
    """Render a cell value for CSV.

    ``None`` becomes the empty string; lists/dicts are JSON-encoded so the
    raw ``measurements``/``errors`` arrays survive a CSV round-trip intact;
    everything else is stringified by the csv writer.
    """
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value)
    return value


def append_row(path: Union[str, Path], row: Mapping) -> Path:
    """Append a single row to the ledger, writing the header on create.

    Opens the file in append mode so prior rows are never rewritten or
    overwritten. The header is emitted only when the file does not yet exist
    (or is empty). Unknown keys in ``row`` are ignored; missing columns are
    written blank.

    Returns the resolved ledger path.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    needs_header = (not path.exists()) or path.stat().st_size == 0

    serialized = {
        column: _serialize(row.get(column)) for column in LEDGER_COLUMNS
    }

    with open(path, "a", newline="") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=list(LEDGER_COLUMNS), extrasaction="ignore"
        )
        if needs_header:
            writer.writeheader()
        writer.writerow(serialized)

    return path
