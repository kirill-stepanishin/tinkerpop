<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to you under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License. You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# TinkerPop GLV Benchmarking & Profiling — Start Here

This is the **map**. All TinkerPop client (GLV) benchmarking and profiling work
splits into three strands with different audiences and lifecycles. Find the one
you need and follow its link; the shared infrastructure and conventions that all
three rely on are at the bottom.

| Strand | Question it answers | Status | Entry point |
|--------|---------------------|--------|-------------|
| **1. Version comparison** | "Is 4.0 (HTTP) as fast as 3.7 (WebSocket), per GLV?" | **Finished study** | external notes (see §1) |
| **2. The benchmark harness** | "How do I run one measurement and get a trustworthy ledger row?" | **Live tooling** | [`README.md`](README.md) |
| **3. Perf-optimization workflow** | "How do I discover, validate, and benchmark a candidate optimization for one GLV?" | **Active R&D** | [`auto/RUNBOOK.md`](auto/RUNBOOK.md) |

> All three measure the **client** GLV (`java`, `go`, `dotnet`, `javascript`,
> `python`) against a Java Gremlin Server. The server is the same regardless of
> which client language you benchmark.

---

## 1. Version comparison — the finished 3.7-vs-4.0 study

The original study answered whether the 3.7→4.0 transport change (WebSocket →
HTTP) regressed client throughput/latency, per GLV. It is **complete**; its
data, plans, and analysis live **out of the repo** at
`~/dev/tp benchmarking/` (not under version control):

- `results.csv` — the curated comparison dataset (cat1 latency, cat3 peak,
  cat4 scaling curve; both versions × all five GLVs).
- `report.ipynb` — pandas/plotly notebook rendering the 3.7-vs-4.0 charts
  (pulls `results.csv` from S3 `s3://kirill-tp-benchmarks/`).
- `concurrency-pool-report.md` — the key findings doc on how WS-multiplexing
  (3.7) vs HTTP-connection-per-request (4.0) changes pool/concurrency mechanics
  per GLV.
- `RESULTS.md` — one-page summary of the conclusions (if present).
- `{java,python,go,dotnet,javascript}-benchmarking-plan.md` — the canonical
  **per-language build + run recipes** for the two-EC2 setup. The harness
  README points at these for build prerequisites; they remain the source of
  truth for "how do I build GLV X's profiling app".
- `harness-implementation-plan.md` — the design that produced strand 2.
- `3.7.txt`, `4.txt` — raw `profile-driver.sh` terminal captures.

**One-line takeaway:** 4.0/HTTP matches or beats 3.7/WS on absolute peak
(Java ~37k vs ~35k req/s) and per-request latency, but because HTTP is
connection-per-request, **pool size becomes the throughput limiter** for every
GLV — where 3.7's WS multiplexing (Java/.NET/JS) hid it. See `RESULTS.md` /
`concurrency-pool-report.md` for the per-GLV numbers.

To reproduce or extend it, use strand 2 (the harness) with `--label control`.

---

## 2. The benchmark harness — `bench` (current toolset)

The `tinkerpop-bench` Python package (this directory) is the reusable engine for
**every** measurement in strands 1 and 3. It is:

- **run-only** — never builds; it executes the pre-built per-GLV launcher it
  finds on disk (build the GLVs first, per the §1 language plans).
- **per-branch** — this copy is the **4.0** config (`transport: http`,
  `concurrency_model: pool`); the 3.7 branch carries its own
  `config.yaml`/`matrix.yaml` (`transport: ws`, `concurrency_model: multiplex`)
  and runs the identical Python code.
- **append-only** — every cell adds exactly one wide row to
  `<output-dir>/ledger.csv` (default `~/bench-results/`); re-runs never
  overwrite. This is the core fix over the legacy `export-results.py`, which
  silently dropped data on a single-GLV re-run.

**Read these, in order:**
- [`README.md`](README.md) — `bench run` usage, selectors/overrides,
  `--dry-run`, the four tests, the ledger schema, and the **local-vs-EC2**
  warning.
- [`SCHEMA.md`](SCHEMA.md) — the `RESULT_JSON:` stdout contract every GLV
  profiling app must emit (apps emit only raw values; the harness computes
  mean/median/stddev/p99).
- [`config.yaml`](config.yaml) / [`matrix.yaml`](matrix.yaml) — branch settings
  and the four tests encoded as data.

**The four tests** (`matrix.yaml`): `protocol-overhead` (latency, two query
sizes), `peak-throughput` (java-only ceiling), `scaling-curve` (throughput vs
concurrency sweep), `pool-sensitivity` (throughput vs pool size).

**Fastest sanity check (no server, no built GLVs):**
```bash
cd bench && pip install -e .
bench run --dry-run          # prints resolved config + every cell's native argv
```

---

## 3. Perf-optimization workflow — `bench/auto/` (new layer)

Built on top of the harness, this strand discovers and validates **candidate
optimizations** for one GLV's hot path (currently gremlin-python GraphBinary
deserialization). Entry point: [`auto/RUNBOOK.md`](auto/RUNBOOK.md).

Two autonomous funnels (Claude Code `Workflow` scripts) plus the manual EC2
runbook and the analysis notebook:

- `auto/glv-perf-funnel.workflow.js` — full pipeline: research → investigate →
  implement → review → `mvn` correctness gate → **interleaved ABAB benchmark**
  → adversarial verify. Gated on **yappi CPU self-time drop ≥ 5%**. Each
  survivor lands on its own branch.
- `auto/glv-correctness-funnel.workflow.js` — GLV-parameterized
  (`{glv: "python"|"go"}`) variant that stops at `mvn clean install` (no
  in-workflow benchmarking); the operator benchmarks the surviving branches
  manually afterward.
- `auto/EC2-BENCHMARK-CANDIDATES.md` — fully-worked runbook for benchmarking
  the four python deser candidates on EC2.
- `auto/EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — language-agnostic version of
  that runbook (fill-in-the-blanks for any GLV).
- `auto/candidate-analysis.ipynb` — pandas/plotly notebook that reads
  S3-published candidate results and renders the CPU gate, guards, and a
  PASS/FAIL verdict.

---

## Shared infrastructure & conventions (all strands)

**The two-EC2 cross-region rig** (the only setup that produces trustworthy
numbers):

| Role | Instance | Region | Notes |
|------|----------|--------|-------|
| Server | `m7a.8xlarge` (32 vCPU) | US-EAST-2 | IP `16.59.222.63`; Java Gremlin Server, **Modern graph** (`gremlin-server-modern.yaml`) |
| Client | `m7a.4xlarge` (16 vCPU) | US-WEST-2 | runs the GLV launcher + the `bench` harness |

- Security group allows TCP **8182** client→server. If the instances are
  recreated the IP changes — re-confirm with `hostname -I` on the server.
- On the provisioned boxes the repo is at `~/tinkerpop-4` and the fork is the
  `fork` remote (`origin` = upstream `apache/tinkerpop`).
- The latency tests traverse the **Modern graph**, so the server must use a
  `*-modern.yaml` config (the default config serves an empty graph and `g.V()`
  returns nothing). Watch for a stale wrong-major-version server on 8182.

**`--label` discipline** (how runs are kept apart in the shared append-only
ledger):

| Label | Meaning |
|-------|---------|
| `smoke` | localhost plumbing verification only — client/server contend for CPU and there is no WAN latency, so **never** valid measurement data |
| `control` | the canonical two-EC2 cross-region run — the only trustworthy comparison data |
| `candidate-eval` | a quiet dedicated EC2 that isn't the canonical control (used by strand 3); more trustworthy than a laptop but not a cross-region `control` |

Every ledger row also carries `host`, `git_sha`, and `dirty` so runs can be
filtered with confidence after the fact.

### Server setup & tuning

The server is a Java Gremlin Server standalone built from the same repo
(`mvn clean install -pl gremlin-server -am -DskipTests -Dasciidoc.skip=true`).
For throughput runs it must be tuned, and for latency runs it must serve the
**Modern graph**. Apply the edits to the config you start it with — use
`gremlin-server-modern.yaml` (the default `gremlin-server.yaml` serves an empty
graph, so `g.V()` returns nothing):

```bash
cd <server-standalone-dir>
# bind to all interfaces (Setup B / cross-region only) and lift the eval timeout:
sed -i 's/^host: localhost/host: 0.0.0.0/'                     conf/gremlin-server-modern.yaml
sed -i 's/^evaluationTimeout: .*/evaluationTimeout: 30000000/' conf/gremlin-server-modern.yaml
# throughput tuning — larger work queue + worker/gremlin pools:
sed -i '/^channelizer:/a maxWorkQueueSize: 65536\nthreadPoolWorker: 8\ngremlinPool: 16' conf/gremlin-server-modern.yaml

ulimit -n 65536
export JAVA_OPTIONS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
bin/gremlin-server.sh conf/gremlin-server-modern.yaml   # wait for: Channel started at port 8182
```

Leave it running in its own `tmux`/`screen` pane for the session. **.NET clients
also require** `DOTNET_GCServer=1` and `DOTNET_ThreadPool_MinThreads=1024` for a
fair run (the harness sets these per-cell, but set them in the shell for ad-hoc
runs).

### Interpreting the pool-sensitivity / scaling curves

The shape of the throughput-vs-concurrency and throughput-vs-pool curves is the
diagnostic, and it differs by transport (see `RESULTS.md` in the external study
for the numbers behind these):

- **3.7 / WS**: a **flat** pool-sensitivity curve for Java/JS/.NET (multiplexing
  absorbs pool changes); a **steep** curve for Python/Go (no multiplexing).
- **4.0 / HTTP**: a **steep** curve for **all** GLVs — pool size ≈ effective
  concurrency, so an undersized pool is the throughput limiter.
- In the scaling curve, the **knee** is the useful concurrency limit; beyond it
  more connections stop helping (and some GLVs decline). 4.0's knee generally
  sits at higher concurrency than 3.7's.

---

## See also

- [`README.md`](README.md) — the harness in full.
- [`auto/RUNBOOK.md`](auto/RUNBOOK.md) — the optimization funnels in full.
- `~/dev/tp benchmarking/` (external) — the finished version-comparison study,
  per-language build plans, and raw data.
