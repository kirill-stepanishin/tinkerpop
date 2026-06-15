<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file. Apache License 2.0.
-->

# Benchmarking the GraphBinary-deser Candidates on EC2

Step-by-step guide to measure the four proposed gremlin-python deserialization
optimizations on EC2, **head-to-head against the `4-glv-python-perf` baseline**, using the
`bench` harness (`bench/README.md`) so the runs land in the same append-only ledger format as
all prior TinkerPop benchmarking — with deterministic numbers you can trust (unlike noisy,
contended localhost).

## What we are measuring

All four candidates are single-commit, python-only changes to **one file**:
`gremlin-python/src/main/python/gremlin_python/structure/io/graphbinaryV4.py` — the
GraphBinary V4 deserialization hot path. The server is identical for every arm; **only the
client-side Python deserializer changes**, so this is a clean apples-to-apples comparison.

| Branch | SHA | Optimization |
|---|---|---|
| `4-glv-python-perf` | `b86463c0` | **baseline** (no change) |
| `auto/cand-inline-is-null` | `88d78b84` | inline the null-flag check into hot scalar `objectify` (drops a lambda + indirection) |
| `auto/cand-index-type-byte` | `b6e92de4` | index dispatch on the type byte instead of `struct.unpack` |
| `auto/cand-b-hybrid-int-dispatch` | `166dac40` | int-keyed deserializer dispatch in `GraphBinaryReader` |
| `auto/cand-full-flatten-decode-table` | `d2692fa4` | flatten decode via an int-keyed dispatch table |

All four are rebased onto `4-glv-python-perf` (one commit each) and pushed to the fork
`git@github.com:kirill-stepanishin/tinkerpop.git` at the SHAs above.

> **Remote naming on the benchmarking EC2s.** On the pre-provisioned benchmarking boxes the
> repo lives at **`~/tinkerpop-4`** and the fork is the **`fork`** remote (`origin` points at
> upstream `apache/tinkerpop`, over HTTPS). Every `git` command below uses `fork`/`~/tinkerpop-4`
> accordingly — if you stand up a fresh box where the fork is `origin`, translate back.

> **Why EC2 and not localhost.** Per `bench/README.md`, a `--host localhost` run is *plumbing
> verification only* (`--label smoke`) — client and server contend for the same CPU and there
> is no WAN latency, so it is **never** valid measurement data. We saw this first-hand: under a
> contended local multi-agent run the medium query clocked **~115 s/req**, while on a quiet EC2
> client (`results.csv`) the same query is **~7.66 s/req** — a 15× distortion. Real numbers
> require EC2 with `--label control`.

---

## 0. Mental model

Deserialization is a **client-CPU** cost. The signal is strongest where the result set is
large (more bytes to decode), so the harness's **medium** point
`g.V().repeat(both()).times(12)` is the primary test (it returns **200766 results** per request
on the Modern graph — lots of objects to deserialize). The **tiny** point `g.V()` (6 vertices)
is a fixed-overhead guard — it must not regress.

Two complementary signals per candidate:

1. **Wall-clock latency** — the harness records one row per cell to `ledger.csv`; read the
   **`median`** column (sec/req). Easy to read, but includes network RTT + server time, so the
   deser delta is a fraction of the total.
2. **yappi CPU profile** *(the anchor)* — set `GREMLIN_PROFILE=yappi-cpu` in the environment
   and the committed hook in `profiling_application.py` dumps a self-time (`tsub`) profile. The
   gate is **total self-time drop ≥ 5%** vs the baseline arm, summed over the `tsub` column —
   deterministic and network-independent. This is the number that actually decides a win.

> Run baseline and each candidate **back-to-back in the same session** and compare the
> *relative* delta. Never quote raw EC2 ms as an absolute latency figure.

---

## 1. Infrastructure

Only the **client EC2** is special for this work (deser is client-side). Two valid setups:

| Setup | Server | Client | When |
|---|---|---|---|
| **A — single instance** (simplest) | localhost on the client box | same box | fastest to stand up; valid here because we only compare *candidates to each other*, all sharing one server, and the **yappi CPU gate doesn't depend on the network at all** |
| **B — cross-region** (matches prior runs) | `m7a.8xlarge`, US-EAST-2 | `m7a.4xlarge` (16 vCPU), US-WEST-2 | if you also want wall-clock numbers comparable to the `control` rows in `results.csv` / `python-benchmarking-plan.md` |

> **The provisioned benchmarking pair (Setup B) — concrete values.** The same two EC2s used for
> all prior per-language runs (`python-/go-/dotnet-benchmarking-plan.md`) are reused here:
> - **Server:** `m7a.8xlarge`, US-EAST-2, IP **`16.59.222.63`** → on the client set `HOST=16.59.222.63`.
> - **Client:** `m7a.4xlarge` (16 vCPU), US-WEST-2 — where the driver, harness, and this doc run.
> - Security group already allows TCP **8182** from the client to the server (prior runs used it).
>
> These match the `--host 16.59.222.63` lines in the sibling language plans. If the instances are
> ever re-created the IP changes, so re-confirm with `ec2-metadata`/`hostname -I` on the server box.

For deciding *which candidate is fastest*, **Setup A is sufficient and recommended** — the
server and network are constant across arms so they cancel, and the yappi profile is
CPU-only. Use Setup B only if you need cross-version wall-clock context.

> **Important nuance on `--label`.** `bench/README.md` reserves `--label smoke` for localhost
> plumbing checks and `--label control` for the two-EC2 cross-region setup. Our Setup A
> (server on the client's localhost, but on a quiet dedicated EC2 with no competing workload)
> is a third case: it is *more* trustworthy than a laptop but is **not** the canonical
> cross-region `control`. **Tag Setup-A runs `--label candidate-eval`** so they are never
> mistaken for either a laptop `smoke` row or a cross-region `control` row.

**Instance recommendation (Setup A):** compute-optimized, ≥8 vCPU, ≥16 GB RAM (e.g.
`c7i.2xlarge` / `m7a.2xlarge`) on **Amazon Linux 2023**. The medium traversal returns
**200766 results** per request against the Modern graph (`times(12)`) — measured, not the
multi-million figure earlier drafts assumed; the exact number doesn't matter as long as it is
**identical across every arm** (see §5c). Still give the client memory headroom.

**Security group:** Setup A needs no inbound port (server is localhost). Setup B needs TCP
**8182** open from the client SG to the server SG.

---

## 2. One-time client setup

> **On the pre-provisioned benchmarking client, most of this is already done** — the repo is at
> `~/tinkerpop-4`, the candidate branches are reachable on the `fork` remote, and the gremlin
> driver already imports from the source tree (so `git checkout` swaps the deserializer live).
> Don't blindly re-run; **inventory first** and fill only the gaps:
>
> ```bash
> git -C ~/tinkerpop-4 remote -v && git -C ~/tinkerpop-4 branch          # fork remote? which branches local?
> python3 -c "import gremlin_python, yaml; print(gremlin_python.__file__)" # driver on path + PyYAML present?
> python3 -c "import yappi" 2>&1 | tail -1                                 # yappi installed?
> bench --help 2>&1 | head -1 || echo "bench not installed"               # harness on PATH?
> ```
>
> On that box the driver was **not** installed under a `~/venv-glv` venv — it resolves from the
> source tree on the **system `python3.11`**, and `bench` installs with
> `pip3.11 install --user -e ~/tinkerpop-4/bench` (its only dep, PyYAML, is already present).
> `yappi` installs with `pip3.11 install --user yappi`. The fresh-box recipe below assumes a venv;
> either path works as long as the driver imports from the source tree.

```bash
# --- system deps ---
sudo dnf install -y git python3.11 python3.11-pip java-17-amazon-corretto-devel maven
python3.11 --version          # need >= 3.10 for 4.x

# --- clone the fork and the candidate branches (fresh box) ---
# On the provisioned box the repo is ALREADY at ~/tinkerpop-4 with the fork as the `fork` remote;
# there you only run the fetch + branch-track loop below (substitute fork/ for origin/).
git clone git@github.com:kirill-stepanishin/tinkerpop.git ~/tinkerpop
cd ~/tinkerpop
git fetch origin
for b in 4-glv-python-perf \
         auto/cand-inline-is-null \
         auto/cand-index-type-byte \
         auto/cand-b-hybrid-int-dispatch \
         auto/cand-full-flatten-decode-table ; do
  git branch --track "$b" "origin/$b" 2>/dev/null || true   # provisioned box: "fork/$b"
done
git checkout 4-glv-python-perf
# verify the 5 branches resolve to the expected SHAs (baseline b86463c0):
git log --oneline -1

# --- python venv + the gremlin driver (editable) + the bench harness ---
python3.11 -m venv ~/venv-glv
source ~/venv-glv/bin/activate
pip install -U pip
pip install -e ~/tinkerpop/gremlin-python/src/main/python   # driver (aiohttp, aenum, isodate, ...)
pip install -e ~/tinkerpop/bench                            # the `bench` harness (per bench/README.md)
pip install yappi                                           # required for the CPU-profile gate

chmod +x ~/tinkerpop/gremlin-python/src/main/bin/profile-driver.sh \
         ~/tinkerpop/gremlin-python/src/main/bin/config-eval.sh
```

> **Critical — editable install + git switch = the mechanism.** Because the driver is
> `pip install -e`, the venv imports `graphbinaryV4.py` directly from the source tree. So
> **`git checkout <branch>` is all it takes to swap the deserializer** — no rebuild, no
> reinstall. The change is pure Python and loaded live on the next `bench run`. (The server is
> Java and never changes, so no rebuild between arms. The harness is **run-only** — it never
> builds; it executes the pre-built launcher it finds on disk.)

### Build & start the server

> **Use the `gremlin-server-modern.yaml` config — not the default.** The latency tests traverse
> the **Modern graph**, which only the `*-modern.yaml` config preloads; the default
> `gremlin-server.yaml` serves an empty graph and `g.V()` returns nothing. Apply the host/timeout
> edits to **that** file. (On the provisioned server the 4.0 build is **already compiled** under
> `~/tinkerpop-4/gremlin-server/target/...-standalone` — check before spending minutes on `mvn`.)

> **Watch for a leftover wrong-version server on 8182.** These boxes are reused across 3.7 and 4.0
> runs; a stale **3.7** server may still be bound to 8182. A 3.7 server does **not** speak
> GraphBinary **V4**, so the 4.x driver comparison would be invalid. Always check first and stop it:
> ```bash
> pgrep -af gremlin-server                 # inspect the cmdline — note 3.7.x vs 4.0.0 in the path
> ss -ltn | grep 8182                      # is something already listening?
> kill <pid> ; sleep 3 ; ss -ltn | grep 8182 || echo "port 8182 free"
> ```

**Setup A (localhost) — build if needed, then start with the modern config:**

```bash
cd ~/tinkerpop-4
# build only if the standalone dir is absent:
ls gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone 2>/dev/null \
  || mvn clean install -pl gremlin-server -am -DskipTests -Dasciidoc.skip=true
cd gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone
ulimit -n 65536 2>/dev/null || true       # may be denied on locked-down users; Modern graph is tiny, harmless
export JAVA_OPTIONS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
sed -i 's/^evaluationTimeout: .*/evaluationTimeout: 30000000/' conf/gremlin-server-modern.yaml
bin/gremlin-server.sh conf/gremlin-server-modern.yaml   # wait for: Channel started at port 8182
```

**Setup B (cross-region):** same as above on the **server EC2** (`16.59.222.63`), plus open the
server config to the network so the US-WEST-2 client can reach it:
```bash
sed -i 's/^host: localhost/host: 0.0.0.0/' conf/gremlin-server-modern.yaml
```
Leave the server running in its own `tmux`/`screen` pane for the whole session. See
`java-benchmarking-guide.md` §3–4 (or `bench/BENCHMARKING.md` "Server setup & tuning")
for full server tuning.

### Confirm the harness resolves the python launcher (no server needed)

```bash
cd ~/tinkerpop-4/bench
bench run --glv python --test protocol-overhead --size medium --dry-run
# expect the resolved python launcher path + the exact argv; any unbuilt GLV shows MISSING
```

---

## 3. Load the graph and verify connectivity

The latency tests traverse the **Modern graph**; it must be loaded once per server restart
(otherwise `g.V()` returns nothing). The simplest load is a one-shot tiny run:

```bash
cd ~/tinkerpop-4/bench
HOST=16.59.222.63       # Setup B server IP; use localhost for Setup A

# a tiny smoke cell both loads/warms and proves the plumbing end-to-end
bench run --glv python --test protocol-overhead --size tiny \
  --host $HOST --label candidate-eval --executions 1 --warmups 1 \
  --output-dir ~/cand-results/_connectivity
```

A row with `status=ok` and a non-empty `median` in
`~/cand-results/_connectivity/ledger.csv` means you're ready. Connection refused → check the
server is up (Setup A) or the security group / `host: 0.0.0.0` (Setup B). If the graph is
empty you'll see a zero/!=6 result count in the cell log under `logs/`.

---

## 4. The benchmark loop (the core of this doc)

We sweep **baseline first, then each candidate**, capturing both the wall-clock latency (via
the ledger) and the yappi CPU profile per arm. Do **3 full sweeps** (whole baseline→candidates
cycle) so you have medians of medians, not single noisy samples. Each arm writes to its own
`--output-dir` so the per-branch ledgers stay separate.

### 4a. One-time scaffolding

```bash
source ~/venv-glv/bin/activate 2>/dev/null  # provisioned box: no venv — driver is on system python3.11, this is a harmless no-op
cd ~/tinkerpop-4/bench
mkdir -p ~/cand-results
HOST=16.59.222.63      # Setup B server IP; localhost for Setup A
REPO=~/tinkerpop-4

# branch list: baseline MUST be first
BRANCHES=(
  4-glv-python-perf
  auto/cand-inline-is-null
  auto/cand-index-type-byte
  auto/cand-b-hybrid-int-dispatch
  auto/cand-full-flatten-decode-table
)
```

### 4b. Per-arm function

```bash
run_arm () {
  local branch="$1" sweep="$2"
  local tag="${branch##*/}"                 # e.g. cand-inline-is-null or 4-glv-python-perf
  local out=~/cand-results/$tag
  mkdir -p "$out"

  echo "===== sweep $sweep :: $branch ====="
  git -C "$REPO" checkout "$branch" 2>/dev/null      # swaps graphbinaryV4.py live
  git -C "$REPO" log --oneline -1                    # record exactly what we're running

  # --- MEDIUM, with CPU profile (the anchor signal) ---
  GREMLIN_PROFILE=yappi-cpu \
  GREMLIN_PROFILE_OUT="$out/medium-s$sweep" \
  bench run --glv python --test protocol-overhead --size medium \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  # --- TINY, fixed-overhead guard (must not regress) ---
  bench run --glv python --test protocol-overhead --size tiny \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  sleep 30      # cool-down between arms
}
```

Notes:
- `GREMLIN_PROFILE_OUT` produces `<prefix>-yappi-cpu.txt` (sorted by `tsub`) and
  `<prefix>-yappi-cpu.callgrind` (for KCachegrind), written by the committed yappi hook.
- The matrix defaults are `warmups: 2, executions: 3`; we bump executions to 5 for tighter
  medians (this matches what the funnel workflow used). **Note:** under
  `GREMLIN_PROFILE=yappi-cpu` the profiled medium cell still runs only **3** executions (the
  profiling path caps it) — that's expected; tiny (unprofiled) honors `--executions 5`.
- **yappi inflates the profiled medium cell ~30× on this hot path** (measured: unprofiled warmup
  ≈ 7.5 s/req → profiled test ≈ **230 s/req**). Two consequences: (1) the medium `median` in
  `ledger.csv` is the *profiler-inflated* number, **not** clean wall-clock — the only clean medium
  wall-clock is in the unprofiled **warmup** lines of stdout, which the ledger does not persist;
  (2) the comparison stays valid because **every arm is profiled identically**, so the inflation
  cancels and the `tsub` self-time delta (§5b) is honest. Read §5a wall-clock off the **tiny**
  cell and the medium **warmup** lines, never the profiled medium ledger median.
- The profiled medium cell prints `avg latency (sec/req): 0.0` — a **display bug** in the app's
  averaging under profiling. Ignore it; the real per-execution values are in the `RESULT_JSON:`
  `measurements` array and the ledger.
- All rows for an arm **append** to that arm's `ledger.csv` — re-running never overwrites
  (the harness's append-only ledger is the whole point; see README §"Re-runs APPEND").

### 4c. Run the sweeps

```bash
for sweep in 1 2 3; do
  for b in "${BRANCHES[@]}"; do
    run_arm "$b" "$sweep"
  done
done 2>&1 | tee ~/cand-results/sweep-run.log   # log it so you can detach and inspect later
git -C "$REPO" checkout 4-glv-python-perf      # leave the tree on baseline when done
```

> **Time budget (measured, with profiling on).** The *unprofiled* medium baseline is ~7.5 s/req,
> but the **yappi profiler inflates each profiled medium cell ~30×** to ≈230 s/req (3 executions
> = ~12 min/cell). So the full **3-sweep × 5-branch** loop is **~3 hours**, not the ~20–30 min an
> unprofiled run would take. Budget accordingly: run under `tmux`/`screen`, kick it off, detach
> (`Ctrl-b d`), and disconnect — reattach with `tmux attach`. **Never run two arms at once** —
> concurrent client CPU contention corrupts the comparison.
>
> **Want it faster?** yappi is *deterministic*, and the §5b gate sums only the `medium-s1`
> profile — so profiling all 3 sweeps is largely redundant. A practical split is: profile medium
> **once** per arm (feeds the gate), then run the remaining sweeps **unprofiled** (drop the two
> `GREMLIN_PROFILE*` env vars from `run_arm`'s medium cell) for clean wall-clock medians in
> ~45–60 min total. The loop above keeps profiling every sweep to follow the doc literally.

---

## 5. Read the results

### 5·0. Publish to S3, then analyze in the notebook (preferred)

The reproducible path is **`bench/auto/candidate-analysis.ipynb`** (pandas + plotly), which pulls
every arm's `ledger.csv` + yappi profiles from S3 and computes the gate + guards + charts + a
PASS/FAIL verdict — no hand-run `awk`. From the EC2 client, publish the results once the sweep is done:

```bash
aws s3 sync ~/cand-results "s3://kirill-tp-benchmarks/cand-results/python/" \
  --exclude "*.callgrind"      # callgrind is large + not needed for the notebook
```

Then open `candidate-analysis.ipynb` anywhere with AWS creds for the bucket, set `GLV='python'`
in the parameters cell, and **Run All**. It reproduces §5a–§5c below deterministically. The raw
shell commands that follow are kept as a no-Jupyter fallback / cross-check.

### 5a. Wall-clock latency from the ledgers (quick read)

Each arm's `ledger.csv` has one row per cell with computed `median`/`mean`/`p99` (the apps
emit only raw values via `RESULT_JSON:`; the harness computes stats — see README + `SCHEMA.md`).

```bash
# medium median (sec/req, lower is better) per branch, across sweeps
for d in ~/cand-results/*/; do
  [ -f "$d/ledger.csv" ] || continue
  echo "== $(basename "$d") =="
  awk -F, 'NR==1{for(i=1;i<=NF;i++)h[$i]=i; next}
           $h["point_value"]=="medium" {printf "  medium median=%s status=%s errors=%s\n", $h["median"], $h["status"], $h["errors"]}' \
      "$d/ledger.csv"
done
```

Take the **median across the 3 sweeps** per branch. A candidate is interesting if its medium
median beats baseline and its tiny median doesn't regress (>10% = reject).

> ⚠️ **Caveat on the medium median here.** As noted in §4b, when the medium cell is run under
> `GREMLIN_PROFILE=yappi-cpu` its ledger `median` is the **profiler-inflated** ~230 s number, not
> clean wall-clock — so this awk is only a meaningful *wall-clock* read if you ran the medium cell
> **unprofiled** (the §4c "want it faster?" split). With the literal all-profiled loop, treat the
> medium ledger median as profiled-only and lean on **§5b (yappi `tsub`)** as the decision signal;
> the **tiny** median below is unprofiled and remains a valid clean wall-clock guard.

### 5b. yappi CPU profile — the deterministic gate

This is the number that decides a win. For each arm, sum the self-time (`tsub`) column of one
medium profile and compare to baseline:

```bash
sum_tsub () {   # $1 = path to a *-yappi-cpu.txt file
  awk 'NR>2 && $3 ~ /^[0-9.]+$/ { s+=$3 } END { printf "%.3f\n", s }' "$1"
}

base=$(sum_tsub ~/cand-results/4-glv-python-perf/medium-s1-yappi-cpu.txt)
echo "baseline total self-time: ${base}s"
for d in ~/cand-results/cand-*; do
  c=$(sum_tsub "$d"/medium-s1-yappi-cpu.txt)
  drop=$(awk -v b="$base" -v c="$c" 'BEGIN{ printf "%.1f", (b-c)/b*100 }')
  printf "%-34s total=%ss  drop=%s%%\n" "$(basename "$d")" "$c" "$drop"
done
```

**Gate: total self-time drop ≥ 5%** = a real win. Confirm the drop lands in the targeted
hotspot, not noise elsewhere:

```bash
grep -E "graphbinaryV4|to_object|read_object|is_null|DataType" \
  ~/cand-results/cand-inline-is-null/medium-s1-yappi-cpu.txt | head
```

Repeat across all 3 sweeps; a win should reproduce in every sweep, not just one.

### 5c. Sanity gates (any failure invalidates the arm)

- **`status` must be `ok` and `errors` must be `0`** for every row (columns are right there in
  `ledger.csv`).
- **Warmup must pass** — a `median` of 0 / empty + an `error_reason` means the warmup gate
  aborted; re-run.
- **Result count must match baseline** — the medium traversal must return the same count for
  every arm (check each cell's log under `<output-dir>/logs/`); a different count means the
  candidate changed behavior and the comparison is void.

---

## 6. Decide & record

Fill this per candidate (median of 3 sweeps). The EC2 baseline anchors from `results.csv`
(Python 4.x, m7a client) are listed so you can sanity-check your baseline arm before trusting
any delta:

```
EC2 baseline reference:  medium ≈ 7.5 s/req UNPROFILED (warmup) / ~230 s/req PROFILED,  tiny ≈ 0.11 s/req
Medium result count (every arm must match): 200766

Candidate:
Git commit (client):
Server: 16.59.222.63 (m7a.8xlarge, US-EAST-2)  Client: m7a.4xlarge, US-WEST-2  Python: 3.11

| Arm            | tiny med (s) | yappi total self (s) | CPU drop % | medium count |
|----------------|--------------|----------------------|------------|--------------|
| baseline       |  (~0.11)     | (anchor)             |  —         | 200766       |
| <candidate>    |              |                      |            | (must=200766)|
```

> **Baseline hot-spot reference (from `medium-s1-yappi-cpu.txt`, sorted by `tsub`).** Use this to
> confirm each candidate's CPU drop lands in the *intended* hot spot, not noise elsewhere:
> | Hot spot | self-time `tsub` | targeted by |
> |---|---|---|
> | `transport.py:51 AiohttpSyncStream.read` | ~119 s | network read — irreducible, not a target |
> | `graphbinaryV4:159 to_object` | ~89 s | the deser core — all candidates |
> | `graphbinaryV4:86 <lambda>` | ~41 s | `cand-inline-is-null` (drops the lambda) |
> | `graphbinaryV4:195 is_null` | ~26 s | `cand-inline-is-null` |
> | `aenum DataType.__hash__` | ~24 s | `cand-index-type-byte`, `cand-b-hybrid-int-dispatch` |
> | `aenum __call__` + `property.__get__` | ~22 + 21 s | `cand-full-flatten-decode-table`, int-dispatch |

- **Win** = CPU drop ≥ 5% **and** tiny-query regression < 10% **and** result counts match
  **and** `status=ok`/`errors=0`, reproduced across all 3 sweeps.
- Each branch is already a clean single commit on `4-glv-python-perf` — a winner merges with a
  plain `git merge --no-ff auto/cand-<id>`. Merge **one at a time** and re-bench; two that
  touch the same hot path may be substitutes rather than additive.

---

## 7. Optional: throughput context

Deser cost shows up mainly in latency on large result sets, but the harness can also run the
throughput tests if you want context (note Python is GIL-bound — `results.csv` shows the 4.0
scaling curve peaking ~2000 req/s around C=128 then falling):

```bash
bench run --glv python --test scaling-curve --host $HOST --label candidate-eval \
  --concurrency 64 --concurrency 128 --output-dir ~/cand-results/<tag>
```

A deser micro-opt rarely moves GIL-bound throughput much; **latency + yappi are the signals
that matter here.**

---

## 8. Teardown

```bash
git -C ~/tinkerpop-4 checkout 4-glv-python-perf    # tree back on baseline
# stop the server: Ctrl+C in its console (Setup A) or on the server EC2 (Setup B)
# leave the EC2 instances running if other GLV benchmarks will reuse them (this pair is shared);
# otherwise stop/terminate once results are collected
```

---

## 9. Cheat sheet

```bash
# PROVISIONED BOX (Setup B): repo already at ~/tinkerpop-4, fork = `fork` remote, server = 16.59.222.63
cd ~/tinkerpop-4 && git fetch fork
for b in 4-glv-python-perf auto/cand-inline-is-null auto/cand-index-type-byte \
         auto/cand-b-hybrid-int-dispatch auto/cand-full-flatten-decode-table; do
  git branch --track "$b" "fork/$b" 2>/dev/null || true; done
pip3.11 install --user -e ~/tinkerpop-4/bench && pip3.11 install --user yappi   # if missing
# server box (16.59.222.63): kill any stale 3.7 server on 8182, then start 4.0 with MODERN config:
#   bin/gremlin-server.sh conf/gremlin-server-modern.yaml   (host: 0.0.0.0 already set)
# verify connectivity from client (§3): tiny cell must return result count 6, status=ok

# FRESH BOX (Setup A): clone fork as origin, venv, editable installs, mvn build — see §2

# sweep (baseline first) — see §4 for run_arm + BRANCHES; ~3 hrs PROFILED, run under tmux
for s in 1 2 3; do for b in "${BRANCHES[@]}"; do run_arm "$b" "$s"; done; done

# read
# gate (decides winners): sum yappi tsub per arm, compute drop vs baseline ≥5% (§5b)
# guards: tiny median (unprofiled) <10% regression + medium count == 200766 + status=ok (§5a/§5c)
```

---

## See also

- `bench/README.md` — the harness: `bench run` usage, the append-only ledger, `--label`
  discipline, and the local-vs-EC2 warning this doc follows.
- `bench/SCHEMA.md` — the `RESULT_JSON:` contract behind every ledger row.
- `bench/matrix.yaml` — the test definitions; `protocol-overhead` medium = `times(12)`, tiny = `g.V()`.
- `java-benchmarking-guide.md` / `python-benchmarking-plan.md` — full two-EC2 cross-region
  setup and the `control` reference numbers in `results.csv`.
- `bench/auto/candidate-analysis.ipynb` — the reproducible pandas/plotly notebook that reads the
  S3-published results and renders the gate, guards, charts, and PASS/FAIL verdict (§5·0).
- `bench/auto/RUNBOOK.md` — the autonomous funnel that proposed these candidates.
