<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->

# GLV Benchmark Harness (4.0 branch)

A **run-only**, **per-branch**, **version-ignorant** Python orchestrator that
drives the five Gremlin Language Variant (GLV) profiling applications — `java`,
`go`, `dotnet`, `javascript`, `python` — against a running Gremlin Server and
records one wide row per measured cell to an append-only ledger.

This harness **replaces** the legacy shell pipeline (`common.sh` +
`cat*.sh` + `run-all.sh` + `export-results.py`). The old scripts are still
present in this directory as a reference fallback and are **not** removed by
this change; their retirement is a later step, gated on the new harness being
proven end to end.

## What "run-only, per-branch, version-ignorant" means

- **Run-only.** The harness never builds anything. It discovers each GLV's
  pre-built launcher on disk and executes it. If a launcher is missing, the
  cell is reported as `MISSING` in `--dry-run` and fails loudly at run time.
- **Per-branch.** All branch-specific settings live in this directory's
  `config.yaml` and `matrix.yaml`. This is the **4.0** copy: transport `http`,
  `concurrency_model: pool` (one connection per concurrent request, pool
  size = C).
- **Version-ignorant.** The orchestrator code never reasons about "the other
  version". The 3.7 branch carries its own `config.yaml`/`matrix.yaml` with
  `transport: ws` and `concurrency_model: multiplex`. The same Python code runs
  on both branches unchanged.

The orchestrator owns three things the old bash scripts spread across many
files: the **CLI dialect** per GLV (`adapters.py`), the **test matrix**
(`matrix.yaml` → `matrix.py`), and the **append-only ledger** (`ledger.py`)
that fixes the legacy exporter's data-loss bug.

---

## Installation

The harness is a small Python package (`tinkerpop-bench`) with a single
dependency (`PyYAML`). Install it in editable mode to get the `bench` command:

```bash
cd bench
pip install -e .
```

You can also invoke it without installing via `python -m orchestrator` from the
`bench/` directory. All examples below use the `bench` entry point.

---

## Per-GLV build prerequisites

The harness does not build the GLVs — build them once before running. These
commands are migrated from the legacy `WALKTHROUGH.md` and are run from the
**4.0 repo root** (e.g. `~/tinkerpop-4`).

| GLV        | Build command                                                                                  |
|------------|------------------------------------------------------------------------------------------------|
| java       | `mvn clean install -pl gremlin-driver -am -DskipTests -Dasciidoc.skip=true`                     |
| go         | `cd gremlin-go && go build -o profiling_application ./driver/util/`                             |
| dotnet     | `cd gremlin-dotnet/src/Gremlin.Net.Profiling && dotnet build -c Release`                        |
| javascript | `cd gremlin-javascript/src/main/javascript/gremlin-javascript && npm install`                   |
| python     | `cd gremlin-python/src/main/python && pip install -e .`                                          |

Make the per-GLV launcher wrappers executable (one-time):

```bash
find . -path '*/main/bin/profile-driver.sh' -exec chmod +x {} \;
```

`config.yaml` records where each launcher lives (relative to the repo root) and
`config.py` resolves the version-stamped java path automatically. Run
`bench run --dry-run` to confirm every launcher resolves before a real run; any
unbuilt GLV shows as `MISSING`.

> **4.0 path note:** on this branch the JavaScript launcher lives under
> `gremlin-js/gremlin-javascript/...`. (On 3.7 it lives directly under
> `gremlin-javascript/...` — see that branch's README.)

You will also need a **running Gremlin Server** reachable from the client (see
[Local vs. EC2](#local-vs-ec2-read-this-before-trusting-any-number) below).

---

## `bench run` usage

```bash
bench run [selectors...] [overrides...] [--dry-run]
```

With no selectors, `bench run` resolves the **full default matrix** (all four
tests × all applicable GLVs × all points) and executes it. Selectors narrow
the matrix; overrides change provenance or per-cell counts. Selectors are
**composable** and most are **repeatable**.

### Selector flags (which cells to run)

| Flag            | Repeatable | Meaning                                                                                  |
|-----------------|:----------:|------------------------------------------------------------------------------------------|
| `--glv GLV`     | yes        | Restrict to a GLV: `java`, `go`, `dotnet`, `javascript`, `python`.                       |
| `--test TEST`   | yes        | Restrict to a test: `protocol-overhead`, `peak-throughput`, `scaling-curve`, `pool-sensitivity`. |
| `--size SIZE`   | yes        | Restrict latency points to a size, e.g. `tiny`, `medium` (applies to `protocol-overhead`). |
| `--concurrency N` | yes      | Restrict the scaling-curve sweep to a concurrency point.                                  |
| `--pool N`      | yes        | Restrict the pool-sensitivity sweep to a pool-size point.                                 |
| `--script GREMLIN` | no      | Off-matrix ad-hoc run: synthesizes a `test=adhoc` throughput cell for the given script.   |

### Override / provenance flags

| Flag             | Meaning                                                                                  |
|------------------|------------------------------------------------------------------------------------------|
| `--host HOST`    | Override the server host from `config.yaml` for this run (default `localhost`).          |
| `--label TEXT`   | Human-readable label recorded with every row (use `smoke` locally, `control` on EC2).    |
| `--output-dir PATH` | Override the ledger/log output directory (default `~/bench-results`).                 |
| `--executions N` | Override the measured execution count per cell.                                          |
| `--warmups N`    | Override the warmup count per cell (warmups are excluded from results).                  |
| `--dry-run`      | Print the resolved config + cells + native argv/env **without executing**.               |

### Examples

```bash
# Inspect what the FULL default matrix would do — no server needed.
bench run --dry-run

# Single GLV, single test, one query size, against a real server (EC2).
bench run --glv python --test protocol-overhead --size tiny \
          --host 16.59.222.63 --label control

# Local plumbing check (see the local-vs-EC2 section): MUST use --label smoke.
bench run --glv python --test protocol-overhead --size tiny \
          --host localhost --label smoke

# Scaling curve for two GLVs at two concurrency points only.
bench run --test scaling-curve --glv go --glv java \
          --concurrency 64 --concurrency 256 --host <server-ip> --label control

# Pool-sensitivity, single pool point, custom counts and output dir.
bench run --test pool-sensitivity --glv dotnet --pool 128 \
          --executions 5 --warmups 3 --output-dir ~/bench-results --label control

# Ad-hoc off-matrix script across all GLVs.
bench run --script "g.V().count()" --concurrency 64 --label control --host <server-ip>

# Preview the exact native argv for a tricky cell before committing to a run.
bench run --dry-run --test scaling-curve --glv java --concurrency 256
```

`--dry-run` prints the resolved configuration, the active selectors/overrides,
the resolved cell list, and — for each cell — the exact `argv` (and `env`, for
.NET) that would be launched. It needs **no server and no built GLVs**, so it is
the fastest way to validate a selection.

---

## Output: the append-only ledger

Every executed cell appends **exactly one wide row** to
`<output-dir>/ledger.csv` (default `~/bench-results/ledger.csv`). Raw per-cell
stdout/stderr is teed to `<output-dir>/logs/<run_id>-<glv>-<test>-<point>.log`.

### Re-runs APPEND — no data loss

This is the core fix over the legacy exporter, which overwrote `results.csv` and
**silently dropped data** whenever a single GLV was re-run. The new ledger is
opened in append mode: the header is written once on file creation, and every
subsequent run (and every cell within it) **adds** rows. Prior rows are never
rewritten or overwritten. Re-running the same selection simply appends a fresh
set of rows stamped with a new `run_id` and `timestamp`; you distinguish runs
after the fact via `run_id`, `label`, `git_sha`, and `host`.

Apps perform **no statistics** — they emit only raw per-execution values via a
single `RESULT_JSON:` stdout line (see `SCHEMA.md`). The runner greps that line,
**fails loudly** if it is missing, computes mean / median / population-stddev /
nearest-rank p99 / min / max, and writes the row. A failed cell still produces a
fully-formed row (empty stats + `error_reason`); one bad cell never aborts the
batch.

### Ledger columns

| Group        | Columns                                                                 |
|--------------|-------------------------------------------------------------------------|
| Provenance   | `run_id`, `timestamp`, `label`, `host`, `git_sha`, `dirty`              |
| Cell params  | `glv`, `test`, `metric`, `point_type`, `point_value`, `script`, `concurrency`, `pool`, `parallelism`, `requests`, `warmups`, `executions`, `timeout` |
| Outcome      | `status`, `returncode`, `error_reason`                                  |
| Statistics   | `count`, `mean`, `median`, `stddev`, `p99`, `min`, `max`                |
| Raw + log    | `measurements` (JSON array), `errors` (JSON array), `log_path`          |

Columns are append-only in the schema too: new columns are added at the end,
never inserted or reordered, so existing ledgers stay readable. The raw
`measurements`/`errors` arrays are stored as JSON strings so nothing is lost.

> If the working tree is **dirty** and you pass no `--label`, the runner warns:
> the recorded `git_sha` alone will not capture uncommitted changes, so label
> such runs explicitly.

---

## The four tests

| Test                | Metric     | What it measures                                                        | Matrix shape |
|---------------------|------------|-------------------------------------------------------------------------|--------------|
| `protocol-overhead` | latency    | Per-request transport cost, sequential (pool = 1), over two query sizes (`tiny` = `g.V()`, `medium` = `g.V().repeat(both()).times(12)`), for every GLV. | size points |
| `peak-throughput`   | throughput | Absolute throughput ceiling, **java only** (lazy pool growth, long steady state). Other GLVs peak inside the scaling curve. | single point |
| `scaling-curve`     | throughput | Throughput vs. concurrency sweep `[4,16,64,128,256,512,1000,5000]`, request counts tiered per GLV. Shows where each GLV plateaus. | concurrency sweep |
| `pool-sensitivity`  | throughput | Throughput vs. connection-pool size (fixed high parallelism, pool swept across four per-GLV points). Shows how much a wrong pool size hurts. | pool sweep |

On this 4.0 branch (`concurrency_model: pool`), scaling-curve concurrency `C`
maps onto a connection pool of size `C` (java caps submission parallelism at 64;
connections supply HTTP concurrency).

---

## Local vs. EC2 — read this before trusting any number

The harness runs identically on your laptop and on EC2, but **the numbers are
not interchangeable**. This distinction is the single most important thing to
get right.

### Localhost = plumbing verification ONLY → `--label smoke`

A `--host localhost` run exists to prove the *plumbing* works: launchers
resolve, the server answers, each GLV emits a parseable `RESULT_JSON:` line,
stats compute, and a row appends. It is **not** a valid measurement because:

- the client and server **contend for the same CPU**, so throughput and latency
  are distorted; and
- there is **no cross-region network latency**, which is exactly what the
  protocol-overhead and scaling tests are meant to capture.

**Always tag local runs `--label smoke`** and keep request counts/sizes small
(`--size tiny`, low `--concurrency`). A localhost `smoke` row must never be
mistaken for real data.

### Real control data = two-EC2 cross-region → `--label control`

Meaningful, comparable numbers come only from the two-EC2 setup the legacy
walkthrough describes: a server (US-EAST-2, m7a.8xlarge) and a separate client
(US-WEST-2, m7a.4xlarge), so runs carry realistic cross-region latency and the
client never steals the server's CPU. Run from the client with
`--host <server-ip> --label control`.

### How smoke and control rows are kept apart

Because all rows land in the same append-only ledger, three provenance columns
let you filter with confidence after the fact:

- **`label`** — your explicit `smoke` vs. `control` tag.
- **`host`** — `localhost` (contended, no WAN latency) vs. a real server IP.
- **`git_sha`** (+ `dirty`) — which branch/commit produced the row; also
  distinguishes 3.7 control rows from 4.0 control rows when ledgers are shared.

When in doubt, trust `control` rows from a real `host` on a clean `git_sha`.

---

## See also

- `SCHEMA.md` — the `RESULT_JSON:` stdout contract every GLV app must satisfy.
- `config.yaml` — branch settings (transport, concurrency model, host, launchers).
- `matrix.yaml` — the four tests encoded as data.
- `WALKTHROUGH.md` — legacy bash procedure (reference fallback; being retired).
