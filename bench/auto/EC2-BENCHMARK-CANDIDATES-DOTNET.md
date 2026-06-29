<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file. Apache License 2.0.
-->

# Benchmarking the gremlin-dotnet GraphBinary-deser Candidates on EC2

Step-by-step guide to measure the proposed **gremlin-dotnet** GraphBinary V4 deserialization
optimizations on EC2, **head-to-head against the pinned `bench-baseline-dotnet` baseline**, using
the `bench` harness (`bench/README.md`) so the runs land in the same append-only ledger format as
all prior TinkerPop benchmarking — with deterministic numbers you can trust (unlike noisy,
contended localhost).

> **This is the fully worked, instantiated example** of the language-agnostic template
> `EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — gremlin-dotnet, the current GraphBinary-deser candidate
> set. Read the two side-by-side: this file fills in every template placeholder with real branches,
> files, and the .NET-specific build/profile steps.

## What we are measuring

Each candidate is a single-commit, **dotnet-only** change. Every one touches the GraphBinary V4
deserialization hot path under
`gremlin-dotnet/src/Gremlin.Net/Structure/IO/GraphBinary4/` — the type serializers
(`Types/*Serializer.cs`), `StreamExtensions.cs`, `DataType.cs`, `GraphBinaryReader.cs`, or
`TypeSerializerRegistry.cs`. No test files are touched. The server is identical for every arm;
**only the client-side .NET deserializer changes**, so this is a clean apples-to-apples comparison.

### Baseline (pinned to an immutable fork-point SHA)

The candidates were cut from the gremlin-dotnet deser-optimization **fork point on branch
`4-glv-profiling`**. **`4-glv-profiling` is a MOVING branch** — its tip advances as funnel-infra
commits land — so the baseline is pinned to the immutable fork-point SHA **`5e7c118826`**, never
the branch tip. A moving tip would silently mix extra commits into the comparison.

For this run the baseline branch **`bench-baseline-dotnet`** = `5e7c118826` exactly — **no extra
commit needed**. Unlike the gremlin-python run (which required an aiohttp profiling-app fix on top
of its fork point), the **dotnet profiling app needs no fix**: it builds and runs unchanged on the
provisioned box. So:

- **Baseline arm** = `bench-baseline-dotnet` (= `5e7c118826`).
- **Each candidate arm** = `bench-baseline-dotnet` + exactly one deser commit (the `auto/cand-dotnet-<id>`
  branch as the funnel produced it — no cherry-pick / `-fixed` scheme required, because there is no
  baseline fix to carry).

### The candidate set (9 branches — all contract-clean)

The current set is **9 gremlin-dotnet candidates**, each ONE commit on `5e7c118826`, each touching
files only within `GraphBinary4/`, all full-suite (`mvn clean install`) green — produced by
`glv-correctness-funnel.workflow.js` (run `wf_f0a23056-2eb`, 2026-06-17). **All 9 landed in the
`passed` bucket; the `breaks-contract` bucket was empty** — so unlike the python run there is no
"surface separately" group. The funnel produces this set **fresh each run — it is
non-deterministic, do not assume a fixed set.**

| Branch (`auto/cand-dotnet-…`) | File(s) under `GraphBinary4/` | Optimization |
|---|---|---|
| `uuid-single-read-span` | `Types/UuidSerializer.cs` | one 16-byte span read vs 16 awaited `ReadByteAsync` |
| `string-pooled-scratch-and-readexactly` | `Types/StringSerializer.cs` | stackalloc/`ArrayPool` scratch + `ReadExactly` |
| `binary-readexactly-correctness` | `Types/BinarySerializer.cs` | `ReadAsync`→`ReadExactlyAsync` (also a latent short-read fix) |
| `datatype-intern-singletons` | `DataType.cs` | intern `DataType` singletons in `FromTypeCode` (kills per-element heap `DataType`) |
| `char-stackalloc-span` | `Types/CharSerializer.cs` | stackalloc UTF-8 buf + single continuation read |
| `biginteger-bigendian-span-ctor` | `Types/BigIntegerSerializer.cs` | big-endian span ctor, drops `.Reverse().ToArray()` |
| `stackalloc-fixedwidth-primitives` | `StreamExtensions.cs` | stackalloc/`Span` for int/long/float/double/short reads |
| `valuetask-sync-completion-primitives` | `StreamExtensions.cs` | sync-completed `ValueTask` from buffered primitive reads |
| `registry-bytecode-jumptable` | `GraphBinaryReader.cs`, `TypeSerializerRegistry.cs` | 256-entry serializer jump table by type-code byte |

> **One caveat to surface even though all 9 are contract-clean.** `datatype-intern-singletons`
> changes the **reference identity** of well-known `DataType` instances (they become interned
> singletons). It is value-equivalent and the full suite is green, but if you ever merge it, note
> that any code relying on `DataType` reference identity (there is none in-tree) would be affected.

All arms are pushed to the fork `git@github.com:kirill-stepanishin/tinkerpop.git`.

> **Remote naming on the benchmarking EC2s.** On the pre-provisioned benchmarking boxes the repo
> lives at **`~/tinkerpop-4`** and the fork is the **`fork`** remote (`origin` points at upstream
> `apache/tinkerpop`, over HTTPS). Every `git` command below uses `fork`/`~/tinkerpop-4`
> accordingly — if you stand up a fresh box where the fork is `origin`, translate back.

> **No profiling-app fix to carry (unlike python).** The python run had to patch an
> `aiohttp`-incompatible `request_serializer=` kwarg in its profiling app and carry that fix on
> every arm. The **dotnet profiling app (`Gremlin.Net.Profiling/Program.cs`) has no such issue** —
> the baseline is the bare fork-point SHA and each candidate is just that SHA + one deser commit.

> **Why EC2 and not localhost.** Per `bench/README.md`, a `--host localhost` run is *plumbing
> verification only* (`--label smoke`) — client and server contend for the same CPU and there is no
> WAN latency, so it is **never** valid measurement data. Real numbers require EC2 with the
> cross-region pair (Setup B) or a quiet dedicated client (Setup A, `--label candidate-eval`).

---

## 0. Mental model

Deserialization is a **client-CPU** cost. The signal is strongest where the result set is large
(more bytes to decode), so the harness's **medium** point `g.V().repeat(both()).times(12)` is the
primary test. On the Modern graph it returns a large object count at **~seconds/req** cross-region,
so network RTT is a negligible fraction of the wall clock and **client-side deserialization
dominates total latency**. The **tiny** point `g.V()` (6 vertices) is a fixed-overhead guard that
**must not regress**.

Two signals per candidate — one primary, one optional cross-check:

1. **Unprofiled medium wall-clock latency (median)** *(the primary decision metric)* — the harness
   records one row per cell to `ledger.csv`; read the **`median`** column (sec/req) from the
   **medium** point run **unprofiled**. Because deser dominates this query, a real client-CPU win
   shows up directly here. This is the realistic headline number.
2. **`dotnet-trace` CPU self-time profile** *(optional, secondary cross-check)* — collect an
   EventPipe `.nettrace` while the medium cell runs, open it, and sum the **self/exclusive** time of
   the `GraphBinary4` frames. A **total self-time drop ≥ 5%** vs the baseline arm is a deterministic,
   **network-independent** confirmation that a win lands in the deser hot path — useful for
   *attribution*, **not the sole gate**. Run it only if you want that cross-check.

**Hard validity gates (any failure voids the arm):** the medium **result count must equal the
baseline count** on every arm (record it once from the baseline arm — it is graph/traversal
specific), and **`status=ok` and `errors=0`** on every row.

> **Never read latency from a profiled cell.** `dotnet-trace` inflates the profiled medium cell, so
> its `median` is not a wall-clock number. Run **medium unprofiled** for the latency signal; if you
> also want CPU attribution, run it as a **separate single pass**, not the same cell.

> Run baseline and each candidate **back-to-back in the same session** and compare the *relative*
> delta. Never quote raw EC2 ms as an absolute latency figure.

---

## 1. Infrastructure

Only the **client EC2** is special for this work (deser is client-side). Two valid setups:

| Setup | Server | Client | When |
|---|---|---|---|
| **A — single instance** (simplest) | localhost on the client box | same box | fastest to stand up; valid here because we only compare *candidates to each other*, all sharing one server + network so they cancel, and the optional CPU cross-check is network-independent |
| **B — cross-region** (matches prior runs) | `m7a.8xlarge`, US-EAST-2 | `m7a.4xlarge` (16 vCPU), US-WEST-2 | if you also want wall-clock numbers comparable to the `control` rows in `results.csv` / `dotnet-benchmarking-plan.md` |

> **The provisioned benchmarking pair (Setup B) — concrete values.** The same two EC2s used for all
> prior per-language runs (`python-/go-/dotnet-benchmarking-plan.md`) are reused here:
> - **Server:** `m7a.8xlarge`, US-EAST-2, IP **`16.59.222.63`** → on the client set `HOST=16.59.222.63`.
> - **Client:** `m7a.4xlarge` (16 vCPU), US-WEST-2 — where the .NET driver, harness, and this doc run.
> - Security group already allows TCP **8182** from the client to the server (prior runs used it).
>
> If the instances are ever re-created the IP changes, so re-confirm with `ec2-metadata`/`hostname
> -I` on the server box.

> **Important nuance on `--label`.** `bench/README.md` reserves `--label smoke` for localhost
> plumbing checks and `--label control` for the two-EC2 cross-region setup. A quiet dedicated EC2
> that isn't the canonical cross-region control is a third case: **tag those runs
> `--label candidate-eval`** so they're never mistaken for either a laptop `smoke` row or a
> cross-region `control` row.

**`.NET` fairness env (set by the harness, set it too for ad-hoc runs).** A fair .NET run requires
`DOTNET_GCServer=1` and `DOTNET_ThreadPool_MinThreads=1024`. The harness's dotnet adapter
(`bench/orchestrator/adapters.py::_build_dotnet`) **already injects both per cell**, so a normal
`bench run` is correct without extra setup. Only if you invoke the launcher by hand (outside the
harness) do you need to export them yourself.

**Security group:** Setup A needs no inbound port (server is localhost). Setup B needs TCP **8182**
open from the client SG to the server SG.

---

## 2. One-time client setup

> **On the pre-provisioned benchmarking client, most of this is already done** — the repo is at
> `~/tinkerpop-4`, the candidate branches are reachable on the `fork` remote, and the .NET SDK is
> installed. Don't blindly re-run; **inventory first** and fill only the gaps:
>
> ```bash
> git -C ~/tinkerpop-4 remote -v && git -C ~/tinkerpop-4 branch   # fork remote? which branches local?
> dotnet --info | head -5                                          # SDK present? which version(s)?
> bench --help 2>&1 | head -1 || echo "bench not installed"        # harness on PATH?
> ```

```bash
# --- system deps (fresh box; Amazon Linux 2023) ---
sudo dnf install -y git dotnet-sdk-8.0 java-17-amazon-corretto-devel maven
dotnet --version          # need an 8.0 SDK (the projects target net8.0)

# --- clone the fork and the candidate branches (fresh box) ---
# On the provisioned box the repo is ALREADY at ~/tinkerpop-4 with the fork as the `fork` remote;
# there you only run the fetch + branch-track loop below (substitute fork/ for origin/).
git clone git@github.com:kirill-stepanishin/tinkerpop.git ~/tinkerpop
cd ~/tinkerpop
git fetch origin
# baseline first, then the 9 candidate arms (auto/cand-dotnet-<id>):
for b in bench-baseline-dotnet \
         auto/cand-dotnet-uuid-single-read-span \
         auto/cand-dotnet-string-pooled-scratch-and-readexactly \
         auto/cand-dotnet-binary-readexactly-correctness \
         auto/cand-dotnet-datatype-intern-singletons \
         auto/cand-dotnet-char-stackalloc-span \
         auto/cand-dotnet-biginteger-bigendian-span-ctor \
         auto/cand-dotnet-stackalloc-fixedwidth-primitives \
         auto/cand-dotnet-valuetask-sync-completion-primitives \
         auto/cand-dotnet-registry-bytecode-jumptable ; do
  git branch --track "$b" "origin/$b" 2>/dev/null || true   # provisioned box: "fork/$b"
done
git checkout bench-baseline-dotnet
git log --oneline -1            # confirm baseline = 5e7c118826

# --- the bench harness (run-only; PyYAML its only dep) ---
pip3.11 install --user -e ~/tinkerpop/bench    # or `pip install -e bench` inside a venv
bench --help | head -1                          # expect: usage: bench ...

chmod +x ~/tinkerpop/gremlin-dotnet/src/main/bin/profile-driver.sh
```

> **Critical — the rebuild mechanism for .NET (NOT a no-op like python).** Python's editable
> install loads source live, so a `git checkout` is all it needs. **.NET is compiled**, so after
> switching branches the profiling app must be **rebuilt** so the changed deserializer is compiled
> in. The launcher `gremlin-dotnet/src/main/bin/profile-driver.sh` runs
> `dotnet run --project ../../Gremlin.Net.Profiling -c Release -- "$@"`, and `dotnet run` recompiles
> when sources changed — but to be explicit and to surface compile errors *before* a sweep cell,
> the benchmark loop below runs an explicit `dotnet build -c Release` on the `Gremlin.Net` project
> after each checkout (this is the `REBUILD_CMD` from the template, instantiated for dotnet).

> **Runtime-version gotcha.** The projects target **net8.0**. The provisioned box has the
> **8.0 SDK** installed (above), so `dotnet run`/`dotnet build` resolve net8.0 natively and no
> roll-forward is needed. If you land on a box that ships only a newer runtime (e.g. .NET 10) and
> the test/run **host** refuses to launch with *"You must install or update .NET"*, export
> `DOTNET_ROLL_FORWARD=LatestMajor` for the session. The harness/launcher path is unaffected when an
> 8.0 SDK is present.

### Build & start the server

> **Use the `gremlin-server-modern.yaml` config — not the default.** The latency tests traverse the
> **Modern graph**, which only the `*-modern.yaml` config preloads; the default
> `gremlin-server.yaml` serves an empty graph and `g.V()` returns nothing. (On the provisioned
> server the 4.0 build is **already compiled** under
> `~/tinkerpop-4/gremlin-server/target/...-standalone` — check before spending minutes on `mvn`.)

> **Watch for a leftover wrong-version server on 8182.** These boxes are reused across 3.7 and 4.0
> runs; a stale **3.7** server may still be bound to 8182. A 3.7 server does **not** speak
> GraphBinary **V4**, so the 4.x driver comparison would be invalid. Always check first and stop it:
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

### Confirm the harness resolves the dotnet launcher (no server needed)

```bash
cd ~/tinkerpop-4/bench
bench run --glv dotnet --test protocol-overhead --size medium --dry-run
# expect the resolved launcher path
#   gremlin-dotnet/src/main/bin/profile-driver.sh
# + the exact argv (and DOTNET_GCServer=1 / DOTNET_ThreadPool_MinThreads=1024 in the env).
# An unbuilt GLV shows MISSING → build it (next section's REBUILD step does this per arm).
```

---

## 3. Load the graph and verify connectivity

The latency tests traverse the **Modern graph**; it must be loaded once per server restart
(otherwise `g.V()` returns nothing). A one-shot tiny run both warms and proves the plumbing:

```bash
cd ~/tinkerpop-4/bench
HOST=16.59.222.63       # Setup B server IP; use localhost for Setup A

bench run --glv dotnet --test protocol-overhead --size tiny \
  --host $HOST --label candidate-eval --executions 1 --warmups 1 \
  --output-dir ~/cand-results/dotnet/_connectivity
cat ~/cand-results/dotnet/_connectivity/ledger.csv
```

A row with `status=ok`, a non-empty `median`, and **result count 6** (Modern graph loaded) means
you're ready. Connection refused → server down (A) or SG / `host: 0.0.0.0` (B). `count != 6` →
wrong server config.

> **Run this connectivity cell FIRST — it catches launcher/SDK/runtime drift before you burn a full
> sweep.** A launcher/SDK/runtime mismatch fails *identically on every arm* (same baseline + a
> one-line change), so it looks like a universal benchmark failure rather than a bug. If a cell
> fails with **"no RESULT_JSON line found in stdout"**, don't guess — read that cell's log under
> `<output-dir>/logs/` for the real .NET stack trace (e.g. a build error, or the net8.0 host
> refusing to launch → set `DOTNET_ROLL_FORWARD=LatestMajor`, see §2).

---

## 4. The benchmark loop (the core of this doc)

Sweep **baseline first, then each candidate**, capturing the **unprofiled medium wall-clock
latency** (via the ledger — the primary signal) and, optionally, a separate `dotnet-trace` CPU pass
per arm. Do **3 full sweeps** (whole baseline→candidates cycle) so you have medians of medians, not
single noisy samples. Each arm writes to its own `--output-dir` so the per-branch ledgers stay
separate.

### 4a. One-time scaffolding

```bash
cd ~/tinkerpop-4/bench
HOST=16.59.222.63          # Setup B server IP; localhost for Setup A
REPO=~/tinkerpop-4
RESULTS=~/cand-results/dotnet     # namespaced by GLV so a dotnet run never collides with python/go
mkdir -p "$RESULTS"

# branch list: baseline MUST be first
BRANCHES=(
  bench-baseline-dotnet
  auto/cand-dotnet-uuid-single-read-span
  auto/cand-dotnet-string-pooled-scratch-and-readexactly
  auto/cand-dotnet-binary-readexactly-correctness
  auto/cand-dotnet-datatype-intern-singletons
  auto/cand-dotnet-char-stackalloc-span
  auto/cand-dotnet-biginteger-bigendian-span-ctor
  auto/cand-dotnet-stackalloc-fixedwidth-primitives
  auto/cand-dotnet-valuetask-sync-completion-primitives
  auto/cand-dotnet-registry-bytecode-jumptable
)
```

### 4b. Per-arm function (note the per-language REBUILD step)

```bash
run_arm () {
  local branch="$1" sweep="$2"
  local tag="${branch##*/}"                 # e.g. cand-dotnet-uuid-single-read-span or bench-baseline-dotnet
  local out="$RESULTS/$tag"
  mkdir -p "$out"

  echo "===== sweep $sweep :: $branch ====="
  git -C "$REPO" checkout "$branch" 2>/dev/null      # 1. switch to the arm's source (a GraphBinary4 file)
  git -C "$REPO" log --oneline -1                    #    record exactly what we run

  # 2. REBUILD — .NET is compiled, so the changed deserializer must be recompiled (NOT a no-op).
  #    Surfaces compile errors before the cell runs; `dotnet run` in the launcher would otherwise
  #    rebuild lazily. Build the driver project the profiling app references.
  dotnet build -c Release "$REPO/gremlin-dotnet/src/Gremlin.Net" >/dev/null

  # --- MEDIUM, UNPROFILED (the PRIMARY signal: wall-clock median) ---
  bench run --glv dotnet --test protocol-overhead --size medium \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  # --- MEDIUM, with dotnet-trace CPU profile (OPTIONAL attribution cross-check; SEPARATE pass) ---
  # Skip entirely if you don't need CPU attribution. NEVER read latency from this cell — the trace
  # inflates it. See §5b for collecting/reading the .nettrace. (dotnet-trace attaches to the child
  # `dotnet` process the launcher spawns; the simplest robust approach is the standalone pass in §5b.)

  # --- TINY, fixed-overhead guard (unprofiled) ---
  bench run --glv dotnet --test protocol-overhead --size tiny \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  sleep 30      # cool-down between arms
}
```

Notes:
- **Latency comes from the UNPROFILED medium pass; never from a profiled cell.** Always run one arm
  first (`run_arm bench-baseline-dotnet 1`) and confirm the unprofiled medium row lands before
  committing to the full loop.
- The explicit `dotnet build -c Release` after each checkout is the load-bearing .NET difference
  from the python doc (where the rebuild is a no-op). If it fails, the arm is invalid — fix or drop
  it before benchmarking.
- All rows for an arm **append** to that arm's `ledger.csv` — re-running never overwrites.

### 4c. Run the sweeps

```bash
for sweep in 1 2 3; do
  for b in "${BRANCHES[@]}"; do
    run_arm "$b" "$sweep"
  done
done 2>&1 | tee "$RESULTS/sweep-run.log"   # log it so you can detach and inspect later
git -C "$REPO" checkout bench-baseline-dotnet   # leave the tree on baseline when done
```

> **Time budget.** Unprofiled medium ≈ a couple min/cell; the full **3-sweep × 10-arm** medium+tiny
> loop is well under a couple hours. Run under `tmux`/`screen`, kick it off, detach (`Ctrl-b d`),
> reattach with `tmux attach`. **Never run two arms at once** — concurrent client CPU contention
> corrupts the comparison.

---

## 5. Read the results

### 5·0. Publish to S3, then analyze in the notebook (preferred)

The reproducible path is **`bench/auto/candidate-analysis.ipynb`** (pandas + plotly): it pulls every
arm's `ledger.csv` from S3 and computes the **unprofiled medium-latency delta** (primary), the
validity guards (count match, `status=ok`/`errors=0`), charts, and a PASS/FAIL verdict. From the
EC2 client, publish the results once the sweep is done:

```bash
aws s3 sync "$RESULTS" "s3://kirill-tp-benchmarks/cand-results/dotnet/" \
  --exclude "*.nettrace"      # traces are large + not needed by the notebook's ledger logic
```

Then open `candidate-analysis.ipynb` anywhere with AWS creds for the bucket and set its parameters
cell:

```python
GLV                  = 'dotnet'
BUCKET               = 'kirill-tp-benchmarks'
PREFIX               = f'cand-results/{GLV}'          # -> cand-results/dotnet
BASELINE             = 'bench-baseline-dotnet'        # the baseline arm's directory tag
ARM_INCLUDE_PREFIXES = ('cand-dotnet-',)             # funnel naming: auto/cand-dotnet-<id>
```

Then **Run All**. It reproduces §5a–§5c deterministically (the notebook's optional CPU-gate parser
is tuned for the python yappi `tsub` table — for the dotnet `dotnet-trace` layout, do the CPU
cross-check in §5b by hand; the ledger-based wall-clock + guard logic is GLV-independent and works
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
`bench-baseline-dotnet` (subject to the §5c validity gates).

### 5b. `dotnet-trace` CPU profile — optional, network-independent cross-check (not the gate)

The **primary metric is §5a**; this is an *optional* attribution cross-check. Collect a CPU trace
while a single medium pass runs, then sum the **self/exclusive** time of the `GraphBinary4` frames
and compare to baseline — a **total self-time drop ≥ 5%** confirms the win lands in the deser hot
path rather than being noise.

```bash
dotnet tool install --global dotnet-trace 2>/dev/null || true
export PATH="$PATH:$HOME/.dotnet/tools"

# Collect: launch the profiling app under dotnet-trace for ONE medium pass on the current arm.
# (Run on the checked-out + built arm; tag the output by branch.)
tag=$(git -C "$REPO" rev-parse --abbrev-ref HEAD); tag="${tag##*/}"
DOTNET_GCServer=1 DOTNET_ThreadPool_MinThreads=1024 \
dotnet-trace collect --output "$RESULTS/$tag/medium-s1.nettrace" \
  --providers Microsoft-DotNETCore-SampleProfiler \
  -- dotnet run --project "$REPO/gremlin-dotnet/src/Gremlin.Net.Profiling" -c Release -- \
       --test-type latency --host "$HOST" \
       --script 'g.V().repeat(both()).times(12)' --warmups 1 --executions 3 --timeout 600000
```

Read the trace: open `medium-s1.nettrace` in **PerfView** or **Visual Studio**, or convert with
`dotnet-trace convert --format speedscope` and inspect in https://speedscope.app — then sum the
**exclusive (self) time** of frames under
`Gremlin.Net.Structure.IO.GraphBinary4.*` and compare baseline vs candidate. Confirm the drop lands
in the **file(s) the candidate touched** (e.g. `UuidSerializer`, `StreamExtensions`, `DataType`),
not noise elsewhere. A win should reproduce across all 3 sweeps.

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
GLV: dotnet   Baseline branch (immutable fork point): bench-baseline-dotnet = 5e7c118826
Medium result count (every arm must match): <record once from baseline arm>
Server: 16.59.222.63 (m7a.8xlarge, US-EAST-2)  Client: m7a.4xlarge, US-WEST-2  .NET SDK: 8.0

| Arm                                       | medium med (s, UNPROFILED) | tiny med (s) | GraphBinary4 self drop % (optional) | medium count |
|-------------------------------------------|----------------------------|--------------|-------------------------------------|--------------|
| bench-baseline-dotnet                     | (reference)                |              | —                                   | <N>          |
| cand-dotnet-uuid-single-read-span         |                            |              |                                     | (must = N)   |
| cand-dotnet-string-pooled-scratch-…       |                            |              |                                     | (must = N)   |
| cand-dotnet-binary-readexactly-correctness|                            |              |                                     | (must = N)   |
| cand-dotnet-datatype-intern-singletons    |                            |              |                                     | (must = N)   |
| cand-dotnet-char-stackalloc-span          |                            |              |                                     | (must = N)   |
| cand-dotnet-biginteger-bigendian-span-ctor|                            |              |                                     | (must = N)   |
| cand-dotnet-stackalloc-fixedwidth-prim…   |                            |              |                                     | (must = N)   |
| cand-dotnet-valuetask-sync-completion-…   |                            |              |                                     | (must = N)   |
| cand-dotnet-registry-bytecode-jumptable   |                            |              |                                     | (must = N)   |
```

- **Win** = **unprofiled medium wall-clock median improves** vs `bench-baseline-dotnet` (the primary
  signal) **and** tiny regression < 10%, reproduced across all 3 sweeps — subject to the **hard
  validity gates**: medium **count matches** the baseline count for every arm, and
  `status=ok`/`errors=0` on every row. If a gate fails the arm is void regardless of latency.
- *Optional cross-check:* a `dotnet-trace` self-time drop ≥ 5% in the same `GraphBinary4` file
  **confirms attribution** but is **not required** to call a win.
- All 9 are contract-clean (no "surface separately" group), but if you merge `datatype-intern-singletons`
  note the `DataType` reference-identity change called out in "What we are measuring".
- Each candidate is a clean single commit on `bench-baseline-dotnet` — a winner merges with
  `git merge --no-ff auto/cand-dotnet-<id>`. Merge **one at a time** and re-bench; several touch the
  same hot path (`stackalloc-fixedwidth-primitives` and `valuetask-sync-completion-primitives` both
  touch `StreamExtensions.cs`; `registry-bytecode-jumptable` touches the dispatch path) so they may
  be substitutes rather than additive.

---

## 7. Optional: throughput context

```bash
bench run --glv dotnet --test scaling-curve --host "$HOST" --label candidate-eval \
  --concurrency 64 --concurrency 128 --output-dir "$RESULTS/<tag>"
```
A client-side deser micro-opt rarely moves throughput much; **unprofiled medium latency (with the
optional `dotnet-trace` cross-check for attribution) is the signal that matters here.**

---

## 8. Teardown

```bash
git -C ~/tinkerpop-4 checkout bench-baseline-dotnet     # tree back on baseline
# stop the server: Ctrl+C in its console (Setup A) or on the server EC2 (Setup B)
# leave the EC2 instances running if other GLV benchmarks will reuse them (this pair is shared);
# otherwise stop/terminate once results are collected
```

---

## 9. Cheat sheet

```bash
# PROVISIONED BOX (Setup B): repo already at ~/tinkerpop-4, fork = `fork` remote, server = 16.59.222.63
cd ~/tinkerpop-4 && git fetch fork
for b in bench-baseline-dotnet \
         auto/cand-dotnet-uuid-single-read-span \
         auto/cand-dotnet-string-pooled-scratch-and-readexactly \
         auto/cand-dotnet-binary-readexactly-correctness \
         auto/cand-dotnet-datatype-intern-singletons \
         auto/cand-dotnet-char-stackalloc-span \
         auto/cand-dotnet-biginteger-bigendian-span-ctor \
         auto/cand-dotnet-stackalloc-fixedwidth-primitives \
         auto/cand-dotnet-valuetask-sync-completion-primitives \
         auto/cand-dotnet-registry-bytecode-jumptable ; do
  git branch --track "$b" "fork/$b" 2>/dev/null || true; done
pip3.11 install --user -e ~/tinkerpop-4/bench
# server box (16.59.222.63): kill any stale 3.7 server on 8182, then start 4.0 with MODERN config:
#   bin/gremlin-server.sh conf/gremlin-server-modern.yaml   (host: 0.0.0.0 already set)
# verify connectivity from client (§3): tiny cell must return result count 6, status=ok

# FRESH BOX (Setup A): clone fork as origin, dotnet-sdk-8.0 + maven, mvn build server — see §2

# sweep (baseline first), MEDIUM+TINY, UNPROFILED — see §4 for run_arm (NOTE: dotnet build per arm)
for s in 1 2 3; do for b in "${BRANCHES[@]}"; do run_arm "$b" "$s"; done; done

# read
# primary (decides winners): unprofiled medium wall-clock median vs bench-baseline-dotnet (§5a)
# hard gates: medium count matches baseline + status=ok/errors=0 (§5c)
# optional cross-check: dotnet-trace GraphBinary4 self-time drop ≥5% confirms attribution (§5b)
```

---

## See also

- `EC2-BENCHMARK-CANDIDATES-TEMPLATE.md` — the language-agnostic template this file instantiates.
- `EC2-BENCHMARK-CANDIDATES.md` — the gremlin-python worked instance (the model for this doc).
- `bench/README.md` — the harness: `bench run` usage, the append-only ledger, `--label` discipline,
  and the local-vs-EC2 warning this doc follows.
- `bench/SCHEMA.md` — the `RESULT_JSON:` contract behind every ledger row.
- `bench/matrix.yaml` — the test definitions; `protocol-overhead` medium = `times(12)`, tiny = `g.V()`.
- `dotnet-benchmarking-plan.md` (external `~/dev/tp benchmarking/`) — full two-EC2 cross-region setup
  and the `control` reference numbers in `results.csv`, plus the .NET SDK install recipe.
- `bench/auto/candidate-analysis.ipynb` — the reproducible pandas/plotly notebook that reads the
  S3-published results and renders the latency delta, guards, charts, and PASS/FAIL verdict (§5·0).
  Set `GLV='dotnet'`, `BASELINE='bench-baseline-dotnet'`, `ARM_INCLUDE_PREFIXES=('cand-dotnet-',)`.
- `bench/auto/RUNBOOK.md` — `glv-correctness-funnel.workflow.js`, the autonomous funnel that
  proposed these candidate branches (it stops at `mvn clean install`; you benchmark the arms
  afterward with this doc).
```
