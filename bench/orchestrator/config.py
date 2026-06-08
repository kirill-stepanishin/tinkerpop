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
"""Load and resolve the branch-local benchmark configuration.

``config.yaml`` lives next to the ``bench/`` directory's ``orchestrator``
package. This module loads it, discovers the repo root, resolves each GLV
launcher path (the java entry is a version-stamped glob), and exposes a
typed :class:`Config` object.
"""

import glob
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

import yaml

# The five GLVs this harness drives. Used for validation and summaries.
GLVS = ("java", "go", "dotnet", "javascript", "python")

# bench/orchestrator/config.py -> bench/ is two parents up's child:
#   .../bench/orchestrator/config.py
#   parents[0] = .../bench/orchestrator
#   parents[1] = .../bench
#   parents[2] = repo root
_BENCH_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_CONFIG_PATH = _BENCH_DIR / "config.yaml"


@dataclass
class Launcher:
    """A resolved GLV launcher.

    ``pattern`` is the raw value from config (possibly a glob, relative to
    the repo root). ``path`` is the resolved absolute path, or ``None`` when
    nothing on disk matches yet (the harness is run-only and does not build).
    """

    glv: str
    pattern: str
    path: Optional[Path] = None

    @property
    def available(self) -> bool:
        return self.path is not None


@dataclass
class Config:
    """Typed view of ``config.yaml`` plus derived/runtime values."""

    repo_root: Path
    transport: str
    concurrency_model: str
    host: str
    output_dir: Path
    warmups: int
    executions: int
    launchers: Dict[str, Launcher] = field(default_factory=dict)
    source_path: Optional[Path] = None

    def launcher(self, glv: str) -> Launcher:
        return self.launchers[glv]

    def summary_lines(self):
        """Human-readable config summary lines (used by ``--dry-run``)."""
        lines = [
            "Benchmark configuration",
            "  config file:       {}".format(self.source_path or "<defaults>"),
            "  repo root:         {}".format(self.repo_root),
            "  transport:         {}".format(self.transport),
            "  concurrency model: {}".format(self.concurrency_model),
            "  host:              {}".format(self.host),
            "  output dir:        {}".format(self.output_dir),
            "  warmups:           {}".format(self.warmups),
            "  executions:        {}".format(self.executions),
            "  launchers:",
        ]
        for glv in GLVS:
            launcher = self.launchers.get(glv)
            if launcher is None:
                lines.append("    {:<11} (not configured)".format(glv + ":"))
            elif launcher.available:
                lines.append("    {:<11} {}".format(glv + ":", launcher.path))
            else:
                lines.append(
                    "    {:<11} MISSING ({})".format(glv + ":", launcher.pattern)
                )
        return lines


def _expand(path_str: str) -> Path:
    """Expand ``~`` and environment variables, returning a Path."""
    return Path(os.path.expandvars(os.path.expanduser(path_str)))


def _resolve_launcher(glv: str, pattern: str, repo_root: Path) -> Launcher:
    """Resolve a launcher pattern (possibly a glob) against the repo root.

    Returns a :class:`Launcher` with ``path`` set when a unique match exists.
    Globs that match multiple paths resolve to the lexicographically last
    match (so the newest version-stamped standalone dir wins when sorted).
    """
    candidate = pattern
    if not os.path.isabs(candidate):
        candidate = str(repo_root / pattern)

    matches = sorted(glob.glob(candidate))
    resolved = Path(matches[-1]) if matches else None
    return Launcher(glv=glv, pattern=pattern, path=resolved)


def load_config(config_path: Optional[str] = None) -> Config:
    """Load ``config.yaml`` and return a resolved :class:`Config`.

    Raises ``FileNotFoundError`` if the config file is missing and no path
    override is given, and ``ValueError`` on malformed content.
    """
    path = Path(config_path).resolve() if config_path else DEFAULT_CONFIG_PATH
    if not path.exists():
        raise FileNotFoundError("config file not found: {}".format(path))

    with open(path, "r") as fh:
        raw = yaml.safe_load(fh) or {}

    if not isinstance(raw, dict):
        raise ValueError("config root must be a mapping: {}".format(path))

    repo_root = _REPO_ROOT
    defaults = raw.get("defaults") or {}
    launchers_raw = raw.get("launchers") or {}

    launchers = {
        glv: _resolve_launcher(glv, pattern, repo_root)
        for glv, pattern in launchers_raw.items()
    }

    return Config(
        repo_root=repo_root,
        transport=raw.get("transport", "http"),
        concurrency_model=raw.get("concurrency_model", "pool"),
        host=str(raw.get("host", "localhost")),
        output_dir=_expand(str(raw.get("output_dir", "~/bench-results"))),
        warmups=int(defaults.get("warmups", 2)),
        executions=int(defaults.get("executions", 3)),
        launchers=launchers,
        source_path=path,
    )
