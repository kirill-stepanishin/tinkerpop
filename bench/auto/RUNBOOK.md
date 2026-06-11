<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file. Apache License 2.0.
-->

# GLV Perf Funnel — Operator Runbook

Autonomous, quality-first pipeline that **discovers**, implements, gates, benchmarks, and
**adversarially verifies** optimizations for the gremlin-python GraphBinary deserialization hot
path — then hands you a set of **independent branches** to review.

**What you get:** survivors sorted into three buckets, each a single-purpose branch `auto/cand-<id>`:

| Bucket | Meaning | Your action |
|---|---|---|
| `cleanWinners` | pure-Python, ≥5% total-CPU drop, no contract break, all tests green, skeptic-cleared | mergeable today — review & merge |
| `breaksContract` | same, but changes a public API / custom-serializer contract | your major-version judgment call |
| `cextCandidates` | C-extension; compiled & loaded, tests green, wall-clock OK | needs your **deterministic external benchmark** before trusting the speedup |

**Nothing is merged, combined, or pushed.** You review each diff and merge the ones you want, separately.

---

## 0. Mental model

A funnel: cheap discovery fans out wide; the expensive, contended tail runs one-at-a-time.

```
P0 Setup        self-seeding, fail-fast rig + baseline (in-workflow)          ── 1 agent
P1 Research     wide diverse-lens idea generation (tiny → big → C-ext)        ── parallel
P2 Investigate  deep per-candidate study; ruthless prune; rank to a narrow tail── parallel
P3 Implement    1 agent/candidate, own worktree+branch; code-repair; unit gate ── parallel
P4 Review       independent correctness + invariant check (before mvn)        ── parallel
P5 Correctness  mvn clean install (integration + feature)                     ── ONE AT A TIME
P6 Benchmark    interleaved ABAB vs FRESH baseline + yappi                     ── STRICTLY SERIAL
P7 Verify       adversarial skeptic tries to REFUTE each apparent win         ── parallel
P8 Finalize     each survivor → clean standalone branch + evidence report     ── parallel
P9 Report       ranked survivors, sorted into the three buckets               ── you review
```

**The "win" is computed, not judged.** Lane-specific, deterministic, in the script:

- **Python lane** — gate on **total profiled self-time drop ≥ 5%** (deterministic yappi; resolves
  small wins a noisy Mac can't). Wall-clock medium is only a *loose guard* (≤10% regression). Hotspot
  drop is a *diagnostic*. Total-CPU (not hotspot) catches "work merely moved elsewhere."
- **C-ext lane** — yappi can't see compiled cost, so gate on **proof the compiled module loaded**
  (not the Python fallback) **+ wall-clock same-or-better (≤3%)**. Ranked separately; you validate
  deterministically elsewhere.
- **Both** — tiny (fixed-overhead) must not regress >10%; streaming + bounded-memory must hold; the
  skeptic must fail to refute.

> **Localhost honesty.** Absolute localhost ms are not real-world numbers. Only the **relative,
> interleaved** baseline-vs-candidate delta is used, and the **yappi profile** is the anchor signal.
> Never quote raw ms as a latency figure.

**Two-tier invariants.** *Streaming* and *bounded-memory* are hard — any breach auto-prunes a
candidate. *Public-API* and *custom-serializer* breaks are allowed through but land in the
`breaksContract` bucket for your judgment, never silently shipped.

---

## 1. Prerequisites (one-time)

```bash
ls -d /Users/kiristep/dev/tinkerpop/gremlin-server/target/apache-tinkerpop-gremlin-server-*-standalone
cd /Users/kiristep/dev/tinkerpop/bench && /Users/kiristep/venv-glv-4/bin/pip install -e .
/Users/kiristep/venv-glv-4/bin/pip install yappi
# C-ext lane needs a working compiler on the host (Xcode CLT). If absent, c-ext candidates
# self-report invalid rather than producing a number — that's the correct failure.
xcode-select -p >/dev/null 2>&1 && echo "compiler OK" || echo "no compiler — c-ext lane will abort-invalid"
cd /Users/kiristep/dev/tinkerpop && git status --short   # commit WIP — candidates fork from the current branch
```

> **You do NOT capture the baseline by hand** — Phase 0 of the workflow seeds the rig and captures
> the baseline itself (and fails fast if the rig is wrong). You only ensure the prerequisites above.

---

## 2. Launch

In Claude Code:

```
Run the workflow at bench/auto/glv-perf-funnel.workflow.js
```

→ `Workflow({ scriptPath: "/Users/kiristep/dev/tinkerpop/bench/auto/glv-perf-funnel.workflow.js" })`

It runs in the background and notifies you on completion; the final message is the **Report** object.

### Override knobs via `args`

| arg | default | meaning |
|---|---|---|
| `base` | `4-glv-python-perf` | branch candidates fork from; also the baseline-arm source |
| `out` | `~/glv-auto-results` | results root |
| `serverDir` | the 4.0 standalone | where Phase 0 starts the server from, if needed |
| `python` | `~/venv-glv-4/bin/python` | interpreter (Phase 0 may repair/confirm and propagate it) |
| `allowCython` | `true` | include the C-ext lane (one candidate max) |
| `maxResearch` | `10` | portfolio breadth after synthesis |
| `implementCap` | `6` | **narrow tail** — max candidates reaching mvn/bench |
| `executions` | `5` | measured reps per bench invocation |
| `benchRounds` | `4` | ABAB rounds (baseline + candidate each) |
| `repairCheap` / `repairMvn` | `2` / `1` | code-repair attempts at unit / mvn stage |
| `totalCpuMinDrop` | `0.05` | **python gate**: required total self-time drop |
| `pyWallGuard` | `0.10` | python guard: max medium wall-clock regression |
| `cextWallTol` | `0.03` | c-ext gate: max medium wall-clock regression |
| `tinyTol` | `0.10` | both: max tiny (fixed-overhead) regression |

Examples:

```
Run bench/auto/glv-perf-funnel.workflow.js with args {"benchRounds":6,"executions":7}
Run bench/auto/glv-perf-funnel.workflow.js with args {"allowCython":false,"implementCap":4}
Run bench/auto/glv-perf-funnel.workflow.js with args {"totalCpuMinDrop":0.08}
```

### Watch progress

- `/workflows` — live phase tree (Setup → Research → Investigate → Implement → Review → Correctness → Benchmark → Verify → Finalize → Report).
- The server terminal/log shows baseline and candidate arms alternating during Benchmark.

---

## 3. What each phase does (and how to read trouble)

| Phase | You'll see | Healthy | Red flag → action |
|---|---|---|---|
| **Setup** | `Rig OK (count=6 …)` or `ABORT` | `serverReused` or server started; baseline captured | `ABORT: :8182 occupied by a non-modern server` → free the port yourself (it won't evict); `count!=6` → wrong graph config |
| **Research** | `research:lens-*` → `synthesize` | `Portfolio (N): id[lane/contract]…` | 0 ideas → baseline yappi missing; check Setup |
| **Investigate** | `investigate:<id>` | `Viable … (cap 6)` | all pruned → streaming/memory too restrictive for the ideas, or low confidence; widen `lenses` |
| **Implement** | `impl:<id>` worktrees | unit-green proceed; c-ext shows `cextBuilt` | all fail → venv deps, or no compiler (c-ext), or repair budget hit |
| **Review** | `review:<id>` | `Approved for mvn gate: k` | rejected → behavior change or touched tests; read verdict |
| **Correctness** | `mvn:<id>` serial; maybe `re-review` | `BUILD SUCCESS` | port-bind → stale stack: `cd gremlin-python && docker compose down` |
| **Benchmark** | `bench:<id>` serial; `PASS`/`fail` | python: `totalCPU -X%`; c-ext: `loaded=true` | all `fail` but CPU drops → noise/threshold; raise `benchRounds`/`executions` |
| **Verify** | `verify:<id>`; `REFUTED`/survivors | `Verified survivors: k` | all refuted → read reasons; often genuine (noise or incoherent profile) |
| **Finalize** | `finalize:<id>` | clean standalone branches | `clean=false` → stray edits; inspect the branch |
| **Report** | final JSON | three populated buckets | empty everywhere → see §6 |

---

## 4. Collect results

Under `~/glv-auto-results/`:

```
baseline/         ledger.csv · yappi-medium-yappi-cpu.txt        ← Phase-0 anchor + research seed (NOT the gate)
cand-<id>/
  REPORT.md                                                       ← human-readable evidence per survivor
  cand/   ledger.csv · cand-yappi-medium-r*-yappi-cpu.txt         ← candidate ABAB arm
  base/   ledger.csv · base-yappi-medium-r*-yappi-cpu.txt         ← FRESH baseline arm (the gate's comparison)
```

The **gate compares `cand/` vs `base/`** (interleaved, same session) — *not* against the Phase-0
`baseline/`, which is only the anchor you read for narration.

Sweep all survivor reports:

```bash
cd ~/glv-auto-results && for d in cand-*; do echo "== $d =="; sed -n '1,40p' "$d/REPORT.md" 2>/dev/null; done
```

Confirm a python winner's profile drop is real (the anchor signal):

```bash
id=b-hybrid
echo "candidate arm:"; ls cand-$id/cand/*yappi-medium*.txt
echo "baseline arm:";  ls cand-$id/base/*yappi-medium*.txt
# eyeball the targeted hotspot's tsub (self-time) falling, and the SUM of tsub falling ≥5%:
grep -E "DataType|to_object|read_object|from_bytes" cand-$id/cand/*yappi-medium-r1*.txt | head
```

Inspect a branch before merging:

```bash
git -C /Users/kiristep/dev/tinkerpop diff 4-glv-python-perf..auto/cand-<id> -- gremlin-python
git -C /Users/kiristep/dev/tinkerpop log --oneline 4-glv-python-perf..auto/cand-<id>   # should be ONE clean commit
```

---

## 5. Decide & merge — each survivor SEPARATELY

The Report lists three buckets of **independent branches**. They are not combined; some may touch the
same file. The workflow stops here — you merge.

**`cleanWinners`** — review the diff, then:

```bash
cd /Users/kiristep/dev/tinkerpop
git checkout 4-glv-python-perf
git merge --no-ff auto/cand-<id>          # one at a time
# re-run a quick baseline bench on the merged branch to record the realized gain (see §7)
```

**`breaksContract`** — same, but first decide whether the speedup justifies the contract change
(major version / changelog / deprecation). The branch's `REPORT.md` names exactly what it breaks.

**`cextCandidates`** — **do not trust the in-workflow number.** It only proves: compiles, the
compiled module loads (not the fallback), tests green, wall-clock not worse. Run your own
deterministic benchmark in a clean environment, then decide — including the packaging implications
(manylinux/macOS/Windows wheels, sdist fallback, compiler dependency for source installs).

**Stacking** is your call (the workflow deliberately doesn't combine): if two winners touch different
hotspots they likely add; if they touch the same one they may be substitutes. Merge one, re-bench,
then rebase the next on top and re-bench to see the true combined gain.

---

## 6. When the Report is empty

Work back up the funnel using the `funnel` object in the Report (it lists which ids reached each stage):

| Last stage reached | Likely cause | Action |
|---|---|---|
| `portfolio` only | research produced ideas but investigation killed all | invariants too strict for the ideas, or low confidence — widen `lenses`, raise `maxResearch` |
| `viable` but not `approved` | implementations changed behavior / failed unit | read Implement+Review drops in the log |
| `approved` but not `mvnGreen` | integration/feature failures | inspect `failTail`; often server-dependent |
| `mvnGreen` but not `apparentWinners` | no 5% CPU drop / wall-clock regressed | localhost noise or genuinely flat — raise `benchRounds`/`executions`, or accept the ideas weren't wins |
| `apparentWinners` but all `refuted` | skeptic found noise/behavior/incoherent-profile | read `refuted[].reasons` — usually correct to trust |

---

## 7. Resume / stop / clean up

**Resume** (after pause/kill/script-edit; the unchanged prefix replays from cache):

```
Resume: Workflow({ scriptPath: ".../glv-perf-funnel.workflow.js", resumeFromRunId: "wf_…" })
```
(runId is in the original Workflow result and `/workflows`.)

**Stop:** `/workflows` → stop, or ask Claude to `TaskStop` it.

**Re-run the baseline by hand** (e.g., to record a realized gain post-merge):

```bash
cd /Users/kiristep/dev/tinkerpop/bench
GREMLIN_PROFILE=yappi-cpu GREMLIN_PROFILE_OUT=/tmp/post-merge/yappi-medium \
  bench run --glv python --test protocol-overhead --size medium --host localhost \
  --label post-merge --executions 5 --output-dir /tmp/post-merge
```

**Clean up** after merging what you want:

```bash
cd /Users/kiristep/dev/tinkerpop
git worktree list
git worktree remove --force <path>          # per auto/cand-* worktree the run created
git branch -D auto/cand-<id>                 # branches you rejected
docker compose -f gremlin-python/docker-compose.yml down   # if a stack lingers
# stop the server Phase 0 started: find it via `lsof -i :8182` and Ctrl+C / kill its console
```

---

## 8. Safety properties (by construction)

- **Never** pushes, opens a PR, or touches `master`/`4-glv-python-perf` — only creates `auto/cand-*` branches.
- **Tests are never modified to pass** — the repair loop fixes only the candidate's own code, and any
  repaired diff re-enters Review; Review auto-rejects a touched test.
- **Setup applies only light fixes** (venv install, start the modern server) and **aborts** rather than
  evicting a port occupant, pruning Docker, or editing server config.
- **Hard invariants** (streaming, bounded memory) auto-prune; they cannot be traded for speed.
- **C-ext fallback can't masquerade** as a win — a load assertion fails the candidate if the compiled
  module isn't the one imported.
- **The gate is arithmetic**, not LLM judgment; the adversarial Verify pass defaults to *refuted* on
  uncertainty.

---

## 9. One-screen cheat sheet

```bash
# 1. prereqs (one-time)
cd tinkerpop/bench && ~/venv-glv-4/bin/pip install -e . && ~/venv-glv-4/bin/pip install yappi
cd .. && git status --short        # commit WIP first

# 2. launch (in Claude Code) — Phase 0 seeds the rig + baseline itself, fails fast
#   Run the workflow at bench/auto/glv-perf-funnel.workflow.js
#   watch: /workflows

# 3. collect
cd ~/glv-auto-results && for d in cand-*; do echo "== $d =="; sed -n '1,30p' "$d/REPORT.md"; done

# 4. merge — SEPARATELY, one branch each, by bucket (clean → breaksContract → cext-after-external-bench)
git checkout 4-glv-python-perf && git merge --no-ff auto/cand-<id>
```
