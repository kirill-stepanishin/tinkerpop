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
# Benchmarking the GraphBinary-deser Candidates on EC2

Step-by-step guide to measure the proposed gremlin-python deserialization
optimizations on EC2, **head-to-head against the pinned `bench-baseline` baseline**, using the
`bench` harness (`bench/README.md`) so the runs land in the same append-only ledger format as
all prior TinkerPop benchmarking — with deterministic numbers you can trust (unlike noisy,
contended localhost).

> **This is the fully worked, instantiated example** of the language-agnostic template
> `EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — gremlin-python, the current GraphBinary-deser
> candidate set. Read the two side-by-side: this file fills in every template placeholder with
> real branches, files, and measured numbers.

## What we are measuring

Each candidate is a single-commit, python-only change touching **one file** — most touch the
GraphBinary V4 deserialization hot path
`gremlin-python/src/main/python/gremlin_python/structure/io/graphbinaryV4.py`, a few touch
`structure/graph.py` or `driver/serializer.py`. The server is identical for every arm; **only
the client-side Python deserializer changes**, so this is a clean apples-to-apples comparison.

### Baseline (pinned to an immutable fork-point SHA)

The candidates were cut from the gremlin-python deser-optimization **fork point on branch
`4-glv-profiling`**. **`4-glv-profiling` is a MOVING branch** — its tip advances as funnel-infra
commits land — so the baseline is pinned to the immutable fork-point SHA **`de50057c9e`**, never
the branch tip. A moving tip would silently mix extra commits into the comparison.

For this run we created a dedicated baseline branch **`bench-baseline`** = `de50057c9e` **plus
one profiling-app fix commit** (see "Required profiling-app fix" below), tip **`ae236e1970`**,
pushed to the fork. So:

- **Baseline arm** = `bench-baseline` (tip `ae236e1970`).
- **Each candidate arm** = `bench-baseline` + exactly one deser commit (cherry-picked onto
  `bench-baseline` into a `-fixed` branch so it carries the same profiling-app fix).

### The candidate set (14 branches)

The current set is **14 gremlin-python candidates**, each ONE commit, each touching a single
file, all full-suite (`mvn clean install`) green — produced by
`glv-correctness-funnel.workflow.js` and re-gated by `glv-recovery-gate.workflow.js`. For the
head-to-head benchmark each was cherry-picked onto `bench-baseline` (`ae236e1970`) into a
`-fixed` branch (branch name `auto/cand-python-<id>-fixed`) so it carries the profiling-app fix.
Each is one commit on `bench-baseline`, single file, full-suite green. The funnel produces this
set **fresh each run — it is non-deterministic, do not assume a fixed set**.

**Contract-clean (11) — benchmark, then merge:**

| Branch (`auto/cand-python-…-fixed`) | File | Optimization |
|---|---|---|
| `b-hybrid-int-dispatch-cache` | `graphbinaryV4.py` | int-keyed deserializer dispatch in `GraphBinaryReader` |
| `c1-int-from-bytes-unpackers` | `graphbinaryV4.py` | `int.from_bytes` for integer unpackers |
| `inline-element-init` | `graph.py` | inline `Element.__init__` into element subclasses |
| `inline-type-byte-read` | `graphbinaryV4.py` | drop the uint8 unpack lambda for the dispatch type byte |
| `marker-sentinel-fast-eq` | `serializer.py` | fast-path `Marker` type check in the GraphBinary loop |
| `memoize-datatype-member` | `graphbinaryV4.py` | memoize `DataType` code lookup in `to_object` |
| `null-code-module-const` | `graphbinaryV4.py` | bind the null type code to a module constant |
| `optimize-read-list-loop` | `graphbinaryV4.py` | optimize the `_read_list` deserialization loop |
| `read-object-bypass-in-collections` | `graphbinaryV4.py` | bypass the `read_object` wrapper in collection reads |
| `specialize-single-string-label` | `graphbinaryV4.py` | specialize single-string label decode in readers |
| `vertexproperty-single-properties-write` | `graphbinaryV4.py` | set `VertexProperty` properties in the constructor |

**Break soft contract (3) — green, but a major-version judgment call; benchmark, surface separately:**

| Branch (`auto/cand-python-…-fixed`) | File | Concern | Optimization |
|---|---|---|---|
| `element-slots` | `graph.py` | public-api | add `__slots__` to structure element classes |
| `coalesce-null-flag-value-read` | `graphbinaryV4.py` | custom-serializer | coalesce null-flag and value read for fixed-width scalars |
| `inline-null-flag-scalars` | `graphbinaryV4.py` | custom-serializer | inline the null-flag check in scalar `objectify` |

All arms are pushed to the fork `git@github.com:kirill-stepanishin/tinkerpop.git`.

> **Remote naming on the benchmarking EC2s.** On the pre-provisioned benchmarking boxes the
> repo lives at **`~/tinkerpop-4`** and the fork is the **`fork`** remote (`origin` points at
> upstream `apache/tinkerpop`, over HTTPS). Every `git` command below uses `fork`/`~/tinkerpop-4`
> accordingly — if you stand up a fresh box where the fork is `origin`, translate back.

> **Required profiling-app fix (carried by every arm).** The python profiling app
> `gremlin-python/src/main/python/gremlin_python/driver/util/profiling_application.py` passed
> `request_serializer=GraphBinarySerializersV4()` into the driver `Client(...)`, which has **no
> such parameter**. It fell through `**transport_kwargs` to aiohttp's `ClientSession.post()` and,
> under **aiohttp 3.13.5**, raised
> `TypeError: ClientSession._request() got an unexpected keyword argument 'request_serializer'`
> (older aiohttp tolerated it). This breaks **every arm** at warmup with
> *"no RESULT_JSON line found in stdout"*. **Fix** (committed as `bench-baseline` `ae236e1970`,
> and cherry-picked under every `-fixed` candidate): remove the unsupported `request_serializer=…`
> at both call sites — the `_create_client` method and the `args.exercise` `init_client` block —
> and drop the now-unused `from gremlin_python.driver.serializer import GraphBinarySerializersV4`
> import. Behavior is unchanged because the driver already defaults `response_serializer` to
> `GraphBinarySerializersV4()` (GraphBinary V4 both directions). Because the fix is identical on
> every arm it does **not** bias the comparison — but the baseline and all candidate arms must
> carry it (hence the `bench-baseline` + `-fixed` cherry-pick scheme).

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
`g.V().repeat(both()).times(12)` is the primary test. On the Modern graph it returns
**200766 objects** per request at **~8 s/req** cross-region (verified this run: warmup 8.2287s,
test 7.9885s, result count 200766). Network RTT is **<1%** of that, so **client-side
deserialization dominates total latency**. The **tiny** point `g.V()` (6 vertices) is an
*optional* fixed-overhead guard (it must not regress) — but this run dropped tiny and ran
**medium-only**, because the user only cares about the deser-dominated medium query.

Two signals per candidate — one primary, one optional cross-check:

1. **Unprofiled medium wall-clock latency (median)** *(the primary decision metric)* — the
   harness records one row per cell to `ledger.csv`; read the **`median`** column (sec/req) from
   the **medium** point run **unprofiled**. Because deser dominates this query, a real client-CPU
   win shows up directly here. This is the realistic headline number.
2. **yappi CPU self-time profile** *(optional, secondary cross-check)* — set
   `GREMLIN_PROFILE=yappi-cpu` and the committed hook in `profiling_application.py` dumps a
   self-time (`tsub`) profile. A **total self-time drop ≥ 5%** vs the baseline arm (summed over
   the `tsub` column) is a deterministic, **network-independent** confirmation that a win lands in
   the deser hot path — useful for *attribution*, **not the sole gate**. Run it only if you want
   that cross-check.

**Hard validity gates (any failure voids the arm):** the medium **result count must equal
200766** on every arm, and **`status=ok` and `errors=0`** on every row.

> **Never read latency from a profiled cell.** yappi inflates the profiled medium cell **~30×**
> on this hot path, so its `median` is not a wall-clock number. Run **medium unprofiled** for the
> latency signal; if you also want yappi attribution, run it as a **separate single pass**, not
> the same cell.

> Run baseline and each candidate **back-to-back in the same session** and compare the
> *relative* delta. Never quote raw EC2 ms as an absolute latency figure.

---

## 1. Infrastructure

Only the **client EC2** is special for this work (deser is client-side). Two valid setups:

| Setup | Server | Client | When |
|---|---|---|---|
| **A — single instance** (simplest) | localhost on the client box | same box | fastest to stand up; valid here because we only compare *candidates to each other*, all sharing one server + network so they cancel, and the optional yappi CPU cross-check is network-independent |
| **B — cross-region** (matches prior runs) | `m7a.8xlarge`, US-EAST-2 | `m7a.4xlarge` (16 vCPU), US-WEST-2 | if you also want wall-clock numbers comparable to the `control` rows in `results.csv` / `python-benchmarking-plan.md` |

> **The provisioned benchmarking pair (Setup B) — concrete values.** The same two EC2s used for
> all prior per-language runs (`python-/go-/dotnet-benchmarking-plan.md`) are reused here:
> - **Server:** `m7a.8xlarge`, US-EAST-2, IP **`16.59.222.63`** → on the client set `HOST=16.59.222.63`.
> - **Client:** `m7a.4xlarge` (16 vCPU), US-WEST-2 — where the driver, harness, and this doc run.
> - Security group already allows TCP **8182** from the client to the server (prior runs used it).
>
> These match the `--host 16.59.222.63` lines in the sibling language plans. If the instances are
> ever re-created the IP changes, so re-confirm with `ec2-metadata`/`hostname -I` on the server box.

Because the primary signal here is **unprofiled medium wall-clock latency** (§0), **this run
used Setup B (cross-region)** to get realistic deser-dominated latency comparable to the
`control` rows in `results.csv`. Setup A is still valid for a quick relative read — the server
and network are constant across arms so they cancel, and the optional yappi cross-check is
CPU-only — but Setup B is preferred when latency is the decision metric.

> **Important nuance on `--label`.** `bench/README.md` reserves `--label smoke` for localhost
> plumbing checks and `--label control` for the two-EC2 cross-region setup. Our Setup A
> (server on the client's localhost, but on a quiet dedicated EC2 with no competing workload)
> is a third case: it is *more* trustworthy than a laptop but is **not** the canonical
> cross-region `control`. **Tag Setup-A runs `--label candidate-eval`** so they are never
> mistaken for either a laptop `smoke` row or a cross-region `control` row.

**Instance recommendation (Setup A):** compute-optimized, ≥8 vCPU, ≥16 GB RAM (e.g.
`c7i.2xlarge` / `m7a.2xlarge`) on **Amazon Linux 2023**. The medium traversal returns
**200766 objects** per request against the Modern graph (`times(12)`) — measured; the exact
number doesn't matter as long as it is **identical across every arm** (it is a hard validity
gate — see §5c). Still give the client memory headroom.

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
> python3 -c "import yappi" 2>&1 | tail -1                                 # yappi installed? (only for the optional CPU cross-check)
> bench --help 2>&1 | head -1 || echo "bench not installed"               # harness on PATH?
> ```
>
> On that box the driver was **not** installed under a `~/venv-glv` venv — it resolves from the
> source tree on the **system `python3.11`**, and `bench` installs with
> `pip3.11 install --user -e ~/tinkerpop-4/bench` (its only dep, PyYAML, is already present).
> `yappi` installs with `pip3.11 install --user yappi` (needed only for the optional yappi CPU
> cross-check). The fresh-box recipe below assumes a venv; either path works as long as the
> driver imports from the source tree.

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
# baseline first, then the 14 candidate arms (auto/cand-python-<id>-fixed):
for b in bench-baseline \
         auto/cand-python-b-hybrid-int-dispatch-cache-fixed \
         auto/cand-python-c1-int-from-bytes-unpackers-fixed \
         auto/cand-python-inline-element-init-fixed \
         auto/cand-python-inline-type-byte-read-fixed \
         auto/cand-python-marker-sentinel-fast-eq-fixed \
         auto/cand-python-memoize-datatype-member-fixed \
         auto/cand-python-null-code-module-const-fixed \
         auto/cand-python-optimize-read-list-loop-fixed \
         auto/cand-python-read-object-bypass-in-collections-fixed \
         auto/cand-python-specialize-single-string-label-fixed \
         auto/cand-python-vertexproperty-single-properties-write-fixed \
         auto/cand-python-element-slots-fixed \
         auto/cand-python-coalesce-null-flag-value-read-fixed \
         auto/cand-python-inline-null-flag-scalars-fixed ; do
  git branch --track "$b" "origin/$b" 2>/dev/null || true   # provisioned box: "fork/$b"
done
git checkout bench-baseline
# verify the baseline arm is at the expected tip (bench-baseline = de50057c9e + profiling-app fix = ae236e1970):
git log --oneline -1

# --- python venv + the gremlin driver (editable) + the bench harness ---
python3.11 -m venv ~/venv-glv
source ~/venv-glv/bin/activate
pip install -U pip
pip install -e ~/tinkerpop/gremlin-python/src/main/python   # driver (aiohttp, aenum, isodate, ...)
pip install -e ~/tinkerpop/bench                            # the `bench` harness (per bench/README.md)
pip install yappi                                           # only for the optional yappi CPU cross-check

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

> **Run this connectivity cell FIRST — it catches the profiling-app fix gap before you burn a
> full sweep.** The `request_serializer=…` bug described under "Required profiling-app fix" (§What
> we are measuring) fails **identically on every arm** at warmup with *"no RESULT_JSON line found
> in stdout"* — so it looks like a universal benchmark failure, not a code bug. If this cell (or
> any later cell) fails that way, **read the cell's log under `<output-dir>/logs/`** for the real
> `TypeError: … unexpected keyword argument 'request_serializer'` traceback, and confirm you are
> on `bench-baseline` (`ae236e1970`) / a `-fixed` candidate arm — every arm must carry the fix.

---

## 4. The benchmark loop (the core of this doc)

We sweep **baseline first, then each candidate**, capturing the **unprofiled medium wall-clock
latency** (via the ledger — the primary signal) and, optionally, a separate yappi CPU pass per
arm. This run used **`--executions 10`, `--warmups 2`, `--label candidate-eval`, baseline-first,
3 sweeps, medium-only** (tiny dropped — only the deser-dominated medium query matters here). Do
**3 full sweeps** (whole baseline→candidates cycle) so you have medians of medians, not single
noisy samples. Each arm writes to its own `--output-dir` so the per-branch ledgers stay separate.

### 4a. One-time scaffolding

```bash
source ~/venv-glv/bin/activate 2>/dev/null  # provisioned box: no venv — driver is on system python3.11, this is a harmless no-op
cd ~/tinkerpop-4/bench
mkdir -p ~/cand-results
HOST=16.59.222.63      # Setup B server IP; localhost for Setup A
REPO=~/tinkerpop-4

# branch list: baseline MUST be first
BRANCHES=(
  bench-baseline
  auto/cand-python-b-hybrid-int-dispatch-cache-fixed
  auto/cand-python-c1-int-from-bytes-unpackers-fixed
  auto/cand-python-inline-element-init-fixed
  auto/cand-python-inline-type-byte-read-fixed
  auto/cand-python-marker-sentinel-fast-eq-fixed
  auto/cand-python-memoize-datatype-member-fixed
  auto/cand-python-null-code-module-const-fixed
  auto/cand-python-optimize-read-list-loop-fixed
  auto/cand-python-read-object-bypass-in-collections-fixed
  auto/cand-python-specialize-single-string-label-fixed
  auto/cand-python-vertexproperty-single-properties-write-fixed
  auto/cand-python-element-slots-fixed
  auto/cand-python-coalesce-null-flag-value-read-fixed
  auto/cand-python-inline-null-flag-scalars-fixed
)
```

### 4b. Per-arm function

```bash
run_arm () {
  local branch="$1" sweep="$2"
  local tag="${branch##*/}"                 # e.g. cand-python-inline-type-byte-read-fixed or bench-baseline
  local out=~/cand-results/$tag
  mkdir -p "$out"

  echo "===== sweep $sweep :: $branch ====="
  git -C "$REPO" checkout "$branch" 2>/dev/null      # swaps the touched file (graphbinaryV4.py / graph.py / serializer.py) live
  git -C "$REPO" log --oneline -1                    # record exactly what we're running

  # --- MEDIUM, UNPROFILED (the PRIMARY signal: wall-clock median) ---
  bench run --glv python --test protocol-overhead --size medium \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 10 \
    --output-dir "$out"

  # --- MEDIUM, with yappi CPU profile (OPTIONAL attribution cross-check; SEPARATE pass) ---
  # Skip entirely if you don't need CPU attribution. NEVER read latency from this cell — yappi
  # inflates it ~30×. This run was medium-only and treated this pass as optional.
  # GREMLIN_PROFILE=yappi-cpu \
  # GREMLIN_PROFILE_OUT="$out/medium-s$sweep" \
  # bench run --glv python --test protocol-overhead --size medium \
  #   --host "$HOST" --label candidate-eval --warmups 2 --executions 10 --output-dir "$out"

  sleep 30      # cool-down between arms
}
```

Notes:
- **Latency comes from the UNPROFILED medium pass; never from a profiled cell.** This run is
  **medium-only** (tiny dropped — the user only cares about the deser-dominated medium query); if
  you want the fixed-overhead guard, add an unprofiled `--size tiny` cell.
- We use `--executions 10 --warmups 2` (the matrix defaults are `warmups: 2, executions: 3`) for
  tighter medians. **If you enable the optional yappi pass:** under `GREMLIN_PROFILE=yappi-cpu`
  the profiled medium cell still runs only **3** executions (the profiling path caps it) — that's
  expected; the unprofiled medium pass honors `--executions 10`.
- `GREMLIN_PROFILE_OUT` (optional pass) produces `<prefix>-yappi-cpu.txt` (sorted by `tsub`) and
  `<prefix>-yappi-cpu.callgrind` (for KCachegrind), written by the committed yappi hook.
- **yappi inflates the profiled medium cell ~30× on this hot path** — so its `ledger.csv`
  `median` is the *profiler-inflated* number, **not** clean wall-clock. Read latency only from the
  **unprofiled** medium pass; run yappi as a **separate single pass** purely for attribution
  (§5b), where the inflation cancels because every arm is profiled identically.
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
git -C "$REPO" checkout bench-baseline         # leave the tree on baseline when done
```

> **Time budget.** The unprofiled medium pass is ~8 s/req × 10 executions + 2 warmups ≈ 1.5–2
> min/cell. The full **3-sweep × 15-arm** medium-only loop is well under an hour. (If you also
> enable the optional yappi pass, each profiled medium cell inflates ~30× to ≈230 s/req for 3
> executions ≈ 12 min/cell — that turns the loop into multiple hours, so profile sparingly: yappi
> is deterministic, so a single profiled pass per arm is enough for the §5b cross-check.) Run
> under `tmux`/`screen`, kick it off, detach (`Ctrl-b d`), and reattach with `tmux attach`.
> **Never run two arms at once** — concurrent client CPU contention corrupts the comparison.

---

## 5. Read the results

### 5·0. Publish to S3, then analyze in the notebook (preferred)

The reproducible path is **`bench/auto/candidate-analysis.ipynb`** (pandas + plotly), which pulls
every arm's `ledger.csv` (+ optional yappi profiles) from S3 and computes the
**unprofiled medium-latency delta** (primary), the validity guards, the optional yappi self-time
cross-check, charts, and a PASS/FAIL verdict — no hand-run `awk`. From the EC2 client, publish
the results once the sweep is done:

```bash
aws s3 sync ~/cand-results "s3://kirill-tp-benchmarks/cand-results/python/" \
  --exclude "*.callgrind"      # callgrind is large + not needed for the notebook
```

Then open `candidate-analysis.ipynb` anywhere with AWS creds for the bucket, set `GLV='python'`
in the parameters cell, and **Run All**. It reproduces §5a–§5c below deterministically. The raw
shell commands that follow are kept as a no-Jupyter fallback / cross-check.

### 5a. Unprofiled medium wall-clock median — the primary decision metric

Each arm's `ledger.csv` has one row per cell with computed `median`/`mean`/`p99` (the apps
emit only raw values via `RESULT_JSON:`; the harness computes stats — see README + `SCHEMA.md`).
Because deser dominates the medium query, this median **is** the realistic headline signal.

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

Take the **median across the 3 sweeps** per branch. A candidate is a win if its medium median
beats `bench-baseline` (subject to the §5c validity gates). Baseline reference this run:
**~8 s/req** (warmup 8.2287s, test 7.9885s).

> ⚠️ **Read latency only from the UNPROFILED medium pass.** If you ran the optional
> `GREMLIN_PROFILE=yappi-cpu` pass, its ledger `median` is the **profiler-inflated** ~230 s
> number, not clean wall-clock — never read latency from it. This run was medium-only and
> unprofiled, so its ledger median is the clean wall-clock figure directly.

### 5b. yappi CPU profile — optional, network-independent cross-check (not the gate)

The **primary metric is the unprofiled medium wall-clock median in §5a**; this is an *optional*
attribution cross-check. If you ran the optional yappi pass, sum the self-time (`tsub`) column of
one medium profile per arm and compare to baseline — a **total self-time drop ≥ 5% confirms the
win lands in the deser hot path** rather than being noise. Deterministic and network-independent,
but **secondary**: skip it and §5a still decides.

```bash
sum_tsub () {   # $1 = path to a *-yappi-cpu.txt file
  awk 'NR>2 && $3 ~ /^[0-9.]+$/ { s+=$3 } END { printf "%.3f\n", s }' "$1"
}

base=$(sum_tsub ~/cand-results/bench-baseline/medium-s1-yappi-cpu.txt)
echo "baseline total self-time: ${base}s"
for d in ~/cand-results/cand-python-*; do
  c=$(sum_tsub "$d"/medium-s1-yappi-cpu.txt)
  drop=$(awk -v b="$base" -v c="$c" 'BEGIN{ printf "%.1f", (b-c)/b*100 }')
  printf "%-50s total=%ss  drop=%s%%\n" "$(basename "$d")" "$c" "$drop"
done
```

Confirm the drop lands in the targeted hotspot, not noise elsewhere:

```bash
grep -E "graphbinaryV4|to_object|read_object|is_null|DataType" \
  ~/cand-results/cand-python-inline-null-flag-scalars-fixed/medium-s1-yappi-cpu.txt | head
```

Repeat across all 3 sweeps; a confirmed win should reproduce in every sweep, not just one.

### 5c. Sanity gates (hard validity gates — any failure invalidates the arm)

- **Result count must equal 200766** — the medium traversal must return the same count for
  every arm (check each cell's log under `<output-dir>/logs/`); a different count means the
  candidate changed behavior and the comparison is void.
- **`status` must be `ok` and `errors` must be `0`** for every row (columns are right there in
  `ledger.csv`).
- **Warmup must pass** — a `median` of 0 / empty + an `error_reason` means the warmup gate
  aborted; re-run (and confirm the arm carries the profiling-app fix — see §3).

---

## 6. Decide & record

Fill this per candidate (median of 3 sweeps). The baseline reference numbers are listed so you
can sanity-check your `bench-baseline` arm before trusting any delta:

```
Baseline reference (bench-baseline, ae236e1970):  medium ≈ 8 s/req UNPROFILED (warmup 8.2287s, test 7.9885s)
Medium result count (every arm must match): 200766

Candidate (branch):
Git commit (client):
Server: 16.59.222.63 (m7a.8xlarge, US-EAST-2)  Client: m7a.4xlarge, US-WEST-2  Python: 3.11

| Arm            | medium med (s, UNPROFILED) | yappi self drop % (optional) | medium count |
|----------------|----------------------------|------------------------------|--------------|
| bench-baseline | (~8.0, reference)          | —                            | 200766       |
| <candidate>    |                            |                              | (must=200766)|
```

> **Baseline hot-spot reference (from an optional `medium-s1-yappi-cpu.txt`, sorted by `tsub`).**
> If you ran the optional yappi pass, use this to confirm each candidate's CPU drop lands in the
> *intended* hot spot, not noise elsewhere:
> | Hot spot | self-time `tsub` | targeted by |
> |---|---|---|
> | `transport.py:51 AiohttpSyncStream.read` | ~119 s | network read — irreducible, not a target |
> | `graphbinaryV4:159 to_object` | ~89 s | the deser core — most candidates |
> | `graphbinaryV4` null-flag lambda / `is_null` | ~41 + 26 s | `inline-null-flag-scalars`, `coalesce-null-flag-value-read`, `null-code-module-const` |
> | `aenum DataType.__hash__` | ~24 s | `b-hybrid-int-dispatch-cache`, `memoize-datatype-member`, `inline-type-byte-read` |
> | `aenum __call__` + `property.__get__` | ~22 + 21 s | `read-object-bypass-in-collections`, `optimize-read-list-loop` |

- **Win** = **unprofiled medium wall-clock median improves** vs `bench-baseline` (the primary
  signal), reproduced across all 3 sweeps — subject to the **hard validity gates**: medium
  **count == 200766** for every arm, and `status=ok`/`errors=0` on every row. *Optional
  cross-check:* a yappi self-time drop ≥ 5% in the same hot path **confirms attribution** but is
  **not required** to call a win.
- The **3 break-soft-contract** candidates (`element-slots`, `coalesce-null-flag-value-read`,
  `inline-null-flag-scalars`) are green but are a major-version judgment call — **surface them
  separately** from the 11 contract-clean ones, even if they win.
- Each candidate is already a clean single commit on `bench-baseline` — once benchmarked, a
  contract-clean winner merges with a plain `git merge --no-ff auto/cand-python-<id>`. Merge
  **one at a time** and re-bench; two that touch the same hot path may be substitutes rather than
  additive.

---

## 7. Optional: throughput context

Deser cost shows up mainly in latency on large result sets, but the harness can also run the
throughput tests if you want context (note Python is GIL-bound — `results.csv` shows the 4.0
scaling curve peaking ~2000 req/s around C=128 then falling):

```bash
bench run --glv python --test scaling-curve --host $HOST --label candidate-eval \
  --concurrency 64 --concurrency 128 --output-dir ~/cand-results/<tag>
```

A deser micro-opt rarely moves GIL-bound throughput much; **unprofiled medium latency is the
signal that matters here** (with the optional yappi cross-check for attribution).

---

## 8. Teardown

```bash
git -C ~/tinkerpop-4 checkout bench-baseline       # tree back on baseline
# stop the server: Ctrl+C in its console (Setup A) or on the server EC2 (Setup B)
# leave the EC2 instances running if other GLV benchmarks will reuse them (this pair is shared);
# otherwise stop/terminate once results are collected
```

---

## 9. Cheat sheet

```bash
# PROVISIONED BOX (Setup B): repo already at ~/tinkerpop-4, fork = `fork` remote, server = 16.59.222.63
cd ~/tinkerpop-4 && git fetch fork
# baseline first, then the 14 candidate arms (auto/cand-python-<id>-fixed) — see §4a for the full list:
for b in bench-baseline auto/cand-python-b-hybrid-int-dispatch-cache-fixed \
         auto/cand-python-inline-type-byte-read-fixed auto/cand-python-inline-null-flag-scalars-fixed \
         "${BRANCHES[@]:1}"; do
  git branch --track "$b" "fork/$b" 2>/dev/null || true; done
pip3.11 install --user -e ~/tinkerpop-4/bench   # yappi only if you want the optional CPU cross-check
# server box (16.59.222.63): kill any stale 3.7 server on 8182, then start 4.0 with MODERN config:
#   bin/gremlin-server.sh conf/gremlin-server-modern.yaml   (host: 0.0.0.0 already set)
# verify connectivity from client (§3): tiny cell must return result count 6, status=ok
#   — and confirm the profiling-app fix is present (every arm = bench-baseline ae236e1970 or a -fixed cand)

# FRESH BOX (Setup A): clone fork as origin, venv, editable installs, mvn build — see §2

# sweep (baseline first), MEDIUM-ONLY, UNPROFILED — see §4 for run_arm + BRANCHES; <1 hr, run under tmux
for s in 1 2 3; do for b in "${BRANCHES[@]}"; do run_arm "$b" "$s"; done; done

# read
# primary (decides winners): unprofiled medium wall-clock median vs bench-baseline (§5a)
# hard gates: medium count == 200766 + status=ok/errors=0 (§5c)
# optional cross-check: sum yappi tsub per arm, drop vs baseline ≥5% confirms attribution (§5b)
```

---

## See also

- `EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — the language-agnostic template this file instantiates.
- `bench/README.md` — the harness: `bench run` usage, the append-only ledger, `--label`
  discipline, and the local-vs-EC2 warning this doc follows.
- `bench/SCHEMA.md` — the `RESULT_JSON:` contract behind every ledger row.
- `bench/matrix.yaml` — the test definitions; `protocol-overhead` medium = `times(12)`, tiny = `g.V()`.
- `java-benchmarking-guide.md` / `python-benchmarking-plan.md` — full two-EC2 cross-region
  setup and the `control` reference numbers in `results.csv`.
- `bench/auto/candidate-analysis.ipynb` — the reproducible pandas/plotly notebook that reads the
  S3-published results and renders the latency delta, guards, optional CPU cross-check, charts,
  and PASS/FAIL verdict (§5·0). Set its `BASELINE` parameter to the baseline arm's directory tag
  **`bench-baseline`**.
- `bench/auto/RUNBOOK.md` — `glv-correctness-funnel.workflow.js`, the autonomous funnel that
  proposes the candidate branches (it stops at `mvn clean install`; you benchmark the arms
  afterward with this doc), plus its companion `glv-recovery-gate.workflow.js` that re-gates
  recovered candidates.
