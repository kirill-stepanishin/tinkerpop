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
"""Command-line entry point for the benchmark orchestrator.

Phase 2 wires up the ``run`` subcommand, its selector/override flags, and
``--dry-run``. Matrix-driven cell resolution arrives in Phase 3; until then
``--dry-run`` prints the resolved configuration plus a placeholder (empty)
cell list so the wiring can be exercised end to end.
"""

import argparse
import sys
from typing import List, Optional

from . import __version__
from .adapters import build_invocation
from .config import GLVS, load_config
from .matrix import resolve_cells
from .runner import run_batch

TESTS = (
    "protocol-overhead",
    "peak-throughput",
    "scaling-curve",
    "pool-sensitivity",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bench",
        description="Run-only GLV benchmarking orchestrator (this branch only).",
    )
    parser.add_argument(
        "--version", action="version", version="bench {}".format(__version__)
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        default=None,
        help="path to config.yaml (default: bench/config.yaml)",
    )

    subparsers = parser.add_subparsers(dest="command")

    run = subparsers.add_parser(
        "run", help="resolve and (later) execute benchmark cells"
    )

    # ── Selectors: which cells to run (composable filters). ──────────
    run.add_argument(
        "--glv",
        action="append",
        choices=list(GLVS),
        metavar="GLV",
        help="restrict to a GLV (repeatable): {}".format(", ".join(GLVS)),
    )
    run.add_argument(
        "--test",
        action="append",
        choices=list(TESTS),
        metavar="TEST",
        help="restrict to a test (repeatable): {}".format(", ".join(TESTS)),
    )
    run.add_argument(
        "--size",
        action="append",
        metavar="SIZE",
        help="restrict to a latency point size, e.g. tiny|medium (repeatable)",
    )
    run.add_argument(
        "--concurrency",
        action="append",
        type=int,
        metavar="N",
        help="restrict to a concurrency point (repeatable)",
    )
    run.add_argument(
        "--pool",
        action="append",
        type=int,
        metavar="N",
        help="restrict to a pool-size point (repeatable)",
    )
    run.add_argument(
        "--script",
        metavar="GREMLIN",
        default=None,
        help="ad-hoc off-matrix script (synthetic test=adhoc cell)",
    )

    # ── Overrides / provenance. ──────────────────────────────────────
    run.add_argument(
        "--host",
        metavar="HOST",
        default=None,
        help="override the server host from config.yaml for this run",
    )
    run.add_argument(
        "--label",
        metavar="TEXT",
        default=None,
        help="human-readable label recorded with each run",
    )
    run.add_argument(
        "--output-dir",
        metavar="PATH",
        default=None,
        help="override the ledger/log output directory",
    )
    run.add_argument(
        "--executions",
        type=int,
        metavar="N",
        default=None,
        help="override the measured execution count per cell",
    )
    run.add_argument(
        "--warmups",
        type=int,
        metavar="N",
        default=None,
        help="override the warmup count per cell",
    )
    run.add_argument(
        "--dry-run",
        action="store_true",
        help="print the resolved config and cells without executing",
    )

    return parser


def _resolve_cells(config, args) -> List[dict]:
    """Resolve selected cells via the matrix (Phase 3).

    Translates the CLI selectors/overrides into the filter mapping that
    :func:`orchestrator.matrix.resolve_cells` consumes.
    """
    filters = {
        "glv": args.glv,
        "test": args.test,
        "size": args.size,
        "concurrency": args.concurrency,
        "pool": args.pool,
        "script": args.script,
        "warmups": args.warmups,
        "executions": args.executions,
    }
    return resolve_cells(filters)


def _filters_summary(args) -> List[str]:
    """Render the active selectors/overrides for the dry-run output."""
    items = [
        ("glv", args.glv),
        ("test", args.test),
        ("size", args.size),
        ("concurrency", args.concurrency),
        ("pool", args.pool),
        ("script", args.script),
        ("host", args.host),
        ("label", args.label),
        ("output-dir", args.output_dir),
        ("executions", args.executions),
        ("warmups", args.warmups),
    ]
    active = [(k, v) for k, v in items if v]
    if not active:
        return ["  (none — would resolve the full default matrix)"]
    return ["  --{} {}".format(k, v) for k, v in active]


def _cmd_run(args) -> int:
    config = load_config(args.config)
    if args.host:
        config.host = args.host
    cells = _resolve_cells(config, args)

    if args.dry_run:
        for line in config.summary_lines():
            print(line)
        print("")
        print("Selectors / overrides:")
        for line in _filters_summary(args):
            print(line)
        print("")
        print("Resolved cells ({}):".format(len(cells)))
        if not cells:
            print("  (none matched the given selectors)")
        else:
            for cell in cells:
                print("  {}".format(cell))
                argv, env = build_invocation(cell, config)
                if env:
                    env_str = " ".join(
                        "{}={}".format(k, v) for k, v in sorted(env.items())
                    )
                    print("      env:  {}".format(env_str))
                print("      argv: {}".format(argv))
        return 0

    # Execution (Phase 5): runner launches each cell, parses RESULT_JSON,
    # computes stats, and appends one wide row per cell to the ledger.
    if not cells:
        print("No cells matched the given selectors; nothing to run.", file=sys.stderr)
        return 0

    summary = run_batch(
        cells,
        config,
        label=args.label,
        output_dir=args.output_dir,
    )
    print(
        "Run {}: {} cell(s), {} ok, {} failed.".format(
            summary["run_id"], summary["total"], summary["ok"], summary["failed"]
        )
    )
    print("Ledger: {}".format(summary["ledger_path"]))
    return 0 if summary["failed"] == 0 else 1


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "run":
        return _cmd_run(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
