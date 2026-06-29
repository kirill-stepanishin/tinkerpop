<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file. Apache License 2.0.
-->

# Benchmarking the gremlin-javascript GraphBinary-deser Candidates on EC2

Step-by-step guide to measure the proposed **gremlin-javascript** GraphBinary V4 deserialization
optimizations on EC2, **head-to-head against the pinned `bench-baseline-javascript` baseline**, using
the `bench` harness (`bench/README.md`) so the runs land in the same append-only ledger format as
all prior TinkerPop benchmarking — with deterministic numbers you can trust (unlike noisy,
contended localhost).

> **This is the fully worked, instantiated example** of the language-agnostic template
> `EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — gremlin-javascript, the current GraphBinary-deser
> candidate set. Read the two side-by-side: this file fills in every template placeholder with real
> branches, files, and the Node-specific build/profile steps. It is the JS sibling of the worked
> python (`EC2-BENCHMARK-CANDIDATES.md`) and dotnet (`EC2-BENCHMARK-CANDIDATES-DOTNET.md`) docs.

## What we are measuring

Each candidate is a single-commit, **javascript-only** change. Every one touches the GraphBinary V4
deserialization hot path under
`gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/` — the per-type serializers
(`*Serializer.js`), the buffered `StreamReader.js`, or `GraphBinaryReader.js`. No test files are
touched. The server is identical for every arm; **only the client-side JavaScript deserializer
changes**, so this is a clean apples-to-apples comparison.

### Baseline (pinned to an immutable fork-point SHA)

The candidates were cut from the gremlin-javascript deser-optimization **fork point on branch
`4-glv-profiling`**. **`4-glv-profiling` is a MOVING branch** — its tip advances as funnel-infra
commits land — so the baseline is pinned to the immutable fork-point SHA **`5e7c118826`**, never the
branch tip. A moving tip would silently mix extra commits into the comparison. (This is the same
fork point the dotnet candidate set was cut from.)

For this run the baseline branch **`bench-baseline-javascript`** = `5e7c118826` exactly — **no extra
commit needed**. Unlike the gremlin-python run (which required an aiohttp profiling-app fix on top of
its fork point), the **javascript profiling app needs no fix**: it builds and runs unchanged on the
provisioned box. So:

- **Baseline arm** = `bench-baseline-javascript` (= `5e7c118826`).
- **Each candidate arm** = `bench-baseline-javascript` + exactly one deser commit (the
  `auto/cand-javascript-<id>` branch as the funnel produced it — no cherry-pick / `-fixed` scheme
  required, because there is no baseline fix to carry).

> **Create the baseline branch if it doesn't exist yet** (mirrors `bench-baseline-dotnet`):
> ```bash
> git branch bench-baseline-javascript 5e7c118826    # immutable fork point
> ```

### The candidate set (5 branches — produced by the JS funnel run)

The current set is **5 gremlin-javascript candidates**, each ONE commit on `5e7c118826`, each
touching files only within `binary/internals/`, all full-suite (`mvn clean install`, JS unit +
integration) green — produced by `glv-correctness-funnel.workflow.js` (`args: { glv: "javascript" }`).
The funnel produces this set **fresh each run — it is non-deterministic, do not assume a fixed set.**

| Branch (`auto/cand-javascript-…`) | File(s) under `binary/internals/` | Risk | Breaks contract | Optimization |
|---|---|---|---|---|
| `readstring-direct-tostring` | `StreamReader.js`, `StringSerializer.js` | safe | no | decode strings via direct `Buffer.toString` (skip an intermediate copy) |
| `any-combined-header-read` | `AnySerializer.js` | safe | no | read the AnySerializer type header as a single 2-byte fetch |
| `sync-streamreader-primitives` | `StreamReader.js` | medium | no | synchronous read primitives on the buffered `StreamReader` (avoid per-read await) |
| `flat-dispatch-table` | `AnySerializer.js` | medium | no | dispatch `AnySerializer.deserialize` through a type→serializer table |
| `sync-buffered-decoder` | `AnySerializer.js`, `ArraySerializer.js`, `GraphBinaryReader.js`, `IntSerializer.js`, `LongSerializer.js`, `MarkerSerializer.js`, `StreamReader.js`, `StringSerializer.js`, `VertexPropertySerializer.js`, `VertexSerializer.js` | high-ceiling | **yes — public-api** | a whole synchronous buffered decode lane across the reader + serializers |

> **The one contract-breaker — benchmark it FIRST, judge it separately.**
> `sync-buffered-decoder` is the `breaksContract` bucket of this run (`high-ceiling`, **public-api**):
> it changes exported serializer signatures / the decode entry shape across ten files. It is
> full-suite green, but merging it is a **major-version judgment call**. The whole point of measuring
> it is to learn whether the wide blast radius buys a win large enough to justify the API churn — so
> benchmark it, but keep it out of any "safe to merge now" conclusion. The other four are
> contract-clean.

> **A 6th branch may be on the box.** A local/funnel artifact branch
> `auto/cand-javascript-prealloc-array-result` (pre-size the array in `ArraySerializer`'s non-bulked
> path) exists from the same family but is **not** in the 5-branch result table above. If you want it
> measured, add it to `CANDIDATE_BRANCHES` as a 6th arm — it forks from the same `5e7c118826` and is
> a single `ArraySerializer.js` commit. Otherwise ignore it.

All arms are pushed to the fork `git@github.com:kirill-stepanishin/tinkerpop.git`.

> **Remote naming on the benchmarking EC2s.** On the pre-provisioned benchmarking boxes the repo
> lives at **`~/tinkerpop-4`** and the fork is the **`fork`** remote (`origin` points at upstream
> `apache/tinkerpop`, over HTTPS). Every `git` command below uses `fork`/`~/tinkerpop-4`
> accordingly — if you stand up a fresh box where the fork is `origin`, translate back.

> **Why EC2 and not localhost.** Per `bench/README.md`, a `--host localhost` run is *plumbing
> verification only* (`--label smoke`) — client and server contend for the same CPU and there is no
> WAN latency, so it is **never** valid measurement data. Real numbers require EC2 with the
> cross-region pair (Setup B) or a quiet dedicated client (Setup A, `--label candidate-eval`).

---

## 0. Mental model

Deserialization is a **client-CPU** cost. The signal is strongest where the result set is large
(more bytes to decode), so the harness's **medium** point `g.V().repeat(both()).times(12)` is the
primary test. On the Modern graph it returns ~**200,766** objects at **~seconds/req** cross-region,
so network RTT is a negligible fraction of the wall clock and **client-side deserialization
dominates total latency**. The **tiny** point `g.V()` (6 vertices) is a fixed-overhead guard that
**must not regress**.

> **JS is single-threaded — no worker blind spot.** Unlike Go/.NET/Java (where decode runs off the
> main thread), gremlin-javascript decodes on the one event-loop thread, so the wall-clock latency
> and any CPU profile attribute cleanly to the deser path with no cross-thread accounting.

Two signals per candidate — one primary, one optional cross-check:

1. **Unprofiled medium wall-clock latency (median)** *(the primary decision metric)* — the harness
   records one row per cell to `ledger.csv`; read the **`median`** column (sec/req) from the
   **medium** point run **unprofiled**. Because deser dominates this query, a real client-CPU win
   shows up directly here. This is the realistic headline number.
2. **Node `--cpu-prof` (V8 sampler) self-time profile** *(optional, secondary cross-check)* — collect
   a `.cpuprofile` while the medium cell runs, open it in https://speedscope.app, and sum the
   **self** time of the frames under `binary/internals/`. A **total self-time drop ≥ 5%** vs the
   baseline arm is a deterministic, **network-independent** confirmation that a win lands in the deser
   hot path — useful for *attribution*, **not the sole gate**. Run it only if you want that
   cross-check.

**Hard validity gates (any failure voids the arm):** the medium **result count must equal the
baseline count** on every arm (record it once from the baseline arm — it is graph/traversal
specific), and **`status=ok` and `errors=0`** on every row.

> **Never read latency from a profiled cell.** `--cpu-prof` inflates the profiled medium cell, so its
> `median` is not a wall-clock number. Run **medium unprofiled** for the latency signal; if you also
> want CPU attribution, run it as a **separate single pass**, not the same cell.

> Run baseline and each candidate **back-to-back in the same session** and compare the *relative*
> delta. Never quote raw EC2 ms as an absolute latency figure.

---

## 1. Infrastructure

Only the **client EC2** is special for this work (deser is client-side). Two valid setups:

| Setup | Server | Client | When |
|---|---|---|---|
| **A — single instance** (simplest) | localhost on the client box | same box | fastest to stand up; valid here because we only compare *candidates to each other*, all sharing one server + network so they cancel, and the optional CPU cross-check is network-independent |
| **B — cross-region** (matches prior runs) | `m7a.8xlarge`, US-EAST-2 | `m7a.4xlarge` (16 vCPU), US-WEST-2 | if you also want wall-clock numbers comparable to the `control` rows in `results.csv` / `javascript-benchmarking-plan.md` |

> **The provisioned benchmarking pair (Setup B) — concrete values.** The same two EC2s used for all
> prior per-language runs (`python-/go-/dotnet-/javascript-benchmarking-plan.md`) are reused here:
> - **Server:** `m7a.8xlarge`, US-EAST-2, IP **`16.59.222.63`** → on the client set `HOST=16.59.222.63`.
> - **Client:** `m7a.4xlarge` (16 vCPU), US-WEST-2 — where Node, the harness, and this doc run.
> - Security group already allows TCP **8182** from the client to the server (prior runs used it).
>
> If the instances are ever re-created the IP changes, so re-confirm with `ec2-metadata`/`hostname
> -I` on the server box.

> **`--label` discipline.** `bench/README.md` reserves `--label smoke` for localhost plumbing checks
> and `--label control` for the two-EC2 cross-region setup. A quiet dedicated EC2 that isn't the
> canonical cross-region control is a third case: **tag those runs `--label candidate-eval`** so
> they're never mistaken for either a laptop `smoke` row or a cross-region `control` row.

**Security group:** Setup A needs no inbound port (server is localhost). Setup B needs TCP **8182**
open from the client SG to the server SG.

---

## 2. One-time client setup

> **On the pre-provisioned benchmarking client, most of this is already done** — the repo is at
> `~/tinkerpop-4`, the candidate branches are reachable on the `fork` remote, and Node is installed.
> Don't blindly re-run; **inventory first** and fill only the gaps:
>
> ```bash
> git -C ~/tinkerpop-4 remote -v && git -C ~/tinkerpop-4 branch   # fork remote? which branches local?
> node --version && npm --version                                 # Node present? (need >= 18)
> bench --help 2>&1 | head -1 || echo "bench not installed"       # harness on PATH?
> ```

```bash
# --- system deps (fresh box; Amazon Linux 2023) ---
sudo dnf install -y git nodejs npm java-17-amazon-corretto-devel maven
node --version            # need Node >= 18 (tsconfig extends @tsconfig/node18)

# --- clone the fork and the candidate branches (fresh box) ---
# On the provisioned box the repo is ALREADY at ~/tinkerpop-4 with the fork as the `fork` remote;
# there you only run the fetch + branch-track loop below (substitute fork/ for origin/).
git clone git@github.com:kirill-stepanishin/tinkerpop.git ~/tinkerpop
cd ~/tinkerpop
git fetch origin
# create the baseline branch from the immutable fork point if it isn't already pushed:
git branch bench-baseline-javascript 5e7c118826 2>/dev/null || true
# baseline first, then the 5 candidate arms (auto/cand-javascript-<id>):
for b in auto/cand-javascript-readstring-direct-tostring \
         auto/cand-javascript-any-combined-header-read \
         auto/cand-javascript-sync-streamreader-primitives \
         auto/cand-javascript-flat-dispatch-table \
         auto/cand-javascript-sync-buffered-decoder ; do
  git branch --track "$b" "origin/$b" 2>/dev/null || true   # provisioned box: "fork/$b"
done
git checkout bench-baseline-javascript
git log --oneline -1           # confirm baseline = 5e7c118826

# --- the bench harness (run-only; PyYAML its only dep) ---
pip3.11 install --user -e ~/tinkerpop/bench    # or `pip install -e bench` inside a venv
bench --help | head -1                          # expect: usage: bench ...

chmod +x ~/tinkerpop/gremlin-js/gremlin-javascript/src/main/bin/profile-driver.sh

# --- install JS deps ONCE (node_modules is branch-independent for these candidates) ---
cd ~/tinkerpop/gremlin-js/gremlin-javascript
npm ci          # or `npm install` if there is no package-lock; pulls antlr4ng, duel, buffer, etc.
```

> **Critical — the rebuild mechanism for JS (NOT a no-op like python).** The launcher
> `gremlin-js/gremlin-javascript/src/main/bin/profile-driver.sh` runs
> `lib/driver/util/profiling-application.mjs`, and that file imports the driver from
> **`build/esm/index.js`** — the **compiled** output — *not* from the `lib/.../internals/*.js` files
> the candidates edit. So a bare `git checkout` changes `lib/` but the running process still loads the
> **stale `build/`**, making every arm look identical to baseline. After each checkout you **must**
> `npm run build` so the changed deserializer is recompiled into `build/`. This is the `REBUILD_CMD`
> from the template, instantiated for JS:
> `(cd $REPO/gremlin-js/gremlin-javascript && npm run build)`.

> **`npm run build` runs `prebuild` first** (`patch-antlr4ng.js` + antlr grammar `generate`), then
> `rm -rf build && duel --dirs` (the dual ESM/CJS TypeScript build via `@knighted/duel`). The grammar
> generate needs `antlr-ng` (pulled by `npm ci`). It takes tens of seconds, not minutes. If it ever
> fails on a fresh box, run `npm run generate` once by hand to surface the antlr error before the
> sweep.

### Build & start the server

> **Use the `gremlin-server-modern.yaml` config — not the default.** The latency tests traverse the
> **Modern graph**, which only the `*-modern.yaml` config preloads; the default
> `gremlin-server.yaml` serves an empty graph and `g.V()` returns nothing. (On the provisioned server
> the 4.0 build is **already compiled** under
> `~/tinkerpop-4/gremlin-server/target/...-standalone` — check before spending minutes on `mvn`.)

> **Watch for a leftover wrong-version server on 8182.** These boxes are reused across 3.7 and 4.0
> runs; a stale **3.7** server may still be bound to 8182. A 3.7 server does **not** speak GraphBinary
> **V4**, so the 4.x driver comparison would be invalid. Always check first and stop it:
> ```bash
> pgrep -af gremlin-server          # inspect the cmdline — note 3.7.x vs 4.0.0 in the path
> ss -ltn | grep 8182               # is something already listening?
> kill <pid> ; sleep 3 ; ss -ltn | grep 8182 || echo "port 8182 free"
> ```

**Setup A (localhost) / Setup B (server EC2) — build if needed, then start with the modern config:**

```bash
cd ~/tinkerpop-4
ls gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone 2>/dev/null \
  || mvn clean install -pl gremlin-server -am -DskipTests -Dasciidoc.skip=true
cd gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone
ulimit -n 65536 2>/dev/null || true
export JAVA_OPTIONS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
sed -i 's/^evaluationTimeout: .*/evaluationTimeout: 30000000/' conf/gremlin-server-modern.yaml
# Setup B only — open to the network so the US-WEST-2 client can connect:
sed -i 's/^host: localhost/host: 0.0.0.0/' conf/gremlin-server-modern.yaml
bin/gremlin-server.sh conf/gremlin-server-modern.yaml   # wait for: Channel started at port 8182
```
Leave the server running in its own `tmux`/`screen` pane for the whole session. See
`bench/BENCHMARKING.md` "Server setup & tuning" for full server tuning.

### Confirm the harness resolves the javascript launcher (no server needed)

```bash
cd ~/tinkerpop-4/bench
bench run --glv javascript --test protocol-overhead --size medium --dry-run
# expect the resolved launcher path
#   gremlin-js/gremlin-javascript/src/main/bin/profile-driver.sh
# + the exact argv. An unbuilt GLV (no build/ dir) fails at run time, not dry-run, so still do the
# first real connectivity cell below before the sweep.
```

---

## 3. Load the graph and verify connectivity

The latency tests traverse the **Modern graph**; it must be loaded once per server restart
(otherwise `g.V()` returns nothing). A one-shot tiny run both warms and proves the plumbing — **but
build first**, because the profiling app runs the compiled `build/`:

```bash
cd ~/tinkerpop-4/gremlin-js/gremlin-javascript && npm run build   # compile baseline into build/
cd ~/tinkerpop-4/bench
HOST=16.59.222.63       # Setup B server IP; use localhost for Setup A

bench run --glv javascript --test protocol-overhead --size tiny \
  --host $HOST --label candidate-eval --executions 1 --warmups 1 \
  --output-dir ~/cand-results/javascript/_connectivity
cat ~/cand-results/javascript/_connectivity/ledger.csv
```

A row with `status=ok`, a non-empty `median`, and **result count 6** (Modern graph loaded) means
you're ready. Connection refused → server down (A) or SG / `host: 0.0.0.0` (B). `count != 6` → wrong
server config.

> **Run this connectivity cell FIRST — it catches launcher/Node/build drift before you burn a full
> sweep.** A launcher/Node/build mismatch fails *identically on every arm* (same baseline + a one-line
> change), so it looks like a universal benchmark failure rather than a bug. If a cell fails with **"no
> RESULT_JSON line found in stdout"**, don't guess — read that cell's log under
> `<output-dir>/logs/` for the real Node stack trace (a common cause is a missing `build/` →
> `Cannot find module '.../build/esm/index.js'`, i.e. you skipped `npm run build`).

---

## 4. The benchmark loop (the core of this doc)

Sweep **baseline first, then each candidate**, capturing the **unprofiled medium wall-clock latency**
(via the ledger — the primary signal) and, optionally, a separate `--cpu-prof` CPU pass per arm. Do
**3 full sweeps** (whole baseline→candidates cycle) so you have medians of medians, not single noisy
samples. Each arm writes to its own `--output-dir` so the per-branch ledgers stay separate.

### 4a. One-time scaffolding

```bash
cd ~/tinkerpop-4/bench
HOST=16.59.222.63          # Setup B server IP; localhost for Setup A
REPO=~/tinkerpop-4
JS=~/tinkerpop-4/gremlin-js/gremlin-javascript
RESULTS=~/cand-results/javascript     # namespaced by GLV so a JS run never collides with python/go/dotnet
mkdir -p "$RESULTS"

# branch list: baseline MUST be first
BRANCHES=(
  bench-baseline-javascript
  auto/cand-javascript-readstring-direct-tostring
  auto/cand-javascript-any-combined-header-read
  auto/cand-javascript-sync-streamreader-primitives
  auto/cand-javascript-flat-dispatch-table
  auto/cand-javascript-sync-buffered-decoder
)
```

### 4b. Per-arm function (note the per-language REBUILD step)

```bash
run_arm () {
  local branch="$1" sweep="$2"
  local tag="${branch##*/}"                 # e.g. cand-javascript-flat-dispatch-table or bench-baseline-javascript
  local out="$RESULTS/$tag"
  mkdir -p "$out"

  echo "===== sweep $sweep :: $branch ====="
  git -C "$REPO" checkout "$branch" 2>/dev/null      # 1. switch to the arm's source (a binary/internals file)
  git -C "$REPO" log --oneline -1                    #    record exactly what we run

  # 2. REBUILD — JS profiling app loads the COMPILED build/, so the changed deserializer must be
  #    recompiled (NOT a no-op). Surfaces compile errors before the cell runs.
  ( cd "$JS" && npm run build >/dev/null )

  # --- MEDIUM, UNPROFILED (the PRIMARY signal: wall-clock median) ---
  bench run --glv javascript --test protocol-overhead --size medium \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  # --- MEDIUM, with --cpu-prof V8 profile (OPTIONAL attribution cross-check; SEPARATE pass) ---
  # Skip entirely if you don't need CPU attribution. NEVER read latency from this cell — the profile
  # inflates it. See §5b for collecting/reading the .cpuprofile. The launcher honors NODE_OPTIONS,
  # which is the clean injection point for V8 flags (you cannot pass flags through $NODE because the
  # launcher `exec`s it as the binary).

  # --- TINY, fixed-overhead guard (unprofiled) ---
  bench run --glv javascript --test protocol-overhead --size tiny \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  sleep 30      # cool-down between arms
}
```

Notes:
- **Latency comes from the UNPROFILED medium pass; never from a profiled cell.** Always run one arm
  first (`run_arm bench-baseline-javascript 1`) and confirm the unprofiled medium row lands before
  committing to the full loop.
- The explicit `npm run build` after each checkout is the load-bearing JS difference from the python
  doc (where the rebuild is a no-op). If it fails, the arm is invalid — fix or drop it before
  benchmarking.
- All rows for an arm **append** to that arm's `ledger.csv` — re-running never overwrites.

### 4c. Run the sweeps

```bash
for sweep in 1 2 3; do
  for b in "${BRANCHES[@]}"; do
    run_arm "$b" "$sweep"
  done
done 2>&1 | tee "$RESULTS/sweep-run.log"   # log it so you can detach and inspect later
git -C "$REPO" checkout bench-baseline-javascript   # leave the tree on baseline when done
```

> **Time budget.** Unprofiled medium ≈ a couple min/cell; the full **3-sweep × 6-arm** medium+tiny
> loop is well under a couple hours. Run under `tmux`/`screen`, kick it off, detach (`Ctrl-b d`),
> reattach with `tmux attach`. **Never run two arms at once** — concurrent client CPU contention
> corrupts the comparison.

---

## 5. Read the results

### 5·0. Publish to S3, then analyze in the notebook (preferred)

The reproducible path is **`bench/auto/candidate-analysis.ipynb`** (pandas + plotly): it pulls every
arm's `ledger.csv` from S3 and computes the **unprofiled medium-latency delta** (primary), the
validity guards (count match, `status=ok`/`errors=0`), charts, and a PASS/FAIL verdict. From the EC2
client, publish the results once the sweep is done:

```bash
aws s3 sync "$RESULTS" "s3://kirill-tp-benchmarks/cand-results/javascript/" \
  --exclude "*.cpuprofile"      # V8 profiles are large + not needed by the notebook's ledger logic
```

Then open `candidate-analysis.ipynb` anywhere with AWS creds for the bucket and set its parameters
cell:

```python
GLV                  = 'javascript'
BUCKET               = 'kirill-tp-benchmarks'
PREFIX               = f'cand-results/{GLV}'          # -> cand-results/javascript
BASELINE             = 'bench-baseline-javascript'    # the baseline arm's directory tag
ARM_INCLUDE_PREFIXES = ('cand-javascript-',)          # funnel naming: auto/cand-javascript-<id>
```

Then **Run All**. It reproduces §5a–§5c deterministically (the notebook's optional CPU-gate parser is
tuned for the python yappi `tsub` table — for the JS `.cpuprofile` layout, do the CPU cross-check in
§5b by hand in speedscope; the ledger-based wall-clock + guard logic is GLV-independent and works
as-is). The raw shell that follows is the no-Jupyter fallback / cross-check.

### 5a. Unprofiled medium wall-clock median — the primary decision metric

```bash
for d in "$RESULTS"/*/; do
  [ -f "$d/ledger.csv" ] || continue
  echo "== $(basename "$d") =="
  awk -F, 'NR==1{for(i=1;i<=NF;i++)h[$i]=i; next}
           $h["point_value"]=="medium"{printf "  medium median=%s status=%s errors=%s\n",$h["median"],$h["status"],$h["errors"]}' \
      "$d/ledger.csv"
done
```

Take the **median across the 3 sweeps** per branch. A candidate is a win if its medium median beats
`bench-baseline-javascript` (subject to the §5c validity gates).

### 5b. `--cpu-prof` V8 profile — optional, network-independent cross-check (not the gate)

The **primary metric is §5a**; this is an *optional* attribution cross-check. Collect a V8 CPU profile
while a single medium pass runs, then sum the **self** time of the `binary/internals/` frames and
compare to baseline — a **total self-time drop ≥ 5%** confirms the win lands in the deser hot path
rather than being noise. The launcher honors `NODE_OPTIONS`, the clean way to pass V8 flags:

```bash
tag=$(git -C "$REPO" rev-parse --abbrev-ref HEAD); tag="${tag##*/}"
# Run on the checked-out + freshly-built arm. --cpu-prof writes a .cpuprofile when the process exits.
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=$RESULTS/$tag --cpu-prof-name=medium-s1.cpuprofile" \
  "$REPO/gremlin-js/gremlin-javascript/src/main/bin/profile-driver.sh" \
    --test-type latency --host "$HOST" \
    --script 'g.V().repeat(both()).times(12)' --warmups 1 --executions 3 --timeout 600000
```

Read the trace: open `medium-s1.cpuprofile` in https://speedscope.app (or Chrome DevTools →
Performance → Load profile), switch to the **"Sandwich"** view, and sum the **self** time of frames
whose file is under `lib/structure/io/binary/internals/` (e.g. `StreamReader`, `AnySerializer`,
`StringSerializer`). Compare baseline vs candidate, and confirm the drop lands in the **file(s) the
candidate touched**, not noise elsewhere. A win should reproduce across all 3 sweeps.

> Alternative without speedscope: run with `NODE_OPTIONS="--prof"` and post-process the resulting
> `isolate-*.log` with `node --prof-process isolate-*.log > prof.txt`, then read the "Summary" /
> "Bottom up (heavy) profile" sections. `--cpu-prof` + speedscope is the friendlier path.

### 5c. Sanity gates (hard validity gates — any failure invalidates the arm)

- **Result count must match the baseline count** for every arm (check each cell's log under
  `<output-dir>/logs/`); a different count means the candidate changed behavior → comparison void.
  Record the baseline medium count once and require every arm to match it.
- **`status=ok` and `errors=0`** for every row.
- **Warmup must pass** — a `median` of 0/empty + `error_reason` means the warmup gate aborted;
  re-run.

---

## 6. Decide & record

```
GLV: javascript   Baseline branch (immutable fork point): bench-baseline-javascript = 5e7c118826
Medium result count (every arm must match): <record once from baseline arm — expect ~200766>
Server: 16.59.222.63 (m7a.8xlarge, US-EAST-2)  Client: m7a.4xlarge, US-WEST-2  Node: >= 18

| Arm                                            | medium med (s, UNPROFILED) | tiny med (s) | internals self drop % (optional) | medium count | risk / contract |
|------------------------------------------------|----------------------------|--------------|----------------------------------|--------------|-----------------|
| bench-baseline-javascript                      | (reference)                |              | —                                | <N>          | —               |
| cand-javascript-readstring-direct-tostring     |                            |              |                                  | (must = N)   | safe / clean    |
| cand-javascript-any-combined-header-read       |                            |              |                                  | (must = N)   | safe / clean    |
| cand-javascript-sync-streamreader-primitives   |                            |              |                                  | (must = N)   | medium / clean  |
| cand-javascript-flat-dispatch-table            |                            |              |                                  | (must = N)   | medium / clean  |
| cand-javascript-sync-buffered-decoder          |                            |              |                                  | (must = N)   | high / **public-api** |
```

- **Win** = **unprofiled medium wall-clock median improves** vs `bench-baseline-javascript` (the
  primary signal) **and** tiny regression < 10%, reproduced across all 3 sweeps — subject to the
  **hard validity gates**: medium **count matches** the baseline count for every arm, and
  `status=ok`/`errors=0` on every row. If a gate fails the arm is void regardless of latency.
- *Optional cross-check:* a `--cpu-prof` self-time drop ≥ 5% in the same `binary/internals/` file
  **confirms attribution** but is **not required** to call a win.
- **`sync-buffered-decoder` is the one contract-breaker (public-api).** Even if it wins, merging it is
  a **major-version judgment call**, not a "merge now" — keep it in its own bucket. The other four are
  contract-clean and mergeable on their own merit.
- Each candidate is a clean single commit on `bench-baseline-javascript` — a winner merges with
  `git merge --no-ff auto/cand-javascript-<id>`. Merge **one at a time** and re-bench; several touch
  the same hot path (`readstring-direct-tostring` and `sync-streamreader-primitives` both touch
  `StreamReader.js`; `any-combined-header-read`, `flat-dispatch-table`, and `sync-buffered-decoder`
  all touch `AnySerializer.js`) so they may be **substitutes, not additive** — and
  `sync-buffered-decoder` overlaps almost everything.

---

## 7. Optional: throughput context

```bash
bench run --glv javascript --test scaling-curve --host "$HOST" --label candidate-eval \
  --concurrency 64 --concurrency 128 --output-dir "$RESULTS/<tag>"
```
A client-side deser micro-opt rarely moves throughput much (and JS plateaus early — see `RESULTS.md`,
the 4.0 JS scaling curve falls past its knee); **unprofiled medium latency (with the optional
`--cpu-prof` cross-check for attribution) is the signal that matters here.**

---

## 8. Teardown

```bash
git -C ~/tinkerpop-4 checkout bench-baseline-javascript   # tree back on baseline
( cd ~/tinkerpop-4/gremlin-js/gremlin-javascript && npm run build )   # leave build/ matching baseline
# stop the server: Ctrl+C in its console (Setup A) or on the server EC2 (Setup B)
# leave the EC2 instances running if other GLV benchmarks will reuse them (this pair is shared);
# otherwise stop/terminate once results are collected
```

---

## 9. Cheat sheet

```bash
# PROVISIONED BOX (Setup B): repo already at ~/tinkerpop-4, fork = `fork` remote, server = 16.59.222.63
cd ~/tinkerpop-4 && git fetch fork
git branch bench-baseline-javascript 5e7c118826 2>/dev/null || true
for b in auto/cand-javascript-readstring-direct-tostring \
         auto/cand-javascript-any-combined-header-read \
         auto/cand-javascript-sync-streamreader-primitives \
         auto/cand-javascript-flat-dispatch-table \
         auto/cand-javascript-sync-buffered-decoder ; do
  git branch --track "$b" "fork/$b" 2>/dev/null || true; done
pip3.11 install --user -e ~/tinkerpop-4/bench
( cd ~/tinkerpop-4/gremlin-js/gremlin-javascript && npm ci )     # deps once
# server box (16.59.222.63): kill any stale 3.7 server on 8182, then start 4.0 with MODERN config:
#   bin/gremlin-server.sh conf/gremlin-server-modern.yaml   (host: 0.0.0.0 already set)
# verify connectivity from client (§3): npm run build, then tiny cell must return result count 6, status=ok

# FRESH BOX (Setup A): clone fork as origin, nodejs/npm + maven, mvn build server — see §2

# sweep (baseline first), MEDIUM+TINY, UNPROFILED — see §4 for run_arm (NOTE: npm run build per arm)
for s in 1 2 3; do for b in "${BRANCHES[@]}"; do run_arm "$b" "$s"; done; done

# read
# primary (decides winners): unprofiled medium wall-clock median vs bench-baseline-javascript (§5a)
# hard gates: medium count matches baseline + status=ok/errors=0 (§5c)
# optional cross-check: --cpu-prof binary/internals self-time drop >=5% confirms attribution (§5b)
```

---

## See also

- `EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — the language-agnostic template this file instantiates.
- `EC2-BENCHMARK-CANDIDATES.md` — the gremlin-python worked instance.
- `EC2-BENCHMARK-CANDIDATES-DOTNET.md` — the gremlin-dotnet worked instance (closest sibling: same
  fork point `5e7c118826`, same "compiled GLV needs a rebuild per arm" pattern).
- `bench/README.md` — the harness: `bench run` usage, the append-only ledger, `--label` discipline,
  and the local-vs-EC2 warning this doc follows.
- `bench/SCHEMA.md` — the `RESULT_JSON:` contract behind every ledger row.
- `bench/matrix.yaml` — the test definitions; `protocol-overhead` medium = `times(12)`, tiny = `g.V()`.
- `javascript-benchmarking-plan.md` (external `~/dev/tp benchmarking/`) — full two-EC2 cross-region
  setup and the `control` reference numbers in `results.csv`, plus the Node/build recipe.
- `bench/auto/candidate-analysis.ipynb` — the reproducible pandas/plotly notebook that reads the
  S3-published results and renders the latency delta, guards, charts, and PASS/FAIL verdict (§5·0).
  Set `GLV='javascript'`, `BASELINE='bench-baseline-javascript'`, `ARM_INCLUDE_PREFIXES=('cand-javascript-',)`.
- `bench/auto/RUNBOOK.md` — `glv-correctness-funnel.workflow.js`, the autonomous funnel that proposed
  these candidate branches (it stops at `mvn clean install`; you benchmark the arms afterward with
  this doc).
