/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file. Apache License 2.0.
 *
 * ============================================================================
 *  GLV PERF FUNNEL  —  autonomous, quality-first optimization pipeline for the
 *  gremlin-python GraphBinary deserialization hot path.
 * ============================================================================
 *
 *  Run with the Claude Code `Workflow` tool (background + resumable):
 *    Workflow({ scriptPath: ".../bench/auto/glv-perf-funnel.workflow.js" })
 *
 *  GOAL (co-equal): heavy DISCOVERY of optimization ideas across the whole size
 *  spectrum (tiny tweaks → large refactors → a C-extension lane) AND rigorous
 *  VALIDATION, so that each idea that survives lands as its OWN standalone,
 *  reviewed, gated, benchmarked, adversarially-verified branch for the human to
 *  review. Nothing is merged or combined. Never pushes / PRs / touches master.
 *
 *  This script encodes the decisions from the design interview:
 *   1  Purpose: discovery AND validation, co-equal. Known winners (B-hybrid, C1)
 *      are seeded as a floor to beat, not the deliverable.
 *   2  Accept bar: a *measured positive improvement* of 5% (not mere no-regression).
 *   3  Stacking: NOT handled here — separate branches; the human discovers stacks.
 *   4  Gate metric (python lane): TOTAL profiled self-time drop >= 5% (deterministic
 *      yappi). Wall-clock latency is only a loose regression GUARD. Hotspot drop is
 *      a DIAGNOSTIC, never the gate (catches "work merely moved elsewhere").
 *   5  C-ext/Cython lane: KEPT but profile-incomparable — yappi can't see compiled
 *      cost. Gated on wall-clock same-or-better (+ load proof), ranked SEPARATELY;
 *      the human does deterministic benchmarking elsewhere.
 *   6  C-ext build proof: must build in-place AND assert the compiled module is the
 *      one imported; a silent pure-Python fallback => result is INVALID, not a win.
 *   7  Repair loop: may fix the candidate's OWN code (build + failing-test bugs);
 *      must NEVER weaken/modify a test; every repaired diff re-enters Review.
 *   8  Repair bound: <=2 attempts at cheap stages (unit/build), <=1 at the mvn gate;
 *      exhausted => dropped-with-reason. Budget is the runaway backstop.
 *   9  Breadth: wide research -> ruthless investigation prune -> narrow expensive
 *      tail (<= IMPLEMENT_CAP candidates reach mvn/bench).
 *  10  Baseline freshness: the gate compares each candidate against a FRESH baseline
 *      arm re-measured interleaved (ABAB) in the same session/machine-state — never
 *      against the one-time setup profile.
 *  11  Setup baseline is folded in (Phase 0 below): self-seeding, fail-fast; its
 *      profile is the RESEARCH SEED + human anchor, NOT the gate input.
 *  12  Rig validity predicate: server up AND g.V().count()==6 AND a bench row parses
 *      AND a yappi .txt is written. "Green but wrong rig" is rejected.
 *  13  Env repair is LIGHT: confirm/seed the venv; DETECT-AND-REUSE a healthy modern
 *      server already on :8182, else start one; never retarget the port (the bench
 *      harness can't pass --port); if light fixes don't work, ABORT the whole run.
 *  14  Invariants are TWO-TIER: streaming + bounded-memory are HARD (violation =>
 *      auto-prune); public-API + custom-serializer breaks are IMPLEMENTED, MEASURED,
 *      and SURFACED in a separate "breaks-contract" bucket for human judgment.
 */

export const meta = {
  name: 'glv-perf-funnel',
  description: 'Discover, implement, gate (mvn+tests), interleaved-benchmark and adversarially verify gremlin-python deser optimizations; each survivor on its own branch, sorted into clean / breaks-contract / c-ext buckets',
  phases: [
    { title: 'Setup',       detail: 'self-seeding fail-fast rig: detect/reuse or start modern server, seed venv, capture baseline (research seed + anchor)' },
    { title: 'Research',    detail: 'wide diverse-lens idea generation (small tweaks -> big refactors -> C-ext)', model: 'opus' },
    { title: 'Investigate', detail: 'per-candidate deep risk/benefit/breaking-change; ruthless prune; classify invariants (two-tier)', model: 'opus' },
    { title: 'Implement',   detail: 'one agent per candidate in own worktree; code-repair loop; unit gate; C-ext build+load proof' },
    { title: 'Review',      detail: 'independent correctness + invariant review before the expensive gate', model: 'opus' },
    { title: 'Correctness', detail: 'mvn clean install incl. integration + feature — strictly serial; <=1 code-repair', model: 'opus' },
    { title: 'Benchmark',   detail: 'interleaved ABAB vs fresh baseline; python=total-CPU gate, c-ext=wall-clock gate — serial' },
    { title: 'Verify',      detail: 'adversarial skeptic tries to refute each apparent win', model: 'opus' },
    { title: 'Finalize',    detail: 'each survivor a clean standalone branch; sort into clean / breaks-contract / c-ext buckets' },
    { title: 'Report',      detail: 'ranked survivors per bucket, one branch each' },
  ],
}

// ---- knobs (override via `args`; see RUNBOOK) ---------------------------------
const REPO       = (args && args.repo)   || '/Users/kiristep/dev/tinkerpop'
const OUT        = (args && args.out)    || '/Users/kiristep/glv-auto-results'
const BASE       = (args && args.base)   || '4-glv-profiling'      // candidates fork from here; also the baseline arm source
const HOST       = (args && args.host)   || 'localhost'
const VENV_PY    = (args && args.python) || '/Users/kiristep/venv-glv-4/bin/python'
const SERVER_STANDALONE = (args && args.serverDir) ||
  `${REPO}/gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone`
const RESEARCH_LENSES = (args && args.lenses) || [
  'small, low-risk tweaks (bound-method hoisting, cheaper int unpack via int.from_bytes for integers only, local caching)',
  'enum/type-code dispatch (aenum DataType construction + __hash__; int-keyed dispatch cache)',
  'the read/buffer path (struct lambda elimination, is_null cost, read sizing) WITHOUT breaking streaming',
  'result object construction (Vertex/VertexProperty/Path: __slots__, fewer attribute writes, lazy fields)',
  'large structural / algorithmic refactor of the reader (per-type codegen, flatter dispatch, fewer Python frames)',
  'C-extension / Cython acceleration of the innermost decode loop (the high-ceiling lane)',
]
const ALLOW_CYTHON = (args && args.allowCython) !== false   // default ON
const MAX_RESEARCH_CANDS = (args && args.maxResearch) || 10  // breadth after synthesis
const IMPLEMENT_CAP      = (args && args.implementCap) || 6  // narrow expensive tail (decision 9)
const EXECUTIONS   = (args && args.executions)   || 5        // measured reps per bench invocation
const WARMUPS      = (args && args.warmups)      || 2
const BENCH_ROUNDS = (args && args.benchRounds)  || 4        // ABAB rounds (baseline + candidate each)
const REPAIR_CHEAP = (args && args.repairCheap)  || 2        // attempts at unit/build stage
const REPAIR_MVN   = (args && args.repairMvn)    || 1        // attempts at the mvn gate

// ---- accept thresholds (decisions 2/4/5) --------------------------------------
const TOTAL_CPU_MIN_DROP  = (args && args.totalCpuMinDrop)  || 0.05  // python lane GATE: total self-time must fall >= 5%
const PY_WALLCLOCK_GUARD  = (args && args.pyWallGuard)      || 0.10  // python lane GUARD: medium wall-clock may regress at most 10%
const CEXT_WALLCLOCK_TOL  = (args && args.cextWallTol)      || 0.03  // c-ext lane GATE: medium wall-clock must be same-or-better within 3%
const TINY_REGRESS_TOL    = (args && args.tinyTol)          || 0.10  // both lanes GUARD: tiny (fixed-overhead) may regress at most 10%

// ---- schemas ------------------------------------------------------------------
const SETUP = {
  type: 'object', required: ['ok'], properties: {
    ok: { type: 'boolean', description: 'true only if the rig is valid AND a baseline was captured' },
    python: { type: 'string', description: 'confirmed/repaired interpreter to use for ALL downstream bench/pytest' },
    host: { type: 'string' },
    serverReused: { type: 'boolean', description: 'true if a healthy modern server already on :8182 was reused' },
    modernGraphCount: { type: 'number', description: 'g.V().count() — MUST equal 6 (validity predicate)' },
    baselineMediumWall: { type: 'number', description: 'anchor: baseline medium median sec/req' },
    baselineTinyWall: { type: 'number' },
    baselineTotalCpu: { type: 'number', description: 'anchor: summed yappi self-time (tsub) of baseline medium' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    abortReason: { type: 'string', description: 'if ok=false: e.g. ":8182 occupied by a non-modern server", "venv unfixable", "count!=6"' },
    notes: { type: 'string' },
  },
}
const RESEARCH = {
  type: 'object', required: ['items'], properties: { items: { type: 'array', items: {
    type: 'object', required: ['title', 'hotspot', 'approach', 'riskTier', 'lane', 'expectedPct', 'breaksContractGuess'],
    properties: {
      title: { type: 'string' }, hotspot: { type: 'string', description: 'yappi function(s) targeted' },
      approach: { type: 'string', description: 'concrete change, 2-5 sentences' },
      riskTier: { type: 'string', enum: ['safe', 'medium', 'restructure'] },
      lane: { type: 'string', enum: ['python', 'cext'] },
      expectedPct: { type: 'number', description: 'rough total-CPU reduction on the medium path' },
      microBenchNote: { type: 'string', description: 'cheap in-process timing you actually ran' },
      breaksContractGuess: { type: 'string', enum: ['none', 'public-api', 'custom-serializer', 'streaming', 'memory'] },
      invariantsAtRisk: { type: 'array', items: { type: 'string' } },
    } } } },
}
const PORTFOLIO = {
  type: 'object', required: ['items'], properties: { items: { type: 'array', items: {
    type: 'object', required: ['id', 'title', 'hotspot', 'approach', 'riskTier', 'lane', 'expectedPct', 'standaloneRationale', 'breaksContract'],
    properties: {
      id: { type: 'string', description: 'unique kebab slug; becomes branch/label auto/cand-<id>' },
      title: { type: 'string' }, hotspot: { type: 'string' }, approach: { type: 'string' },
      riskTier: { type: 'string', enum: ['safe', 'medium', 'restructure'] },
      lane: { type: 'string', enum: ['python', 'cext'] },
      expectedPct: { type: 'number' }, microBenchNote: { type: 'string' },
      standaloneRationale: { type: 'string', description: 'why this is valuable & mergeable entirely on its own' },
      breaksContract: { type: 'string', enum: ['none', 'public-api', 'custom-serializer'], description: 'streaming/memory breakers must NOT appear here — they are dropped in synthesis' },
      invariantsAtRisk: { type: 'array', items: { type: 'string' } },
    } } } },
}
const INVESTIGATION = {
  type: 'object', required: ['id', 'viable', 'standalone', 'invariantClass', 'confidence', 'summary'], properties: {
    id: { type: 'string' },
    viable: { type: 'boolean', description: 'false => pruned before implementation' },
    standalone: { type: 'boolean', description: 'is it valuable & mergeable entirely on its own (required to proceed)' },
    invariantClass: { type: 'string', enum: ['safe', 'breaks-public-api', 'breaks-custom-serializer', 'breaks-streaming', 'breaks-memory'],
      description: 'breaks-streaming/breaks-memory => HARD prune (set viable=false). breaks-public-api/custom-serializer => keep, flagged for human.' },
    confidence: { type: 'number', description: '0..1 — used to rank into the narrow tail' },
    expectedBenefit: { type: 'string' }, recommendedVariant: { type: 'string', description: 'the safest form that still gets the win' },
    riskRegister: { type: 'array', items: { type: 'object', properties: {
      risk: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' }, mitigation: { type: 'string' } } } },
    breakingChanges: { type: 'array', items: { type: 'string' } },
    invariantAnalysis: { type: 'string', description: 'streaming/memory/public-API/custom-serializer — what holds, what breaks (file:line)' },
    testImpact: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const BUILD = {
  type: 'object', required: ['id', 'unitGreen', 'summary'], properties: {
    id: { type: 'string' }, unitGreen: { type: 'boolean' },
    repairAttempts: { type: 'number', description: 'code-only repairs used (<= REPAIR_CHEAP)' },
    touchedTests: { type: 'boolean', description: 'MUST be false — tests were not modified' },
    cextBuilt: { type: 'boolean', description: 'c-ext lane only: compiled in-place' },
    cextLoadAssertion: { type: 'string', description: 'c-ext lane only: how the loaded module is asserted to be the compiled one' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    diffStat: { type: 'string' }, unitOutputTail: { type: 'string' }, summary: { type: 'string' },
  },
}
const REVIEW = {
  type: 'object', required: ['id', 'approved', 'verdict'], properties: {
    id: { type: 'string' }, approved: { type: 'boolean', description: 'false => dropped before the expensive gate' },
    touchedTests: { type: 'boolean', description: 'true => auto-reject (tests must not be weakened)' },
    correctnessIssues: { type: 'array', items: { type: 'string' } },
    invariantIssues: { type: 'array', items: { type: 'string' }, description: 'streaming/memory issues => reject; api/custom-serializer => note, not reject' },
    behaviorEquivalence: { type: 'string', description: 'argues identical deserialized objects across all types' },
    verdict: { type: 'string' },
  },
}
const MVN = {
  type: 'object', required: ['id', 'fullSuiteGreen', 'summary'], properties: {
    id: { type: 'string' }, fullSuiteGreen: { type: 'boolean' },
    integrationGreen: { type: 'boolean' }, featureGreen: { type: 'boolean' },
    repairedAtMvn: { type: 'boolean', description: 'true if code (never a test) was changed to pass the gate => triggers re-review' },
    failTail: { type: 'string' }, summary: { type: 'string' },
  },
}
const BENCH = {
  type: 'object', required: ['id', 'ok', 'lane', 'invariantsHold',
    'candidateMediumWallReps', 'baselineMediumWallReps', 'candidateTinyWallReps', 'baselineTinyWallReps'], properties: {
    id: { type: 'string' }, lane: { type: 'string', enum: ['python', 'cext'] },
    ok: { type: 'boolean', description: 'true only if every reps array has BENCH_ROUNDS numbers and required profiles/proofs captured' },
    candidateMediumWallReps: { type: 'array', items: { type: 'number' }, description: 'sec/req per ABAB round, candidate medium' },
    baselineMediumWallReps:  { type: 'array', items: { type: 'number' }, description: 'sec/req per ABAB round, FRESH baseline arm medium' },
    candidateTinyWallReps:   { type: 'array', items: { type: 'number' } },
    baselineTinyWallReps:    { type: 'array', items: { type: 'number' } },
    totalCpuDropPct: { type: 'number', description: 'PYTHON lane: fractional drop in TOTAL yappi self-time, candidate vs fresh baseline arm (0..1; may be negative). N/A for c-ext.' },
    hotspotDropPct:  { type: 'number', description: 'DIAGNOSTIC only: self-time drop of the targeted hotspot (0..1)' },
    cextLoaded: { type: 'boolean', description: 'C-EXT lane: true iff the load-assertion proved the COMPILED module was imported (not a fallback)' },
    invariantsHold: { type: 'boolean', description: 'streaming + bounded-memory still hold (HARD). Re-verified statically here.' },
    breaksContractObserved: { type: 'string', enum: ['none', 'public-api', 'custom-serializer'], description: 'confirmed from the diff' },
    invariantEvidence: { type: 'string' }, ledgerPath: { type: 'string' }, profilePath: { type: 'string' }, notes: { type: 'string' },
  },
}
const VERIFY = {
  type: 'object', required: ['id', 'refuted', 'confidence', 'reasons'], properties: {
    id: { type: 'string' }, refuted: { type: 'boolean', description: 'true => the apparent win does not survive scrutiny' },
    confidence: { type: 'number' }, reasons: { type: 'array', items: { type: 'string' } },
    noiseRisk: { type: 'string', description: 'is the gain within paired round-to-round spread?' },
    behaviorChangeRisk: { type: 'string', description: 'does the diff fake a win by changing observable behavior?' },
    profileCoherent: { type: 'boolean', description: 'python lane: does total-CPU drop corroborate the hotspot drop (not just shuffled)?' },
    invariantRecheck: { type: 'string' },
  },
}
const FINALIZE = {
  type: 'object', required: ['id', 'branch', 'clean'], properties: {
    id: { type: 'string' }, branch: { type: 'string' },
    clean: { type: 'boolean', description: 'branch is a single-purpose, mergeable diff vs BASE with one clean commit' },
    reportPath: { type: 'string' }, commitMessage: { type: 'string' }, diffStat: { type: 'string' },
  },
}

// ---- helpers (deterministic; the "win" is computed here, not judged) ----------
function median(xs) {
  const a = (xs || []).filter(x => typeof x === 'number' && x > 0).slice().sort((p, q) => p - q)
  if (!a.length) return null
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
function bucketOf(c, m) {
  if (c.lane === 'cext') return 'cext'                                  // profile-incomparable; external validation
  const bc = (m && m.breaksContractObserved) || c.breaksContract || 'none'
  return bc !== 'none' ? 'breaks-contract' : 'clean'                    // two-tier: api/custom-serializer => human judgment
}
// Lane-specific accept predicate over RAW interleaved measurements.
function benchVerdict(b, c) {
  if (!b || !b.ok) return { pass: false, why: 'measurement incomplete' }
  if (!b.invariantsHold) return { pass: false, why: 'streaming/bounded-memory invariant broken (HARD)' }
  const cmW = median(b.candidateMediumWallReps), bmW = median(b.baselineMediumWallReps)
  const ctW = median(b.candidateTinyWallReps),   btW = median(b.baselineTinyWallReps)
  if (!(cmW && bmW && ctW && btW)) return { pass: false, why: 'missing wall-clock medians' }
  const tinyOk = ctW <= btW * (1 + TINY_REGRESS_TOL)
  if (c.lane === 'cext') {
    // Decision 5/6: yappi can't see compiled cost => gate on LOAD PROOF + wall-clock same-or-better.
    const loaded = b.cextLoaded === true
    const wallOk = cmW <= bmW * (1 + CEXT_WALLCLOCK_TOL)
    const pass = loaded && wallOk && tinyOk
    return { pass, lane: 'cext', loaded, wallOk, tinyOk, cmW, bmW,
      why: pass ? 'cext-pass (needs external deterministic validation)'
        : (!loaded ? 'cext NOT loaded (fell back to python => INVALID)' : !wallOk ? 'cext wall-clock regressed' : 'tiny regressed') }
  }
  // Decision 4: python lane gate = TOTAL profiled self-time drop >= 5%; wall-clock is a loose guard.
  const cpuDrop = b.totalCpuDropPct || 0
  const cpuOk = cpuDrop >= TOTAL_CPU_MIN_DROP
  const wallGuardOk = cmW <= bmW * (1 + PY_WALLCLOCK_GUARD)
  const pass = cpuOk && wallGuardOk && tinyOk
  return { pass, lane: 'python', cpuDrop, cpuOk, wallGuardOk, tinyOk, cmW, bmW,
    why: pass ? 'python-pass'
      : (!cpuOk ? `total-CPU drop ${(cpuDrop * 100).toFixed(1)}% < ${TOTAL_CPU_MIN_DROP * 100}%`
        : !wallGuardOk ? 'medium wall-clock regressed beyond guard' : 'tiny regressed') }
}

// =================================================================================
// PHASE 0 — SETUP. Self-seeding, fail-fast. Light env fixes only; detect-and-reuse
// a healthy modern server or start one; validity predicate count==6; capture the
// baseline (research seed + human anchor). Abort the whole run if it can't get right.
phase('Setup')
log('Setup: validating/seeding the rig (light fixes only; reuse-or-start the modern server).')

const rig = await agent(
`Bring up and VALIDATE the local benchmark rig for the gremlin-python perf funnel, then capture a
baseline. Apply ONLY light, idempotent fixes. If a light fix is not enough, ABORT (ok=false) — do
NOT take destructive or heavy actions.

1) PYTHON/venv (light fix allowed): confirm ${VENV_PY} runs and imports aiohttp, aenum, yappi, pytest.
   If yappi or the bench package is missing, you MAY: ${VENV_PY} -m pip install yappi  and
   (cd ${REPO}/bench && ${VENV_PY} -m pip install -e .). Report the working interpreter in 'python'.
2) SERVER on ${HOST}:8182 — DETECT-AND-REUSE, else start, NEVER retarget the port:
   - Probe: curl -s -XPOST -H 'Content-Type: application/json' -d '{"gremlin":"g.V().count()"}' http://${HOST}:8182
   - If it answers AND the count == 6 (modern graph): REUSE it (serverReused=true). Skip starting one.
   - If NOTHING is listening on 8182: start the server from ${SERVER_STANDALONE} with
     'bin/gremlin-server.sh console conf/gremlin-server-modern.yaml' in the BACKGROUND; wait (retry+backoff)
     until it answers, then re-probe the count.
   - If 8182 is occupied by something that is NOT a healthy modern (count!=6) 4.0 server: ABORT
     (ok=false, abortReason names the conflict). Do NOT kill it, do NOT prune docker, do NOT edit the
     server yaml — it may be the operator's. The bench harness cannot use a different port, so a wrong
     occupant is unfixable by a light fix.
3) VALIDITY PREDICATE (all must hold or ok=false): server answers AND modernGraphCount==6 AND a baseline
   medium bench row PARSES AND a yappi .txt is WRITTEN (steps below).
4) CAPTURE BASELINE (research seed + human anchor — NOT the gate input). From ${REPO}/bench:
     mkdir -p ${OUT}/baseline
     GREMLIN_PROFILE=yappi-cpu GREMLIN_PROFILE_OUT=${OUT}/baseline/yappi-medium \\
       <python> -m ... or: bench run --glv python --test protocol-overhead --size medium \\
         --host ${HOST} --label baseline --executions ${EXECUTIONS} --warmups ${WARMUPS} --output-dir ${OUT}/baseline
     bench run --glv python --test protocol-overhead --size tiny --host ${HOST} --label baseline \\
         --executions ${EXECUTIONS} --warmups ${WARMUPS} --output-dir ${OUT}/baseline
   Run bench in the BACKGROUND and poll (medium can exceed the 10-min Bash cap). Use the working
   interpreter for the bench package. Then read ${OUT}/baseline/ledger.csv (median column) for
   baselineMediumWall and baselineTinyWall, and sum the tsub column of ${OUT}/baseline/yappi-medium-yappi-cpu.txt
   for baselineTotalCpu.
Report the full structured object. ok=true ONLY if every validity-predicate clause held and the
baseline artifacts exist. Propagate the working 'python' and 'host' — all downstream agents will use them.`,
  { phase: 'Setup', schema: SETUP })

if (!rig || !rig.ok) {
  log(`ABORT: rig setup failed — ${rig && rig.abortReason}`)
  return { aborted: true, reason: (rig && rig.abortReason) || 'setup failed', rig }
}
const PY = rig.python || VENV_PY
const HOSTR = rig.host || HOST
log(`Rig OK (count=${rig.modernGraphCount}, server ${rig.serverReused ? 'reused' : 'started'}). Anchor: medium ${rig.baselineMediumWall}s, totalCPU ${rig.baselineTotalCpu}. python=${PY}`)

// =================================================================================
// PHASE 1 — RESEARCH. Wide, diverse-lens generation (decision 9: breadth is cheap here).
phase('Research')
const SHARED =
`gremlin-python GraphBinary DESERIALIZATION hot path (repo ${REPO}, pkg gremlin-python/src/main/python).
Ground truth from prior deep investigation (verify by reading source + the baseline profile at
${OUT}/baseline/yappi-medium-yappi-cpu.txt):
- to_object/read_object dispatch in structure/io/graphbinaryV4.py; aenum DataType (~15% CPU:
  DataType(bt) construction + __hash__); shared unpack lambda at graphbinaryV4.py:86 (~6%); is_null;
  result-object construction; AiohttpSyncStream.read (the 64KB chunk buffer is ALREADY merged).
- KNOWN-GOOD floors to beat: B-HYBRID (private {int:deserializer} cache built in GraphBinaryReader.__init__
  from the enum-keyed self.deserializers; hot path uses it; KeyError->re-raise ValueError to keep the
  contract; public maps stay enum-keyed) ~15% zero-break; C1 int.from_bytes for INTEGER unpackers only
  (floats/doubles stay on struct) ~6% bit-exact.
- HARD invariants (violation => the idea is auto-pruned at Investigate): (1) incremental streaming
  (connection.py _receive yields per object), (2) bounded memory (NO whole-body materialization;
  do NOT propose io.BytesIO(read_body) or any whole-body buffering).
- SOFT invariants (allowed but FLAGGED for human judgment, not auto-killed): public-API changes
  (DataType enum identity, deserializer_map/serializer_map key TYPES) and custom-serializer
  extensibility (objectify(cls,buff,reader,nullable) + a .read(n) buff). If an idea needs one of these,
  say so via breaksContractGuess.
Read: structure/io/graphbinaryV4.py, driver/serializer.py, driver/connection.py, driver/aiohttp/transport.py,
tests/unit/structure/io/*, tests/unit/driver/test_http_streaming.py.`

const lensFindings = await parallel(RESEARCH_LENSES
  .filter(l => ALLOW_CYTHON || !/c-extension|cython/i.test(l))
  .map((lens, i) => () => agent(
`${SHARED}

YOUR LENS: ${lens}.
Generate concrete ideas ONLY within this lens — from tiny tweaks to large refactors as the lens implies.
For each: exact yappi hotspot targeted, concrete approach, riskTier, lane ('python' or 'cext'),
rough expectedPct on the MEDIUM path, breaksContractGuess, invariants at risk, and (strongly preferred)
a cheap in-process micro-benchmark you actually ran with timing in microBenchNote.
${ALLOW_CYTHON ? '' : 'Do NOT propose c-ext ideas (lane must be python).'}
Be generous — this is the wide discovery pass. Return ONLY the structured object.`,
    { phase: 'Research', label: `research:lens-${i + 1}`, schema: RESEARCH, model: 'opus' })))

const allIdeas = lensFindings.filter(Boolean).flatMap(r => r.items || [])
log(`Raw ideas: ${allIdeas.length} across ${RESEARCH_LENSES.length} lenses. Synthesizing…`)

// Barrier justified: dedup needs ALL lens findings at once.
const portfolio = await agent(
`${SHARED}

Raw ideas from independent research lenses (JSON):
${JSON.stringify(allIdeas)}

Synthesize a deduped PORTFOLIO of at most ${MAX_RESEARCH_CANDS} candidates:
- Merge duplicates; keep the strongest framing of each DISTINCT idea; span riskTiers small->large.
- DROP any idea whose breaksContractGuess is 'streaming' or 'memory' (HARD invariants — not allowed).
- For survivors, set breaksContract to 'none' | 'public-api' | 'custom-serializer'.
- Each candidate MUST be independently valuable & mergeable ON ITS OWN (standaloneRationale); we put
  each on its OWN branch and never combine them. Two candidates may touch the same file — fine.
- Assign a unique kebab id. Include the known-good B-hybrid and C1 as candidates if not already present.
- ${ALLOW_CYTHON ? 'At most ONE c-ext (lane=cext) candidate.' : 'No c-ext candidates.'}
Return ONLY the structured object.`,
  { phase: 'Research', label: 'research:synthesize', schema: PORTFOLIO, model: 'opus' })

let candidates = (portfolio.items || [])
  .filter(c => ALLOW_CYTHON ? true : c.lane !== 'cext')
  .slice(0, MAX_RESEARCH_CANDS)
if (!candidates.length) return { error: 'no candidates from research', allIdeas, rig }
log(`Portfolio (${candidates.length}): ${candidates.map(c => `${c.id}[${c.lane}${c.breaksContract !== 'none' ? '/' + c.breaksContract : ''}]`).join(', ')}`)

// =================================================================================
// PHASE 2 — INVESTIGATE. Deep per-candidate study; ruthless prune; two-tier invariant
// classification; rank into the narrow tail (decision 9/14).
phase('Investigate')
const investigations = await parallel(candidates.map(c => () => agent(
`${SHARED}

Deeply investigate candidate "${c.id}" — ${c.title}.
Hotspot: ${c.hotspot}. Lane: ${c.lane}. Approach: ${c.approach}. Risk: ${c.riskTier}. Declared breaksContract: ${c.breaksContract}.

Produce a rigorous, citation-backed (file:line) study like a senior reviewer:
- expectedBenefit and recommendedVariant (safest form that still gets the win),
- a risk register (risk/severity/evidence/mitigation), explicit breakingChanges,
- invariantClass — classify precisely:
    'breaks-streaming' or 'breaks-memory'  => you MUST set viable=false (HARD prune; these are never worth it),
    'breaks-public-api' or 'breaks-custom-serializer' => viable MAY be true (it will be implemented, measured,
        and SURFACED to the human as a contract tradeoff — do not kill it for this alone),
    'safe' => no contract impact.
- invariantAnalysis proving the above with file:line,
- testImpact (unit/integration/feature tests that exercise this),
- standalone: is it valuable & mergeable entirely on its own (MUST be true to proceed — its own branch),
- confidence (0..1).
Set viable=false (reasons in summary) if it breaks streaming/memory, is not standalone, or risk clearly
outweighs benefit. Be willing to KILL candidates — the expensive tail is narrow on purpose.
Return ONLY the structured object.`,
  { phase: 'Investigate', label: `investigate:${c.id}`, schema: INVESTIGATION, model: 'opus' })))

const invById = Object.fromEntries(investigations.filter(Boolean).map(v => [v.id, v]))
const byId = Object.fromEntries(candidates.map(c => [c.id, c]))
function contractFromClass(cls) {
  return cls === 'breaks-public-api' ? 'public-api' : cls === 'breaks-custom-serializer' ? 'custom-serializer' : 'none'
}
let viable = investigations.filter(Boolean)
  .filter(v => v.viable && v.standalone)
  .filter(v => v.invariantClass !== 'breaks-streaming' && v.invariantClass !== 'breaks-memory') // double-enforce HARD prune
  .map(v => ({ ...byId[v.id], breaksContract: contractFromClass(v.invariantClass), _confidence: v.confidence || 0 }))
  .filter(c => c.id)
  // rank into the narrow tail: confidence x expectedPct, keep top IMPLEMENT_CAP (decision 9)
  .sort((a, b) => (b._confidence * (b.expectedPct || 1)) - (a._confidence * (a.expectedPct || 1)))
  .slice(0, IMPLEMENT_CAP)
log(`Viable after investigation: ${viable.length} (cap ${IMPLEMENT_CAP}) — ${viable.map(c => c.id).join(', ') || 'none'}`)
if (!viable.length) return { error: 'no candidate survived investigation', investigations, rig }

// =================================================================================
// PHASE 3+4 — IMPLEMENT (worktree, code-repair loop, unit gate) -> independent REVIEW.
// Pipelined; both stages cheap (no server). Repaired diffs naturally re-enter Review here.
const reviewed = await pipeline(viable,
  c => agent(
`Implement candidate "${c.id}" — ${c.title} — in gremlin-python.
Target: ${c.hotspot}. Lane: ${c.lane}. Recommended variant: ${(invById[c.id] || {}).recommendedVariant || '(safest form)'}.
Approach: ${c.approach}

You are in a fresh git worktree on branch auto/cand-${c.id} (forked from ${BASE}). Work ONLY here, under
gremlin-python/src/main/python/. Make ONE clean, well-described commit — the branch must stand alone.
Preserve the HARD invariants (streaming, bounded memory). ${c.breaksContract !== 'none'
  ? `This candidate intentionally affects the SOFT contract '${c.breaksContract}'; that is allowed and will be flagged — but change nothing MORE than necessary.`
  : 'Do not change any public contract.'}

RULES:
- NEVER modify, skip, weaken, or delete a test to make things pass (touchedTests MUST be false).
- CODE-REPAIR LOOP: run the fast unit suite with ${PY}:
    cd <worktree>/gremlin-python/src/main/python
    ${PY} -m pytest tests/unit/structure/io/ tests/unit/driver/test_http_streaming.py -q
  If it fails, you MAY fix YOUR OWN code and retry, up to ${REPAIR_CHEAP} attempts total. If still red,
  set unitGreen=false and explain. Report repairAttempts.
${c.lane === 'cext' ? `- C-EXT lane: add the build (e.g. setup.py ext_modules / Cython) and BUILD IN-PLACE into the worktree
    (build_ext --inplace or equivalent) so the .so is importable from the source tree the bench launcher
    uses. Add a LOAD ASSERTION that fails loudly if the imported module is the pure-Python fallback rather
    than the compiled extension; describe it in cextLoadAssertion and set cextBuilt. If a compiler is
    unavailable, set unitGreen=false (do NOT pretend).` : ''}
Report diffStat (git diff --stat vs ${BASE}), files touched, last ~15 unit lines, touchedTests=false.
Return ONLY the structured object.`,
    { phase: 'Implement', label: `impl:${c.id}`, isolation: 'worktree', schema: BUILD,
      model: c.riskTier === 'restructure' || c.lane === 'cext' ? 'opus' : undefined }),
  (b, c) => {
    if (!b || !b.unitGreen) { log(`DROP ${c.id}: unit gate (${b && b.summary})`); return null }
    if (b.touchedTests) { log(`DROP ${c.id}: modified tests`); return null }
    if (c.lane === 'cext' && !b.cextBuilt) { log(`DROP ${c.id}: c-ext not built in-place`); return null }
    return agent(
`Independently review candidate "${c.id}" (branch auto/cand-${c.id}) BEFORE the expensive mvn gate.
You did not write it. Read the diff vs ${BASE} in the worktree.
Judge hard:
 1) Behavior-equivalence & correctness: identical deserialized objects for ALL types (ints incl.
    negative/boundary, floats, strings, null, bulked lists, maps, vertex/edge/path)? Cite the diff.
 2) Tests untouched: confirm NO test file was modified/skipped/weakened (touchedTests). If any were,
    approved=false.
 3) Invariants: streaming + bounded-memory MUST hold (issues here => approved=false). public-API /
    custom-serializer changes are NOTED in invariantIssues but do NOT by themselves cause rejection
    (this candidate's declared contract impact is '${c.breaksContract}').
approved=true ONLY if behavior-equivalent, tests untouched, and HARD invariants intact.
Return ONLY the structured object.`,
      { phase: 'Review', label: `review:${c.id}`, schema: REVIEW, model: 'opus' })
      .then(r => (r && r.approved && !r.touchedTests)
        ? { c, build: b, review: r }
        : (log(`DROP ${c.id}: review rejected — ${r && r.verdict}`), null))
  },
)
const approved = reviewed.filter(Boolean)
log(`Approved for mvn gate: ${approved.length} — ${approved.map(x => x.c.id).join(', ') || 'none'}`)
if (!approved.length) return { error: 'no candidate passed implement+review', viable: viable.map(c => c.id), rig }

// =================================================================================
// PHASE 5 — CORRECTNESS. mvn clean install (unit+integration+feature). STRICTLY SERIAL
// (Docker-orchestrated, fixed ports). <=1 code-repair at this gate; any mvn-repair
// re-enters Review (decision 7).
phase('Correctness')
const correct = []
for (const x of approved) {
  const c = x.c
  const m = await agent(
`Run the FULL gremlin-python correctness gate for candidate "${c.id}" (branch auto/cand-${c.id}):
Docker-orchestrated maven build — unit + integration + feature (radish) against a containerized server.
  cd <worktree>/gremlin-python && docker compose down || true   # clear any stale stack first
  mvn clean install -Dasciidoc.skip=true
Run in the BACKGROUND and poll (the build exceeds the 10-min Bash cap). Only one build runs at a time,
so the fixed ports are free.
CODE-REPAIR: if it fails on a CODE bug, you MAY fix YOUR OWN code (NEVER a test) and retry up to
${REPAIR_MVN} time(s); set repairedAtMvn=true if you changed code. fullSuiteGreen=true ONLY on BUILD
SUCCESS. On failure, capture the failing test/section in failTail. Return ONLY the structured object.`,
    { phase: 'Correctness', label: `mvn:${c.id}`, schema: MVN, model: 'opus' })
  if (!m || !m.fullSuiteGreen) { log(`DROP ${c.id}: mvn gate — ${m && m.summary}`); continue }
  if (m.repairedAtMvn) {
    // decision 7: a repaired diff must re-enter Review before it proceeds.
    const r2 = await agent(
`Re-review candidate "${c.id}" (branch auto/cand-${c.id}) — it was CODE-REPAIRED during the mvn gate.
Read the CURRENT diff vs ${BASE}. Same bar as before: behavior-equivalence across all types, tests
untouched (touchedTests), HARD invariants (streaming/memory) intact. approved=false on any violation.
Return ONLY the structured object.`,
      { phase: 'Review', label: `re-review:${c.id}`, schema: REVIEW, model: 'opus' })
    if (!r2 || !r2.approved || r2.touchedTests) { log(`DROP ${c.id}: re-review after mvn repair failed`); continue }
  }
  correct.push(x)
}
log(`mvn-green: ${correct.length}/${approved.length} — ${correct.map(x => x.c.id).join(', ') || 'none'}`)
if (!correct.length) return { error: 'no candidate passed mvn clean install', approved: approved.map(x => x.c.id), rig }

// =================================================================================
// PHASE 6 — BENCHMARK. Interleaved ABAB vs a FRESH baseline arm (decision 10). STRICTLY
// SERIAL (one server, fixed ports). Lane-specific gate (decision 4/5).
phase('Benchmark')
const measured = []
for (const x of correct) {
  const c = x.c
  const m = await agent(
`Benchmark candidate "${c.id}" (lane=${c.lane}) against the modern-graph server on ${HOSTR}:8182 with an
INTERLEAVED ABAB design to cancel drift. Do ${BENCH_ROUNDS} rounds; in EACH round run BOTH arms
back-to-back, for BOTH sizes, using ${PY}:
  (A) BASELINE arm from the unmodified ${BASE} tree: cd ${REPO}/bench
  (B) CANDIDATE arm from THIS worktree:             cd <worktree>/bench
(The bench launcher resolves its own worktree's profile-driver.sh, so each arm runs its own source.)

Per round, MEDIUM with profiling, then TINY:
  GREMLIN_PROFILE=yappi-cpu GREMLIN_PROFILE_OUT=${OUT}/cand-${c.id}/<arm>-yappi-medium-r<round> \\
    bench run --glv python --test protocol-overhead --size medium --host ${HOSTR} \\
      --label <arm>-${c.id} --executions ${EXECUTIONS} --warmups ${WARMUPS} \\
      --output-dir ${OUT}/cand-${c.id}/<arm>
  bench run --glv python --test protocol-overhead --size tiny --host ${HOSTR} \\
      --label <arm>-${c.id} --executions ${EXECUTIONS} --warmups ${WARMUPS} --output-dir ${OUT}/cand-${c.id}/<arm>
(arm = 'cand' or 'base'.) Run bench in the BACKGROUND and poll. Collect per-round medians (the 'median'
column of each ledger.csv row) into candidateMediumWallReps / baselineMediumWallReps / candidate/baseline
TinyWallReps (${BENCH_ROUNDS} numbers each).

${c.lane === 'cext'
  ? `C-EXT LANE: profile is INCOMPARABLE (yappi can't see compiled cost). Set totalCpuDropPct to null.
     CRITICAL: run the load assertion in the candidate arm and set cextLoaded=true ONLY if the COMPILED
     module was imported (not the pure-Python fallback). If it fell back, cextLoaded=false (=> invalid).`
  : `PYTHON LANE: from one candidate-arm and one fresh baseline-arm medium yappi .txt, compute
     totalCpuDropPct = (baselineTotalSelf - candidateTotalSelf)/baselineTotalSelf using the SUM of the
     tsub column (deterministic). Also report hotspotDropPct for "${c.hotspot}" (DIAGNOSTIC only).`}

invariantsHold + invariantEvidence: STATICALLY re-verify streaming + bounded-memory in this worktree (file:line).
breaksContractObserved: confirm from the diff ('none'|'public-api'|'custom-serializer').
ok=true only if every reps array has ${BENCH_ROUNDS} numbers and (python: both medium profiles captured /
c-ext: the load assertion ran). Return ONLY the structured object.`,
    { phase: 'Benchmark', label: `bench:${c.id}`, schema: BENCH })
  const v = benchVerdict(m, c)
  measured.push({ c, m, v })
  log(`${v.pass ? 'PASS' : 'fail'} ${c.id}[${c.lane}]: medium cand~${v.cmW}s base~${v.bmW}s` +
      (c.lane === 'cext' ? ` loaded=${m && m.cextLoaded}` : ` totalCPU -${Math.round(100 * (m && m.totalCpuDropPct || 0))}% hotspot -${Math.round(100 * (m && m.hotspotDropPct || 0))}%`) +
      ` invariants=${m && m.invariantsHold} :: ${v.why}`)
}
const apparentWinners = measured.filter(x => x.v.pass)
log(`Apparent winners: ${apparentWinners.length} — ${apparentWinners.map(x => x.c.id).join(', ') || 'none'}`)
if (!apparentWinners.length) return { error: 'no candidate passed the benchmark gate', measured: measured.map(x => ({ id: x.c.id, why: x.v.why })), rig }

// =================================================================================
// PHASE 7 — VERIFY. Adversarial skeptic per apparent win; tries to REFUTE; default to
// refuted on genuine uncertainty.
phase('Verify')
const verified = await parallel(apparentWinners.map(x => () => agent(
`Adversarially scrutinize the APPARENT win "${x.c.id}" (lane=${x.c.lane}, branch auto/cand-${x.c.id}).
Your job is to REFUTE it; approve only if you cannot. You have the diff vs ${BASE}, the raw interleaved
measurements, and the profiles under ${OUT}/cand-${x.c.id}/.

Raw measurements (sec/req per ABAB round):
  candidate medium: ${JSON.stringify((x.m || {}).candidateMediumWallReps)}
  baseline  medium: ${JSON.stringify((x.m || {}).baselineMediumWallReps)}
  candidate tiny:   ${JSON.stringify((x.m || {}).candidateTinyWallReps)}
  baseline  tiny:   ${JSON.stringify((x.m || {}).baselineTinyWallReps)}
  ${x.c.lane === 'cext' ? `cextLoaded: ${(x.m || {}).cextLoaded}` : `totalCpuDrop: ${(x.m || {}).totalCpuDropPct}  hotspotDrop: ${(x.m || {}).hotspotDropPct}`}

Attack on these fronts:
 1) NOISE: is the improvement within paired round-to-round spread (could be machine jitter)? Compare
    paired per-round deltas, not just medians. Set noiseRisk.
 2) CHEATING: does the diff change OBSERVABLE behavior to look faster (skips work, drops a field,
    weakens validation, changes types/order, or — c-ext — silently falls back)? Set behaviorChangeRisk.
 3) ${x.c.lane === 'cext'
      ? 'LOAD PROOF: is cextLoaded genuinely proven (the compiled module imported, not the fallback)? If not proven, REFUTE.'
      : 'PROFILE COHERENCE: does totalCpuDropPct corroborate the hotspot drop, or did work just move to another function (hotspot down but total flat/up)? Set profileCoherent.'}
 4) INVARIANTS: re-verify streaming + bounded-memory from the diff (file:line). Set invariantRecheck.
refuted=true if ANY front fails OR you are genuinely uncertain. Return ONLY the structured object.`,
  { phase: 'Verify', label: `verify:${x.c.id}`, schema: VERIFY, model: 'opus' })
  .then(v => ({ ...x, verify: v }))))

const survivors = verified.filter(Boolean).filter(x => x.verify && !x.verify.refuted)
verified.filter(Boolean).forEach(x => { if (x.verify && x.verify.refuted) log(`REFUTED ${x.c.id}: ${(x.verify.reasons || []).join('; ')}`) })
log(`Verified survivors: ${survivors.length} — ${survivors.map(x => x.c.id).join(', ') || 'none'}`)

// =================================================================================
// PHASE 8 — FINALIZE. Each survivor a clean, standalone, single-purpose branch + an
// out-of-repo evidence report. NOT merged, NOT pushed.
phase('Finalize')
const finals = await parallel(survivors.map(x => () => agent(
`Finalize candidate "${x.c.id}" as a clean STANDALONE branch auto/cand-${x.c.id} (do NOT merge, do NOT push).
In its worktree: squash WIP into ONE commit that is a single-purpose, mergeable diff vs ${BASE}; write a
concise imperative commit subject (<=50 chars, capitalized, no trailing period, no conventional-commit prefix).
Keep the diff PURE — do NOT commit any report into the source branch.
Write the evidence report to ${OUT}/cand-${x.c.id}/REPORT.md (outside the repo): the change, files touched,
lane, bucket (${bucketOf(x.c, x.m)}), before/after medium+tiny medians, ${x.c.lane === 'cext'
  ? 'the load-assertion proof and a note that deterministic external benchmarking is required'
  : 'total-CPU drop + hotspot drop'}, the skeptic's verdict, and the invariant evidence (incl. any
declared contract break '${x.c.breaksContract}').
Report branch, clean (single-purpose diff vs ${BASE}), diffStat, reportPath, commitMessage. Return ONLY the object.`,
  { phase: 'Finalize', label: `finalize:${x.c.id}`, schema: FINALIZE })
  .then(f => ({ ...x, final: f }))))

// =================================================================================
phase('Report')
const enrich = (x) => ({
  id: x.c.id, branch: `auto/cand-${x.c.id}`, title: x.c.title, lane: x.c.lane,
  riskTier: x.c.riskTier, hotspot: x.c.hotspot, breaksContract: x.c.breaksContract,
  mediumMedian: median(x.m.candidateMediumWallReps), baselineMediumMedian: median(x.m.baselineMediumWallReps),
  tinyMedian: median(x.m.candidateTinyWallReps), baselineTinyMedian: median(x.m.baselineTinyWallReps),
  totalCpuDropPct: x.m.totalCpuDropPct, hotspotDropPct: x.m.hotspotDropPct, cextLoaded: x.m.cextLoaded,
  skepticConfidence: x.verify && x.verify.confidence,
  report: x.final && x.final.reportPath, commit: x.final && x.final.commitMessage,
  cleanBranch: x.final && x.final.clean,
})
const done = finals.filter(Boolean)
const clean = done.filter(x => bucketOf(x.c, x.m) === 'clean').map(enrich)
const breaksContract = done.filter(x => bucketOf(x.c, x.m) === 'breaks-contract').map(enrich)
const cext = done.filter(x => bucketOf(x.c, x.m) === 'cext').map(enrich)

return {
  thresholds: { TOTAL_CPU_MIN_DROP, PY_WALLCLOCK_GUARD, CEXT_WALLCLOCK_TOL, TINY_REGRESS_TOL, EXECUTIONS, BENCH_ROUNDS, IMPLEMENT_CAP },
  anchor: { baselineMediumWall: rig.baselineMediumWall, baselineTinyWall: rig.baselineTinyWall, baselineTotalCpu: rig.baselineTotalCpu, serverReused: rig.serverReused, dir: `${OUT}/baseline` },
  funnel: {
    portfolio: candidates.map(c => c.id),
    viable: viable.map(c => c.id),
    approved: approved.map(x => x.c.id),
    mvnGreen: correct.map(x => x.c.id),
    apparentWinners: apparentWinners.map(x => x.c.id),
    refuted: verified.filter(Boolean).filter(x => x.verify && x.verify.refuted).map(x => ({ id: x.c.id, reasons: x.verify.reasons })),
  },
  // The deliverable: each survivor is its OWN branch, sorted into three review buckets.
  cleanWinners: clean,                 // python, no contract break — mergeable today
  breaksContract: breaksContract,      // python but changes public-API/custom-serializer — your major-version call
  cextCandidates: cext,                // compiled; profile-incomparable — needs your deterministic external benchmark
  nextStep: 'Each entry is an independent branch (auto/cand-<id>), reviewed, gated, benchmarked, and verified. Nothing merged/pushed/combined. Review each diff; merge the ones you want, separately. C-ext entries still need a deterministic benchmark in a clean environment before trusting their speedup.',
}
