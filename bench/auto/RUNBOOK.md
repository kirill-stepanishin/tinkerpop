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
# The Autonomous GLV Optimization Funnels — Operator Runbook

This is the operator's guide to the `Workflow` scripts in this directory that
**discover, implement, and validate candidate performance optimizations** for a
GLV's GraphBinary deserialization hot path. It is the file the EC2 candidate
runbooks refer to as "the autonomous funnel that proposed these candidates."

There are two scripts, and they play different roles:

| Script | Role | Goes as far as |
|--------|------|----------------|
| [`glv-correctness-funnel.workflow.js`](glv-correctness-funnel.workflow.js) | **the proposer** — researches, implements, reviews, and gates brand-new candidates (python, go, dotnet **and** javascript) | a green `mvn clean install` (unit + integration + feature/radish) |
| [`glv-recovery-gate.workflow.js`](glv-recovery-gate.workflow.js) | **a repair tool** — re-runs the full mvn gate for candidates that were already implemented + reviewed but never properly gated | a green `mvn clean install` for a fixed work-list of branches |

Both are **discovery + validation** pipelines. They implement (or re-gate) each
surviving idea on its **own isolated branch**, gate each one through the full
maven correctness suite, and hand you a set of clean, single-purpose branches to
review. **Nothing is ever merged, pushed, combined, or applied to `master`** —
you make the merge call, and **all benchmarking is yours to do by hand** (there
is no benchmarking or profiling inside either workflow).

After a funnel produces branches, the **manual EC2 measurement** of those
branches is documented in
[`EC2-BENCHMARK-CANDIDATES-TEMPLATE.md`](EC2-BENCHMARK-CANDIDATES-TEMPLATE.md)
(language-agnostic) and the worked python instance
[`EC2-BENCHMARK-CANDIDATES.md`](EC2-BENCHMARK-CANDIDATES.md); the analysis lives
in [`candidate-analysis.ipynb`](candidate-analysis.ipynb).

---

## 1. Which script to run

```
Are you proposing NEW candidates, or repairing an existing batch?
│
├─ Propose NEW optimizations (python / go / dotnet / javascript), end-to-end through the mvn gate
│  └─►  glv-correctness-funnel   (args: { glv: "python" } | { glv: "go" } | { glv: "dotnet" } | { glv: "javascript" })
│
└─ Re-gate a specific set of ALREADY-implemented branches that never got a
   real mvn gate (a branch-naming bug left them ungated, plus one false-green)
   └─►  glv-recovery-gate        (no research/implement; gate + report only)
```

The correctness funnel is the workhorse: it is GLV-parameterized off a small
`GLV_REGISTRY`, so one script serves multiple GLVs. The recovery gate is a
narrow one-off repair: its candidates are already written on their branches, so
it skips research/investigate/implement entirely and only runs the gate.

There is **no in-workflow benchmarking** in either script. Whichever you run,
the deliverable is branches that **compile and pass the full test suite**, ready
for your manual EC2 benchmark — not "proven faster."

---

## 2. How to run

Both are invoked through the Claude Code **`Workflow`** tool (background +
resumable). They are **not** plain node scripts — they use the workflow harness
(`agent()`, `parallel()`, `pipeline()`, `phase()`, worktree isolation).

```js
// Correctness funnel (default glv=python)
Workflow({ scriptPath: ".../bench/auto/glv-correctness-funnel.workflow.js",
           args: { glv: "python" } })          // or { glv: "go" }, { glv: "dotnet" }, { glv: "javascript" }

// Recovery gate (fixed work-list; no args needed)
Workflow({ scriptPath: ".../bench/auto/glv-recovery-gate.workflow.js" })
```

Watch live progress with `/workflows`. Both leave branches behind; each
workflow's return value is the bucketed list of survivors (see §6).

---

## 3. Arguments (knobs)

### Correctness funnel

All knobs have defaults; override via the `args` object.

| Arg | Default | Meaning |
|-----|---------|---------|
| `glv` | `python` | `python`, `go`, `dotnet`, or `javascript` — the `GLV_REGISTRY` key that selects every GLV-specific detail |
| `repo` | `/Users/kiristep/dev/tinkerpop` | repo root |
| `base` | `4-glv-profiling` | branch candidates fork from |
| `python` | `/Users/kiristep/venv-glv-4/bin/python` | interpreter for the python-lane unit gate |
| `maxResearch` | `10` | breadth of the synthesized portfolio |
| `implementCap` | `6` | how many candidates reach the expensive serial mvn tail |
| `repairCheap` | `2` | code-repair attempts at the unit/build stage |
| `repairMvn` | `1` | code-repair attempts at the mvn gate |
| `allowHighCeiling` | `true` (on unless `false`) | permit unsafe/native/Cython candidates (flagged so you benchmark them first) |
| `lenses` | per-GLV list | override the research lenses |
| `profileRoot` | `/Users/kiristep/dev/profiling-results` | root of stored profiling results; `${profileRoot}/${profileSubdir}` is read at Setup to seed Research. Set to `''` to fall back to the static registry seed |

The recovery gate takes **no args** — its repo, base (`de50057c9e`), module
(`gremlin-python`), and the candidate work-list are constants in the script.

---

## 4. What each phase does

### `glv-correctness-funnel` (7 phases)

1. **Setup** — light, fail-fast. Confirms the toolchain (python+pytest, go+mvn,
   dotnet+mvn, or node+npm+mvn) and that the tree is committed enough to fork
   worktrees from `base`.
   **No server, no baseline.** It *also* reads the stored profiling results at
   `PROFILE_DIR` (when `profileRoot` is set) and distills a **ranked hotspot
   digest** that seeds Research; this profile read is **non-blocking** (a
   missing/unreadable profile falls back to the static registry seed and never
   aborts Setup).
2. **Research** — wide, diverse-lens idea generation (tiny tweaks → big
   refactors → an optional high-ceiling C-ext/unsafe lane), one agent per lens,
   then a synthesis pass into a deduped portfolio (≤ `maxResearch`).
3. **Investigate** — deep per-candidate study; ruthless prune; two-tier
   invariant classification; ranks the survivors into the narrow tail (≤
   `implementCap`).
4. **Implement** — one agent per candidate **in its own git worktree**. It
   re-checks-out onto `auto/cand-<glv>-<id>` forked from `base` (the branch name
   is load-bearing — the downstream gate looks candidates up strictly by it),
   makes one clean commit, then runs a fast unit gate with a bounded code-repair
   loop (`repairCheap`). Pipelined into Review.
5. **Review** — an independent agent reads the diff and judges
   behavior-equivalence + invariants **before** the expensive gate. With no
   benchmark downstream, this review and the test suite are the only automated
   checks, so it is load-bearing.
6. **Correctness** — `mvn clean install` (unit + integration + feature/radish),
   **strictly serial** (Docker-orchestrated, fixed ports). Builds upstream
   reactor prereqs in the worktree, activates the `.glv` profile, and proves the
   suite actually ran (see §5). ≤ `repairMvn` code-repair, which re-enters
   Review.
7. **Report** — every test-passing branch, finalized to one clean commit and
   sorted into buckets (`passed` / `breaksContract`). Nothing merged or pushed.

### `glv-recovery-gate` (2 phases)

1. **Gate** — for each branch in the fixed work-list, **strictly serial**: check
   out the branch in a worktree, verify it is exactly one commit ahead of `base`
   and touches the deser source, activate the `.glv` profile, run `mvn clean
   install` (background + poll), and prove the integration+radish suite actually
   ran. ≤ `repairMvn` (=2) code-repair on a genuine candidate bug re-enters a
   correctness review.
2. **Report** — survivors finalized to one clean commit each and bucketed
   (`passed` / `breaksContract`). Nothing merged or pushed.

The recovery gate runs **no research, investigate, or implement** — the
candidates are already implemented on their branches; it only re-runs the
corrected gate. It carries a fixed `CANDIDATES` work-list (a specific recovered
set of gremlin-python deser candidates, including one prior false-green being
re-gated), so you do not pass it in.

---

## 5. The gates & invariants (why you can trust a survivor)

Neither script measures performance — a green **`mvn clean install`** plus the
independent invariant review are the only automated checks, so the review is
load-bearing and the suite must *genuinely run*.

**The `.glv` false-green trap (the key correctness lesson).** The gremlin-python
integration + feature (radish) tests live in a maven profile activated **only**
by a gitignored marker file `gremlin-python/.glv`. Without `touch .glv`, `mvn
clean install` **BUILD-SUCCEEDS in seconds while running ZERO integration/feature
tests** — a *false green*. Both scripts therefore `touch .glv` and then **prove
the suite actually ran** before trusting the result:

- python: a minutes-long build whose log shows the docker integration tests plus
  the radish feature run (typically ~163 features / ~2149 scenarios / ~9890
  steps, printed once per serializer mode, ×3). A sub-10-second BUILD SUCCESS
  with no radish/pytest counts means the profile did **not** activate (`suiteRan
  = false`, dropped).
- go: a minutes-long build whose log shows docker compose building images, the
  gremlin-server becoming healthy, and the gremlin-go integration container
  running `go test` and exiting 0. There is **no** radish output for Go — do not
  expect feature/scenario counts.
- dotnet: needs **both** markers (`gremlin-dotnet/src/.glv` **and**
  `gremlin-dotnet/test/.glv`); the suite is xUnit/TRX-framed (Gherkin runner
  included) — expect `Passed!` summaries plus the three Examples projects, not
  radish counts.
- javascript: **the exception — there is no `.glv` marker.** The `glv-js` docker
  profile is `activeByDefault=true`, so a plain `mvn clean install` already runs
  the suite; the false-green here is a **`-DskipTests` / `-Dmaven.test.skip`
  flag**, which no-ops the integration exec. The gate runs *without* any skip
  flag and proves the run by a minutes-long build whose log shows the
  `gremlin-js-integration-tests` container do `npm ci`, the mocha unit+integration
  passing counts, the cucumber-js feature run, and the three node examples
  printing `All examples completed successfully`. Framing is mocha + cucumber-js,
  not radish.

Catching that false green is part of why the recovery gate exists at all (one of
its work-list entries is a prior false-green being re-gated for real).

**Two-tier invariants** (correctness funnel; the recovery gate enforces the
same HARD pair on re-review):

- **HARD** (auto-prune): incremental **streaming** must still stream; **bounded
  memory** — no whole-body/whole-response materialization. A breach kills the
  idea (`viable = false`).
- **SOFT** (flag, don't kill): **public-API** (DataType enum identity, map key
  types / exported signatures) and **custom-serializer** extensibility. A
  candidate that needs one is still implemented, gated, and surfaced in the
  separate `breaksContract` bucket for your major-version judgment call.

**Tests are sacred** — no script may modify, skip, weaken, or delete a test to
pass; `touchedTests = true` is an auto-reject.

---

## 6. Output buckets

Each script returns survivors sorted into:

| Bucket | Meaning | Your next step |
|--------|---------|----------------|
| `passed` | green full suite, no contract break | benchmark, then merge |
| `breaksContract` | green, but changes public-API / custom-serializer | major-version judgment call; benchmark first |

Each entry is an independent branch with **one clean commit**:
`auto/cand-<glv>-<id>` from the correctness funnel, or the work-list branch name
from the recovery gate. Every entry carries a `benchmarkHint` describing what to
measure to confirm the win.

Merge the ones you want **one at a time** with `git merge --no-ff` and re-bench —
two candidates touching the same hot path may be substitutes, not additive.

---

## 7. From funnel branches to trustworthy numbers

Neither script benchmarks. **All measurement is the operator's manual EC2 job.**
Take the surviving branches to the two-EC2 cross-region rig and follow the manual
runbook:

1. [`EC2-BENCHMARK-CANDIDATES-TEMPLATE.md`](EC2-BENCHMARK-CANDIDATES-TEMPLATE.md)
   — fill in `GLV`, `BASELINE`, `CANDIDATE_BRANCHES`, the per-language
   `REBUILD_CMD`, and the `PROFILE_ENV`; sweep baseline-first.
   [`EC2-BENCHMARK-CANDIDATES.md`](EC2-BENCHMARK-CANDIDATES.md) is the worked
   python instance.
2. Publish results to S3 and open
   [`candidate-analysis.ipynb`](candidate-analysis.ipynb) for the PASS/FAIL
   verdict.

**Primary signal: unprofiled medium WALL-CLOCK latency.** The medium query
`g.V().repeat(both()).times(12)` returns ~200,766 objects and is
deserialization-dominated, so client-side deserialization dominates total
latency — read the win straight off clean wall-clock. yappi CPU self-time (the
`tsub` self-time attribution) is an **optional deterministic cross-check** for
anyone who runs the profiled pass, not the gate.

> Caution for the optional profiled pass: **yappi inflates the profiled medium
> cell ~30×** (and caps its execution count). The inflation cancels across arms
> because every arm is profiled identically, but never read clean latency off the
> profiled medium ledger — use the unprofiled wall-clock cells.

See the parent [`../BENCHMARKING.md`](../BENCHMARKING.md) for the shared infra
and `--label` discipline (`candidate-eval` for these runs).

---

## 8. Operational cautions

- **Resumability** — both scripts are background + resumable; relaunch with
  `Workflow({ scriptPath, resumeFromRunId })` to reuse the unchanged prefix.
- **Strictly serial gate** — the mvn correctness gate is one build at a time by
  design (Docker, fixed host ports — `45940`-`45943`/`4588` for the GLV docker
  suites, `8182` elsewhere). Never run two builds at once; the fixed ports must
  be free.
- **Worktree isolation** — every candidate lives in its own git worktree; the
  branch name `auto/cand-<glv>-<id>` (correctness funnel) is load-bearing because
  the gate and finalizer find candidates strictly by it. A fresh worktree must
  build the upstream reactor prereqs once and **activate the suite** before the
  gate (`touch .glv` for python/go, `touch src/.glv test/.glv` for dotnet — but
  **javascript has no marker**: just don't pass a skip flag, and `npm ci` at the
  `gremlin-js` workspace root for the unit gate), or the build fails fast /
  false-greens.
- **Tests are sacred** — `touchedTests = true` auto-rejects a candidate at every
  stage.

---

## See also

- [`../BENCHMARKING.md`](../BENCHMARKING.md) — the top-level map of the
  benchmarking strands.
- [`../README.md`](../README.md) — the `bench` harness behind the manual EC2 job.
- [`../SCHEMA.md`](../SCHEMA.md) — the `RESULT_JSON:` contract behind every
  ledger row.
