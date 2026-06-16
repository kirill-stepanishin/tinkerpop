<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file. Apache License 2.0.
-->

# Benchmarking GLV Candidate Branches on EC2 — Language-Agnostic Template

A reusable runbook for measuring **a set of experimental performance branches for any one GLV**
(gremlin-python, gremlin-go, gremlin-dotnet, gremlin-javascript, the Java driver) **head-to-head
against their baseline branch**, using the `bench` harness (`bench/README.md`) so the runs land in
the same append-only ledger format as all prior TinkerPop benchmarking — with deterministic
numbers you can trust (unlike noisy, contended localhost).

> **This is the template.** For a fully worked, instantiated example see
> **`EC2-BENCHMARK-CANDIDATES.md`** (gremlin-python, four GraphBinary-deser candidates). Read that
> alongside this file the first time — it shows every placeholder below filled in with real values.

---

## 0. Fill these in (the only per-run edits)

Everything language- and run-specific lives here. Set these once at the top of your session; the
rest of the doc references them. The example values are gremlin-python's.

```bash
# ---- what GLV + which branches ----
GLV=python                                  # python | go | dotnet | javascript | java
REPO=~/tinkerpop-4                           # repo checkout on the client box
BASELINE=<baseline-branch-or-SHA>            # the baseline — ALWAYS the first arm.
# IMPORTANT: pin this to the EXACT fork-point SHA the candidates were cut from, NOT a moving
# branch tip. The funnel (glv-correctness-funnel.workflow.js) forks candidates from
# `4-glv-profiling`, but that branch ADVANCES as funnel-infra commits land — so its tip drifts
# away from where the arms were forked. Use the immutable fork-point SHA (this run: de50057c9e)
# so every arm = baseline + exactly one change. A moving tip would silently mix in extra commits.
CANDIDATE_BRANCHES=(                          # one experimental branch per optimization
  # The funnel produces this set FRESH each run; it is non-deterministic — do NOT assume a fixed
  # set. Current naming is auto/cand-<glv>-<id>, e.g. for python:
  auto/cand-python-<opt-1>
  auto/cand-python-<opt-2>
)

# ---- how to make a checked-out branch take effect (THE key per-language difference) ----
# Python is the exception: an editable install loads source live, so this is a no-op (":").
# Every compiled GLV must REBUILD the client/profiling app here.
REBUILD_CMD=":"                              # python: ":"  (no rebuild)
# go:      REBUILD_CMD="(cd $REPO/gremlin-go/driver && go build ./...)"
# dotnet:  REBUILD_CMD="dotnet build -c Release $REPO/gremlin-dotnet/src/Gremlin.Net"
# java:    REBUILD_CMD="mvn -q -pl gremlin-driver -am package -DskipTests"
# js(ts):  REBUILD_CMD="(cd $REPO/gremlin-javascript && npm run build)"

# ---- how to turn on the CPU profiler for the MEDIUM cell (OPTIONAL attribution cross-check) ----
# The primary signal is unprofiled medium wall-clock latency (§1); this is only the optional CPU
# cross-check. Set the env/flags the harness/app understands; leave empty to skip profiling.
PROFILE_ENV='GREMLIN_PROFILE=yappi-cpu'      # python: committed yappi hook
# go:      PROFILE_ENV='GREMLIN_PROFILE=pprof-cpu'      (pprof .pb.gz)
# dotnet:  via `dotnet-trace collect` wrapping the run   (EventPipe .nettrace)
# java:    via async-profiler agent or JFR start/dump
# js:      PROFILE_ENV='' + run node with --prof, parse with --prof-process

# ---- the file(s) the candidates actually touch (for the hot-spot sanity check in §5b) ----
HOT_FILE_GREP='graphbinaryV4|to_object|read_object|is_null|DataType'   # python deser symbols

# ---- infra (Setup B provisioned pair; see §1) ----
HOST=16.59.222.63                            # server IP (Setup B) or "localhost" (Setup A)

# ---- where results land — NAMESPACED BY GLV so a Go run can never collide with a Python run ----
RESULTS=~/cand-results/$GLV                   # e.g. ~/cand-results/python, ~/cand-results/go
```

> **Result isolation.** Every arm writes to `$RESULTS/<branch-tag>/ledger.csv` — a per-GLV,
> per-branch directory entirely separate from the harness default `~/bench-results` and from other
> GLVs' candidate runs. The ledger is append-only (re-runs never overwrite), and every row carries
> `label` (`candidate-eval`), `host`, and `git_sha` provenance, so candidate data never interferes
> with regular `smoke`/`control` benchmarking results even if directories were ever shared.

> **The one rule that makes this template work:** baseline goes first, each candidate is a single
> commit on top of the baseline branch, the **server is identical for every arm**, and **only the
> client GLV changes between arms**. That keeps it a clean apples-to-apples comparison no matter the
> language.

---

## 1. Mental model (language-independent)

A client-side performance change to a GLV is almost always a **client-CPU** cost (deserialization,
object construction, dispatch). The signal is strongest where the result set is large, so the
harness's **medium** point `g.V().repeat(both()).times(12)` is the primary test; the **tiny** point
`g.V()` (6 vertices) is a fixed-overhead guard that **must not regress**.

Two signals per candidate — one primary, one optional cross-check:

1. **Unprofiled medium wall-clock latency (median)** *(the primary decision metric)* — the harness
   records one row per cell to `ledger.csv`; read the **`median`** column (sec/req) from the
   **medium** point run **unprofiled**. This is the realistic headline signal: the medium result
   set is huge (~**200766** objects on the Modern graph, ~**8 s/req** cross-region), so client-side
   **deserialization dominates total latency** while network RTT is **<1%**. A real client-CPU win
   shows up directly here. Compare the *relative* delta vs the baseline arm in the same session.
2. **CPU profile self-time** *(optional, secondary cross-check)* — turn on the language's CPU
   profiler (`PROFILE_ENV`) and sum the **self-time** column. A **total self-time drop ≥ 5%** is a
   deterministic, **network-independent** confirmation that the win lands in the deser hot path (not
   noise) — useful for *attribution*, but it is **not the sole gate**. Run it only if you want that
   cross-check; skip it and the unprofiled latency above still decides.

> Run baseline and each candidate **back-to-back in the same session** and compare the *relative*
> delta. Never quote raw EC2 ms as an absolute latency figure.

> **Never read latency from a profiled cell.** The profiler inflates the profiled medium cell
> (~**30×** for Python/yappi), so its `median` is not a wall-clock number. Run **medium unprofiled**
> for the latency signal; if you also want yappi/CPU attribution, run it as a **separate single
> pass**, not the same cell.

> **Record the medium result count once, from the baseline arm.** It is graph- and traversal-
> specific (e.g. **200766** for `times(12)` on the Modern graph). The exact number doesn't matter —
> but **every arm must return the identical count**, or the candidate changed behavior and the
> comparison is void (§5c).

---

## 2. Infrastructure (shared across all GLVs)

Only the **client** is GLV-specific; the server is the same Java gremlin-server regardless of which
client language you benchmark. Two valid setups:

| Setup | Server | Client | When |
|---|---|---|---|
| **A — single instance** | localhost on the client box | same box | fastest to stand up; valid because all arms share one server + network, so they cancel, and the optional CPU-profile cross-check is network-independent |
| **B — cross-region** | `m7a.8xlarge`, US-EAST-2 | `m7a.4xlarge` (16 vCPU), US-WEST-2 | when you also want wall-clock numbers comparable to the `control` rows in `results.csv` |

> **The provisioned benchmarking pair (Setup B) — concrete values**, reused across every language
> (`python-/go-/dotnet-/javascript-benchmarking-plan.md`):
> - **Server:** `m7a.8xlarge`, US-EAST-2, IP **`16.59.222.63`** → `HOST=16.59.222.63`.
> - **Client:** `m7a.4xlarge` (16 vCPU), US-WEST-2.
> - Security group already allows TCP **8182** client→server. If the instances are re-created the
>   IP changes — re-confirm with `ec2-metadata`/`hostname -I` on the server box.

**`--label` discipline** (from `bench/README.md`): `smoke` = localhost plumbing checks, `control` =
the canonical cross-region setup. A dedicated quiet EC2 that isn't the canonical control is a third
case — **tag these runs `--label candidate-eval`** so they're never mistaken for either.

**Repo + remote on the provisioned boxes:** repo at **`~/tinkerpop-4`**, the fork is the **`fork`**
remote (`origin` = upstream `apache/tinkerpop`). Translate `fork/`↔`origin/` if your box differs.

---

## 3. One-time client setup

Inventory first on a provisioned box — don't blindly reinstall:

```bash
git -C "$REPO" remote -v && git -C "$REPO" branch          # fork remote? branches local?
git -C "$REPO" status --short                              # tree clean? (mode-only changes are harmless)
```

Then fetch the baseline + candidate branches:

```bash
cd "$REPO" && git fetch fork
for b in "$BASELINE" "${CANDIDATE_BRANCHES[@]}"; do
  git branch --track "$b" "fork/$b" 2>/dev/null || true
done
git checkout "$BASELINE" && git log --oneline -1           # confirm baseline SHA
```

**Per-GLV client toolchain + the `bench` harness** — the build/install steps differ by language;
follow the matching sibling plan, which already documents them in detail:

- **python** — editable install of the driver (`pip install -e .../gremlin-python/...`); see `python-benchmarking-plan.md`.
- **go** — `go build` the profiling app; see `go-benchmarking-plan.md`.
- **dotnet** — `dotnet build -c Release`; see `dotnet-benchmarking-plan.md`.
- **javascript** — `npm ci` (+ build if TS); see `javascript-benchmarking-plan.md`.
- **java** — `mvn package` the driver/profiling app; see `java-benchmarking-guide.md`.

Install the harness once (it is run-only, version-ignorant, PyYAML its only dep):
```bash
pip3.11 install --user -e "$REPO/bench"     # or `pip install -e bench` inside a venv
bench --help | head -1                       # expect: usage: bench ...
```

Confirm the harness resolves your GLV's launcher (no server needed):
```bash
cd "$REPO/bench"
bench run --glv "$GLV" --test protocol-overhead --size medium --dry-run
# expect the resolved launcher path + exact argv; an unbuilt GLV shows MISSING → build it (above)
```

### Server (Setup A localhost, or the Setup B server EC2)

> **Use the `gremlin-server-modern.yaml` config — not the default.** The latency tests traverse the
> **Modern graph**, which only `*-modern.yaml` preloads; the default config serves an empty graph
> and `g.V()` returns nothing.

> **Watch for a leftover wrong-version server on 8182.** These boxes are reused across 3.x and 4.x
> runs; a stale server of the wrong major version will not speak the protocol your 4.x client
> expects (GraphBinary V4), invalidating the comparison. Check and stop it first:
> ```bash
> pgrep -af gremlin-server         # inspect the path: 3.7.x vs 4.0.0
> ss -ltn | grep 8182
> kill <pid>; sleep 3; ss -ltn | grep 8182 || echo "port 8182 free"
> ```

```bash
cd "$REPO"
ls gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone 2>/dev/null \
  || mvn clean install -pl gremlin-server -am -DskipTests -Dasciidoc.skip=true   # build only if absent
cd gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone
export JAVA_OPTIONS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
sed -i 's/^evaluationTimeout: .*/evaluationTimeout: 30000000/' conf/gremlin-server-modern.yaml
# Setup B only — open to the network so the cross-region client can connect:
sed -i 's/^host: localhost/host: 0.0.0.0/' conf/gremlin-server-modern.yaml
bin/gremlin-server.sh conf/gremlin-server-modern.yaml      # wait for: Channel started at port 8182
```
Leave it running in its own `tmux`/`screen` pane for the whole session.

---

## 4. Load the graph & verify connectivity

```bash
cd "$REPO/bench"
bench run --glv "$GLV" --test protocol-overhead --size tiny \
  --host "$HOST" --label candidate-eval --executions 1 --warmups 1 \
  --output-dir "$RESULTS/_connectivity"
cat "$RESULTS/_connectivity/ledger.csv"
```
A row with `status=ok`, a non-empty `median`, and **result count 6** (Modern graph loaded) means
you're ready. Connection refused → server down (A) or SG / `host: 0.0.0.0` (B). `count != 6` →
wrong server config.

> **Run this connectivity cell FIRST — it catches launcher/driver/runtime drift before you burn a
> full sweep.**
>
> **Gotcha: profiling-app argument / client-env drift.** A launcher/driver/runtime-version mismatch
> fails *identically on every arm* (the source is the same baseline + a one-line change), so it
> looks like a universal benchmark failure rather than a bug. If a cell fails with **"no RESULT_JSON
> line found"**, don't guess — read that cell's log under **`<output-dir>/logs/`** for the real
> traceback.
>
> *Real example (python, aiohttp 3.13.5):* the profiling app
> (`gremlin-python/.../driver/util/profiling_application.py`) passed
> `request_serializer=GraphBinarySerializersV4()` into `Client(...)`, which has **no such
> parameter**. It fell through `**transport_kwargs` to aiohttp's `ClientSession.post()` and raised
> `TypeError: ClientSession._request() got an unexpected keyword argument 'request_serializer'`.
> Older aiohttp tolerated it; 3.13.5 does not. **Fix:** drop the unsupported kwarg — the driver
> already defaults `response_serializer` to `GraphBinarySerializersV4()`, so GraphBinary V4 is used
> both directions and behavior is unchanged.
>
> Because such a fix is **identical across all arms**, it does **not** bias the comparison — but it
> must be applied to the baseline and **carried by every candidate arm**.

---

## 5. The benchmark loop

Sweep **baseline first, then each candidate**, capturing the unprofiled medium wall-clock (ledger,
the primary signal) and — optionally — a separate profiled CPU pass per arm. Do **3 full sweeps**
for medians-of-medians. Each arm writes to its own `--output-dir`.

### 5a. Scaffolding

```bash
cd "$REPO/bench"
mkdir -p "$RESULTS"
BRANCHES=( "$BASELINE" "${CANDIDATE_BRANCHES[@]}" )   # baseline MUST be first
```

### 5b. Per-arm function (note the per-language REBUILD step)

```bash
run_arm () {
  local branch="$1" sweep="$2"
  local tag="${branch##*/}"
  local out="$RESULTS/$tag"
  mkdir -p "$out"

  echo "===== sweep $sweep :: $branch ====="
  git -C "$REPO" checkout "$branch" 2>/dev/null      # 1. switch to the arm's source
  git -C "$REPO" log --oneline -1                    #    record exactly what we run
  eval "$REBUILD_CMD"                                # 2. REBUILD (no-op ":" for python; compile for others)

  # --- MEDIUM, UNPROFILED (the primary signal: wall-clock median) ---
  bench run --glv "$GLV" --test protocol-overhead --size medium \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  # --- MEDIUM, with CPU profile (OPTIONAL attribution cross-check; separate pass) ---
  # Skip entirely if you don't need CPU attribution. NEVER read latency from this cell — the
  # profiler inflates it (~30× for python/yappi). Run it as its own pass, not the latency one.
  if [ -n "$PROFILE_ENV" ]; then
    env $PROFILE_ENV \
    GREMLIN_PROFILE_OUT="$out/medium-s$sweep" \
    bench run --glv "$GLV" --test protocol-overhead --size medium \
      --host "$HOST" --label candidate-eval \
      --warmups 2 --executions 5 \
      --output-dir "$out"
  fi

  # --- TINY, fixed-overhead guard (unprofiled) ---
  bench run --glv "$GLV" --test protocol-overhead --size tiny \
    --host "$HOST" --label candidate-eval \
    --warmups 2 --executions 5 \
    --output-dir "$out"

  sleep 30      # cool-down between arms
}
```

Notes:
- **Latency comes from the UNPROFILED medium pass; never from a profiled cell.** The CPU profiler
  inflates the profiled medium cell by a language-dependent factor — for Python/yappi it is **~30×**
  (and caps that cell at 3 executions). The profiled pass is an *optional* attribution cross-check
  only. **Always run one arm first** (`run_arm "$BASELINE" 1`) and confirm both the unprofiled
  latency row and (if used) the profile file land before committing to the full loop. The full
  3×N-arm loop can be minutes (latency-only) to **hours** (yappi).
- All rows for an arm **append** to its `ledger.csv` — re-running never overwrites.
- The unprofiled medium pass always runs (it is the primary signal). The profiled pass is gated on
  `PROFILE_ENV` being set; leave it empty to skip CPU attribution and rely on latency alone (plus any
  external profiler you wrap the run in).

### 5c. Run the sweeps (under tmux)

```bash
for sweep in 1 2 3; do
  for b in "${BRANCHES[@]}"; do
    run_arm "$b" "$sweep"
  done
done 2>&1 | tee "$RESULTS/sweep-run.log"
git -C "$REPO" checkout "$BASELINE"      # leave the tree on baseline when done
```
**Never run two arms at once** — concurrent client CPU contention corrupts the comparison.

---

## 6. Read the results

### 6·0. Publish to S3, then analyze in the notebook (preferred)

The reproducible path is **`bench/auto/candidate-analysis.ipynb`** (pandas + plotly): it pulls every
arm's `ledger.csv` (+ optional CPU profiles) from S3 and computes the **unprofiled medium-latency
delta** (primary), the validity guards (count match, `status=ok`/`errors=0`), the optional CPU
self-time cross-check, charts, and a PASS/FAIL verdict — replacing the hand-run shell below. From
the client, publish results after the sweep:

```bash
aws s3 sync "$RESULTS" "s3://kirill-tp-benchmarks/cand-results/$GLV/" \
  --exclude "*.callgrind"      # large + not needed by the notebook
```

Then open the notebook with AWS creds for the bucket, set its `GLV` parameter to match, and **Run
All**. The shell in §6a–§6c is kept as a no-Jupyter fallback / cross-check. (The notebook's CPU-gate
parser is tuned for the Python yappi `tsub` table; for a profiler with a different text layout, adjust
its `sum_tsub` cell — the ledger-based wall-clock and guard logic is GLV-independent.)

### 6a. Unprofiled medium wall-clock median — the primary decision metric

```bash
for d in "$RESULTS"/*/; do
  [ -f "$d/ledger.csv" ] || continue
  echo "== $(basename "$d") =="
  awk -F, 'NR==1{for(i=1;i<=NF;i++)h[$i]=i; next}
           $h["point_value"]=="medium"{printf "  medium median=%s status=%s errors=%s\n",$h["median"],$h["status"],$h["errors"]}' \
      "$d/ledger.csv"
done
```
> If the medium cell was profiled, its ledger `median` is profiler-inflated — read clean wall-clock
> from the warmup lines, or run a separate unprofiled medium sweep. The **tiny** median is always
> unprofiled and is a valid clean guard.

### 6b. CPU profile — optional, network-independent cross-check (not the gate)

The **primary metric is the unprofiled medium wall-clock median in §6a**; this section is an
*optional* attribution cross-check. The parsing is per-language (sum the self-time column of one
medium profile, compare to baseline): a **total self-time drop ≥ 5% confirms the win lands in the
deser hot path** rather than being noise. It is deterministic and has no network in the path, but it
is **secondary** — skip it and §6a still decides. Python/yappi example:

```bash
sum_tsub () { awk 'NR>2 && $3 ~ /^[0-9.]+$/ { s+=$3 } END { printf "%.3f\n", s }' "$1"; }
base=$(sum_tsub "$RESULTS/${BASELINE##*/}"/medium-s1-*cpu.txt)
for d in "$RESULTS"/cand-*; do
  c=$(sum_tsub "$d"/medium-s1-*cpu.txt)
  awk -v b="$base" -v c="$c" -v n="$(basename "$d")" 'BEGIN{printf "%-34s total=%ss drop=%.1f%%\n",n,c,(b-c)/b*100}'
done
```
(For go use `go tool pprof -top`; for dotnet/java open the trace/JFR and sum self/exclusive time.)

Confirm the drop lands in the **targeted hot spot**, not noise elsewhere:
```bash
grep -E "$HOT_FILE_GREP" "$RESULTS"/<some-candidate>/medium-s1-*cpu.txt | head
```
A win should reproduce across all 3 sweeps, not just one.

### 6c. Sanity gates (any failure invalidates the arm)

- **`status=ok` and `errors=0`** for every row.
- **Warmup must pass** — `median` 0/empty + `error_reason` = aborted warmup gate; re-run.
- **Result count must match the baseline count** for every arm (check each cell's log under
  `<output-dir>/logs/`); a different count means behavior changed → comparison void.

---

## 7. Decide & record

```
GLV: <glv>   Baseline branch/SHA (immutable fork point): <baseline>   Medium result count (all arms must match): <N>
Server: 16.59.222.63 (m7a.8xlarge, US-EAST-2)  Client: m7a.4xlarge, US-WEST-2

| Arm         | medium med (s, UNPROFILED) | tiny med (s) | <profiler> self drop % (optional) | medium count |
|-------------|----------------------------|--------------|-----------------------------------|--------------|
| baseline    | (reference)                |              | —                                 | <N>          |
| <candidate> |                            |              |                                   | (must = N)   |
```

- **Win** = **unprofiled medium wall-clock median improves** vs baseline (the primary signal)
  **and** tiny regression < 10%, reproduced across all 3 sweeps — subject to the **hard validity
  gates**: medium **count matches** the baseline count for every arm, and `status=ok`/`errors=0` on
  every row. If a gate fails the arm is void regardless of latency.
- *Optional cross-check:* a CPU self-time drop ≥ 5% in the same hot path **confirms attribution**
  (the win is real deser work, not noise). It strengthens confidence but is **not required** to call
  a win.
- Each candidate is a clean single commit on the baseline — a winner merges with
  `git merge --no-ff <branch>`. Merge **one at a time** and re-bench; two touching the same hot
  path may be substitutes rather than additive.

---

## 8. Optional: throughput context

```bash
bench run --glv "$GLV" --test scaling-curve --host "$HOST" --label candidate-eval \
  --concurrency 64 --concurrency 128 --output-dir "$RESULTS/<tag>"
```
A client-side micro-opt rarely moves throughput much (and some GLVs are GIL-/contention-bound);
**latency + CPU profile are the signals that matter here.**

---

## 9. Teardown

```bash
git -C "$REPO" checkout "$BASELINE"            # tree back on baseline
# stop the server (Ctrl+C / on the server EC2). Leave instances running if other GLV
# benchmarks will reuse this shared pair; otherwise stop/terminate once results are collected.
```

---

## See also

- **`EC2-BENCHMARK-CANDIDATES.md`** — the fully worked gremlin-python instance of this template.
- **`candidate-analysis.ipynb`** — the reproducible pandas/plotly notebook that reads the
  S3-published results and renders the gate, guards, charts, and PASS/FAIL verdict (§6·0).
- `bench/README.md` — `bench run` usage, append-only ledger, `--label` discipline, local-vs-EC2 warning.
- `bench/SCHEMA.md` — the `RESULT_JSON:` contract behind every ledger row.
- `bench/matrix.yaml` — test definitions; `protocol-overhead` medium = `times(12)`, tiny = `g.V()`.
- `<lang>-benchmarking-plan.md` / `java-benchmarking-guide.md` — per-language build + the
  two-EC2 cross-region `control` reference numbers in `results.csv`.
- `bench/auto/RUNBOOK.md` — `glv-correctness-funnel.workflow.js`, the autonomous funnel that
  proposes candidate branches (it stops at `mvn clean install`; you benchmark the arms afterward
  with this template).
