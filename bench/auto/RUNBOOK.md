<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file. Apache License 2.0.
-->

# The Autonomous GLV Optimization Funnels — Operator Runbook

This is the operator's guide to the two `Workflow` scripts in this directory
that **discover, implement, and validate candidate performance optimizations**
for a GLV's GraphBinary deserialization hot path. It is the file the EC2
candidate runbooks refer to as "the autonomous funnel that proposed these
candidates."

Both funnels are **discovery + validation** pipelines: they fan out research
ideas, implement each surviving idea on its **own isolated branch**
(`auto/cand-<id>` or `auto/cand-<glv>-<id>`), gate each one, and hand you a set
of clean, single-purpose branches to review. **Nothing is ever merged, pushed,
combined, or applied to `master`** — you make the merge call.

| Funnel | Goes as far as | Use when |
|--------|----------------|----------|
| `glv-correctness-funnel.workflow.js` | `mvn clean install` (unit + integration + feature) | you want plausible, test-passing branches to **benchmark yourself** (or the GLV isn't python) |
| `glv-perf-funnel.workflow.js` | interleaved ABAB benchmark + adversarial verify | you want the funnel to **measure and prove** the win (python deser only) |

After either funnel produces branches, the **manual EC2 measurement** of those
branches is documented in [`EC2-BENCHMARK-CANDIDATES-TEMPLATE.md`](EC2-BENCHMARK-CANDIDATES-TEMPLATE.md)
(language-agnostic) and the worked python instance
[`EC2-BENCHMARK-CANDIDATES.md`](EC2-BENCHMARK-CANDIDATES.md); the analysis is in
[`candidate-analysis.ipynb`](candidate-analysis.ipynb).

---

## 1. Which funnel to run

```
Do you want the funnel to BENCHMARK the candidates for you?
│
├─ No, just give me test-passing branches I'll benchmark myself
│  └─►  glv-correctness-funnel   (works for python AND go; stops at mvn green)
│
└─ Yes, prove the win with profiling + interleaved benchmarks
   └─►  glv-perf-funnel          (python deser only; yappi CPU gate)
```

The correctness funnel exists because, with profiling removed, the only
GLV-specific organ (yappi-vs-pprof, deterministic-vs-sampling gate) disappears —
so a single script can serve multiple GLVs from a small `GLV_REGISTRY`. The perf
funnel is python-only precisely because its gate is the deterministic yappi
CPU-self-time number.

---

## 2. How to run

Both are invoked through the Claude Code **`Workflow`** tool (background +
resumable). They are **not** plain node scripts — they use the workflow harness
(`agent()`, `parallel()`, `pipeline()`, worktree isolation).

```js
// Correctness funnel (default glv=python)
Workflow({ scriptPath: ".../bench/auto/glv-correctness-funnel.workflow.js",
           args: { glv: "python" } })          // or { glv: "go" }

// Perf funnel (python deser; no glv arg)
Workflow({ scriptPath: ".../bench/auto/glv-perf-funnel.workflow.js" })
```

Watch live progress with `/workflows`. Both write artifacts and leave branches
behind; the workflow's return value is the ranked, bucketed list of survivors.

---

## 3. Arguments (knobs)

All knobs have defaults; override via the `args` object. The most useful:

### Common to both
| Arg | Default | Meaning |
|-----|---------|---------|
| `repo` | `/Users/kiristep/dev/tinkerpop` | repo root |
| `base` | perf: `4-glv-python-perf` · correctness: `4-glv-profiling` | branch candidates fork from (and the baseline arm) |
| `python` | `/Users/kiristep/venv-glv-4/bin/python` | interpreter for bench/pytest (python lane) |
| `maxResearch` | `10` | breadth of the synthesized portfolio |
| `implementCap` | `6` | how many candidates reach the expensive serial tail |
| `repairCheap` | `2` | code-repair attempts at the unit/build stage |
| `repairMvn` | `1` | code-repair attempts at the mvn gate |

### Correctness funnel only
| Arg | Default | Meaning |
|-----|---------|---------|
| `glv` | `python` | `python` or `go` (the `GLV_REGISTRY` keys) |
| `allowHighCeiling` | `true` | permit unsafe/native/Cython candidates (flagged to benchmark first) |
| `lenses` | per-GLV list | override the research lenses |

### Perf funnel only
| Arg | Default | Meaning |
|-----|---------|---------|
| `host` | `localhost` | server the bench arms hit |
| `serverDir` | the 4.0 standalone dir | where to start the modern server if none is reused |
| `allowCython` | `true` | permit the one C-ext lane candidate |
| `executions` / `warmups` | `5` / `2` | measured reps / warmups per bench invocation |
| `benchRounds` | `4` | ABAB rounds (baseline + candidate each round) |
| `totalCpuMinDrop` | `0.05` | **the gate**: total yappi self-time must drop ≥ 5% |
| `pyWallGuard` | `0.10` | medium wall-clock may regress at most 10% (loose guard) |
| `tinyTol` | `0.10` | tiny fixed-overhead query may regress at most 10% |
| `cextWallTol` | `0.03` | c-ext lane: wall-clock must be same-or-better within 3% |

---

## 4. What each phase does

### `glv-perf-funnel` (10 phases)
1. **Setup** — self-seeding, fail-fast rig. Confirms the venv; **detect-and-reuse
   a healthy modern server on :8182** or starts one (never retargets the port,
   never kills a foreign occupant — aborts instead). Validity predicate:
   server up **and** `g.V().count()==6` **and** a bench row parses **and** a
   yappi `.txt` is written. Captures the baseline profile as the **research seed
   + human anchor** (NOT the gate input).
2. **Research** — wide, diverse-lens idea generation (tiny tweaks → big
   refactors → a C-ext lane), one agent per lens.
3. **Investigate** — deep per-candidate risk/benefit study; ruthless prune; two-
   tier invariant classification; ranks into the narrow tail.
4. **Implement** — one agent per candidate in its **own git worktree**; code-
   repair loop; fast unit gate; C-ext build + load-proof.
5. **Review** — independent correctness + invariant review before the expensive
   gate.
6. **Correctness** — `mvn clean install` (unit + integration + feature/radish),
   **strictly serial** (Docker, fixed ports); ≤1 code-repair, which re-enters
   Review.
7. **Benchmark** — **interleaved ABAB** vs a *fresh* baseline arm re-measured in
   the same session (cancels drift), strictly serial. Lane-specific gate.
8. **Verify** — an adversarial skeptic tries to **refute** each apparent win
   (noise, behavior-change cheating, profile coherence, invariants).
9. **Finalize** — each survivor squashed into one clean commit on its own
   branch + an out-of-repo evidence `REPORT.md`.
10. **Report** — survivors ranked and sorted into buckets.

### `glv-correctness-funnel` (7 phases)
Same shape through **Review**, then a single **Correctness** (`mvn clean
install`) gate and a **Report** that buckets survivors — **no Setup server, no
baseline, no Benchmark, no Verify**. The deliverable is "a plausible
optimization that compiles and passes the FULL suite, reviewed and isolated,
ready for *your* benchmark."

---

## 5. The gates & invariants (why you can trust a survivor)

**Accept bar** is a *measured positive improvement*, not mere no-regression.

- **Perf-funnel python gate** = total profiled yappi **self-time** (`tsub`
  column, summed) drops ≥ 5% vs the fresh baseline arm. Deterministic and
  network-independent. Wall-clock latency is only a loose **guard**; the
  per-hotspot drop is a **diagnostic** (catches "work merely moved elsewhere"),
  never the gate.
- **Perf-funnel c-ext lane** — yappi can't see compiled cost, so it's gated on
  a **load proof** (the compiled module is genuinely imported, not a silent
  pure-Python fallback) + wall-clock same-or-better. Ranked separately; you do
  the deterministic external benchmark.
- **Correctness-funnel** — there is no measurement; a green `mvn clean install`
  + the independent invariant review are the only automated checks, so the
  review is load-bearing.

**Two-tier invariants** (both funnels):
- **HARD** (auto-prune): incremental **streaming** must still stream;
  **bounded memory** — no whole-body materialization. A breach kills the idea.
- **SOFT** (flag, don't kill): **public-API** (DataType enum identity, map key
  types) and **custom-serializer** extensibility. A candidate that needs one is
  implemented, measured, and surfaced in a separate `breaks-contract` bucket for
  your major-version judgment call.

**Tests are sacred** — no funnel may modify, skip, weaken, or delete a test to
pass; `touchedTests=true` is an auto-reject.

---

## 6. Output buckets

The return value (and the EC2 runbook that follows) sorts survivors into:

| Bucket | Meaning | Your next step |
|--------|---------|----------------|
| `clean` / `passed` | green, no contract break | benchmark (if not already), then merge |
| `breaks-contract` | green, but changes public-API / custom-serializer | major-version judgment call; benchmark first |
| `cext` (perf funnel) | compiled; profile-incomparable | deterministic external benchmark before trusting the speedup |

Each entry is an independent `auto/cand-<id>` branch with one clean commit. Merge
the ones you want **one at a time** with `git merge --no-ff` and re-bench — two
candidates touching the same hot path may be substitutes, not additive.

The perf funnel also writes an evidence `REPORT.md` per survivor under its
results dir (default `~/glv-auto-results/cand-<id>/`).

---

## 7. From funnel branches to trustworthy numbers

The funnels run on `localhost` (perf) or don't benchmark at all (correctness).
For numbers you can publish, take the surviving branches to the **two-EC2
cross-region rig** and follow the manual runbook:

1. [`EC2-BENCHMARK-CANDIDATES-TEMPLATE.md`](EC2-BENCHMARK-CANDIDATES-TEMPLATE.md)
   — fill in `GLV`, `BASELINE`, `CANDIDATE_BRANCHES`, the per-language
   `REBUILD_CMD`, and the `PROFILE_ENV`; sweep baseline-first, 3 sweeps.
2. Publish results to S3 and open
   [`candidate-analysis.ipynb`](candidate-analysis.ipynb) for the gate + guards
   + PASS/FAIL verdict.

See the parent [`../BENCHMARKING.md`](../BENCHMARKING.md) for the shared infra
and `--label` discipline (`candidate-eval` for these runs).

---

## 8. Operational cautions

- **Resumability** — both funnels are background + resumable; relaunch with
  `Workflow({ scriptPath, resumeFromRunId })` to reuse the unchanged prefix.
- **Never run two bench arms at once** — concurrent client CPU contention
  corrupts the comparison. The benchmark/correctness phases are strictly serial
  by design (one server, fixed ports).
- **No detached processes** — the perf funnel forbids `nohup`/`disown`/`setsid`
  for bench invocations; a prior run leaked an orphaned looping driver that way.
  Background-and-poll within the agent instead.
- **yappi inflates the profiled medium cell ~30×** (~7.5 s/req → ~230 s/req) and
  caps it at 3 executions — expected; the inflation cancels across arms because
  every arm is profiled identically. Read clean wall-clock from the **tiny** cell
  and the unprofiled **warmup** lines, never the profiled medium ledger median.

---

## See also

- [`../BENCHMARKING.md`](../BENCHMARKING.md) — the top-level map of all three
  benchmarking strands.
- [`../README.md`](../README.md) — the `bench` harness the funnels drive.
- [`../SCHEMA.md`](../SCHEMA.md) — the `RESULT_JSON:` contract behind every
  ledger row.
