/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file. Apache License 2.0.
 *
 * ============================================================================
 *  GLV CORRECTNESS FUNNEL  —  autonomous, GLV-parameterized discovery pipeline
 *  for GraphBinary deserialization optimizations, gated up to `mvn clean install`.
 * ============================================================================
 *
 *  Run with the Claude Code `Workflow` tool (background + resumable):
 *    Workflow({ scriptPath: ".../bench/auto/glv-correctness-funnel.workflow.js",
 *               args: { glv: "python" } })          // or { glv: "go" }
 *
 *  SCOPE (deliberate): this pipeline goes ONLY as far as a green `mvn clean install`
 *  (unit + integration + feature/radish). It does NOT benchmark or profile — the
 *  OPERATOR does that manually, per branch, afterwards. So the deliverable is not
 *  "proven faster" but "a plausible optimization that compiles and passes the FULL
 *  test suite, reviewed and isolated on its own branch — ready for your benchmark."
 *
 *  Because there is no profiling, the only GLV-specific organ that used to make a
 *  single script impossible (yappi-vs-pprof, deterministic-vs-sampling gate) is gone.
 *  What remains differs per GLV in just a few places, captured in GLV_REGISTRY below.
 *
 *  DELIVERABLE: each survivor is its OWN branch auto/cand-<glv>-<id>, sorted into:
 *    - passed          : green, no contract break        -> benchmark, then merge
 *    - breaksContract  : green, but changes public-API / custom-serializer contract
 *                        -> your major-version judgment call (benchmark first)
 *  Nothing is merged, combined, or pushed. The OPERATOR benchmarks + merges.
 *
 *  Invariants (WHY they matter with no benchmark gate): a green test suite proves
 *  only what the tests check. It does NOT prove streaming still streams, memory stays
 *  bounded, the public API is intact, or custom serializers still load — unless a test
 *  happens to assert exactly that. With profiling removed, the test suite + this
 *  invariant guard are the ONLY automated checks, so the invariant review is the load-
 *  bearing thing standing between "tests pass" and "actually correct". Two tiers:
 *    HARD (auto-prune): correctness/safety contracts that are never worth trading for speed.
 *    SOFT (flag, don't kill): compatibility contracts that MIGHT be worth a major version
 *                             -> surfaced in the breaksContract bucket for the human.
 */

// NOTE: the Workflow harness requires `export const meta` to be the FIRST statement,
// and it must be a pure literal. It is hoisted here, above the GLV registry and the
// GLV resolution below, for that reason.
export const meta = {
  name: 'glv-correctness-funnel',
  description: 'GLV-parameterized: discover, implement, review and gate (mvn clean install incl. integration+feature) GraphBinary deser optimizations; each survivor on its own branch for the operator to benchmark + merge. No benchmarking/profiling in-workflow.',
  phases: [
    { title: 'Setup',       detail: 'light: confirm toolchain + clean tree (NO server, NO baseline)' },
    { title: 'Research',    detail: 'wide diverse-lens idea generation (tiny tweaks -> big refactors)', model: 'opus' },
    { title: 'Investigate', detail: 'deep per-candidate study; ruthless prune; two-tier invariant classification', model: 'opus' },
    { title: 'Implement',   detail: 'one agent per candidate in own worktree; code-repair loop; unit gate', },
    { title: 'Review',      detail: 'independent correctness + invariant review before the expensive gate', model: 'opus' },
    { title: 'Correctness', detail: 'mvn clean install incl. integration + feature — strictly serial; <=1 code-repair', model: 'opus' },
    { title: 'Report',      detail: 'every test-passing branch, sorted into passed / breaks-contract, ready to benchmark', },
  ],
}

// ===========================================================================
//  GLV REGISTRY — the only GLV-specific knowledge. Add a GLV by adding an entry.
// ===========================================================================
const GLV_REGISTRY = {
  python: {
    label: 'gremlin-python',
    module: 'gremlin-python',                                  // dir holding pom.xml for the mvn gate
    sourceSubdir: 'gremlin-python/src/main/python',            // where unit tests + source live
    // Python's editable install resolves to the ORIGINAL tree, so a worktree's pytest
    // must point PYTHONPATH at ITS OWN source to test the candidate's code, not the original.
    unitTest: (py) => `cd <worktree>/gremlin-python/src/main/python && ` +
      `PYTHONPATH="$(pwd)" ${py} -m pytest tests/unit/structure/io/ tests/unit/driver/test_http_streaming.py -q`,
    unitToolDesc: 'pytest (no server)',
    // What the .glv-activated mvn gate runs, and the log signal that PROVES it actually ran
    // (vs a seconds-long no-op false green). Injected into the gate prompt's STEP 1/STEP 3.
    suiteDesc: 'pytest integration (~347 tests, no-server unit + server-backed) AND the radish feature/gherkin suite, x3 serializer modes (graphbinary bulked / parameterized / plain)',
    suiteProof: 'a MINUTES-long build whose log shows the docker integration tests plus the radish feature run — typically ~163 features / ~2149 scenarios / ~9890 steps, printed once per mode (x3). A sub-10-second BUILD SUCCESS with no radish/pytest counts means the profile did NOT activate',
    sourceGlobs: 'gremlin_python/structure/io/graphbinaryV4.py, driver/serializer.py, driver/connection.py, driver/aiohttp/transport.py',
    testGlobs: 'tests/unit/structure/io/*, tests/unit/driver/test_http_streaming.py',
    profileSubdir: 'python-4.0',
    profileHint:
`Files: 40-yappi-cpu.txt (yappi, CPU clock — per file:line tsub=self / ttot=cumulative / ncall) and
40-yappi-wall.txt (wall clock); 40-mem.html + 40.mem.bin (memory); *.callgrind. There is NO written
analysis — distill the yappi tables yourself, ranking by tsub (self CPU). Expect to see aenum
DataType.__hash__/__call__/__new__, the graphbinaryV4.py:86 struct-unpack <lambda>, is_null, read_int,
AiohttpSyncStream.read, and _read_vertexproperty/_read_vertex near the top.`,
    seed:
`Known hotspots/ideas (verify by reading source): aenum DataType (DataType(bt) construction + __hash__,
~15% CPU); the shared struct unpack lambda at graphbinaryV4.py:86 (~6%); is_null; result-object
construction (Vertex/VertexProperty/Path); AiohttpSyncStream.read (the 64KB chunk buffer is already merged).
Known-good directions to include as floors: B-HYBRID (private {int:deserializer} cache built in
GraphBinaryReader.__init__ from the enum-keyed self.deserializers; hot path uses it; KeyError->re-raise
ValueError to keep the contract; public maps stay enum-keyed) ~15% zero-break; C1 int.from_bytes for
INTEGER unpackers only (floats/doubles stay on struct) ~6% bit-exact.`,
    invariants: {
      hard: [
        'incremental streaming: connection.py _receive yields each object as decoded (no whole-response buffering)',
        'bounded memory: no whole-body materialization (do NOT introduce io.BytesIO(read_body) or equivalent)',
      ],
      soft: [
        'public-api: DataType enum identity and deserializer_map/serializer_map KEY TYPES unchanged',
        'custom-serializer: objectify(cls,buff,reader,nullable) signature + a .read(n) buff contract intact',
      ],
    },
    highCeilingNote: 'A C-extension/Cython lane is permissible but its real speedup is invisible to the test gate; tag it so you benchmark it first. Build must compile in-place and a load-assertion must prove the compiled module (not a pure-Python fallback) is imported.',
  },

  go: {
    label: 'gremlin-go',
    module: 'gremlin-go',
    sourceSubdir: 'gremlin-go',
    // Go worktrees carry their own go.mod, so building/testing from the worktree is naturally
    // isolated — no env trick needed. IMPORTANT: `go test ./driver/...` would sweep in
    // server-dependent tests in connection_test.go (e.g. TestStreamingResultDelivery) that hit
    // localhost:45940 and are NOT gated by RUN_INTEGRATION_TESTS — they FAIL with no server up.
    // So the cheap unit gate targets only the verified server-free hot-path suites (GraphBinary
    // de/serialization, Result, graph types, GValue), plus a full `go build ./...` to catch any
    // compile break beyond those files. Full streaming/integration coverage runs in the mvn gate.
    unitTest: () => `cd <worktree>/gremlin-go && go build ./... && ` +
      `go test ./driver/ -run 'TestGraphBinary|TestSerializer|TestResult|TestGraph|TestGValue' -count=1`,
    unitToolDesc: 'go build + go test (server-free hot-path suites)',
    // Go's .glv profile runs a docker-compose `go test` integration suite (NOT radish — gremlin-go has
    // zero .feature files; its only 'generate-radish-support' step is shared groovy data-gen, not a test run).
    suiteDesc: "the docker-compose Go integration suite: `docker compose up --build --exit-code-from gremlin-go-integration-tests` — go test against a containerized gremlin-server (build SUCCESS requires the integration container to exit 0)",
    suiteProof: 'a MINUTES-long build whose log shows docker compose building images, the gremlin-server container becoming healthy, and the gremlin-go-integration-tests container running `go test` (PASS/ok lines, package timings) and exiting 0. There is NO radish output for Go — do NOT expect feature/scenario/step counts. A sub-10-second BUILD SUCCESS with no docker/go-test activity means the profile did NOT activate',
    sourceGlobs: 'gremlin-go/driver/ (GraphBinary reader/serializer, type deserialization, connection/result streaming)',
    testGlobs: 'gremlin-go/driver/*_test.go (GraphBinary + serializer unit tests)',
    profileSubdir: 'go-4.0',
    profileHint:
`Files: go-profile-<date>.md (a WRITTEN end-to-end analysis — read this FIRST; it already ranks the decode
tower with file:line hotspots and an allocation breakdown), plus raw 40-cpu.txt / 40-cpu.pprof and
40-heap.txt / 40-heap.pprof / 40-heap.svg and 40-trace.out. The heap (alloc_objects / alloc_space) is the
most actionable signal. IMPORTANT: the CPU profile's large usleep/pthread_cond_wait self-time is a flagged
macOS all-thread idle-sampling artifact (pool=1) — DISCOUNT it; rank decode work by the cumulative tower
and by allocations, not by that idle self-time.`,
    seed:
`There is NO prior Python-style hotspot list for Go — derive hotspots by READING gremlin-go/driver/.
Go-idiomatic optimization space: per-element slice reallocation vs preallocation, encoding/binary vs
manual byte math, interface-dispatch in the type switch, map lookups per element, string([]byte) copies,
escape-analysis/allocation pressure feeding GC, and bufio/read sizing. Do NOT carry over Python-specific
ideas (aenum, struct lambdas) — they do not exist here.`,
    invariants: {
      hard: [
        'incremental streaming: results delivered over the result channel as decoded (no buffering the whole response)',
        'bounded memory: no whole-response materialization in a single buffer for large results',
      ],
      soft: [
        'public-api: exported types/funcs and the GraphBinary reader/serializer interface signatures unchanged',
        'custom-serializer: any exported registration/extension point for custom type handlers intact',
      ],
    },
    highCeilingNote: 'The high-ceiling lane for Go is unsafe/asm/encoding-binary tricks; it is gated like any other Go change (compiles + go test + mvn), no separate build-proof needed since Go is already compiled.',
  },
}

// ---- normalize args -----------------------------------------------------------
// The harness may hand `args` over as a JSON-encoded STRING rather than an object.
// A string is truthy, so `args && args.glv` would pass the guard yet read undefined
// off the string and silently fall through to the 'python' default. Parse it back
// into an object first so every read below behaves the same regardless of form.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
if (!A || typeof A !== 'object') A = {}

// ---- resolve GLV ---------------------------------------------------------------
const GLV = A.glv || 'python'
const G = GLV_REGISTRY[GLV]
if (!G) throw new Error(`unknown glv '${GLV}'. Known: ${Object.keys(GLV_REGISTRY).join(', ')}`)

// ---- knobs --------------------------------------------------------------------
const REPO       = A.repo   || '/Users/kiristep/dev/tinkerpop'
const BASE       = A.base   || '4-glv-profiling'   // branch candidates fork from
const VENV_PY    = A.python || '/Users/kiristep/venv-glv-4/bin/python'  // python lane only
// Stored profiling results (per GLV) live here, OUTSIDE the repo. The Setup agent reads
// PROFILE_DIR each run and returns a hotspot digest that seeds Research — see SHARED below.
// Set args.profileRoot='' (or a missing dir) to fall back to the static registry seed.
const PROFILE_ROOT = A.profileRoot !== undefined ? A.profileRoot : '/Users/kiristep/dev/profiling-results'
const PROFILE_DIR  = PROFILE_ROOT && G.profileSubdir ? `${PROFILE_ROOT}/${G.profileSubdir}` : ''
const ALLOW_HIGH_CEILING = A.allowHighCeiling !== false  // default ON
const MAX_RESEARCH_CANDS = A.maxResearch  || 10
const IMPLEMENT_CAP      = A.implementCap || 6      // narrow the serial mvn tail
const REPAIR_CHEAP = A.repairCheap || 2             // code-repair attempts at unit stage
const REPAIR_MVN   = A.repairMvn   || 1             // code-repair attempts at the mvn gate

// ---- schemas ------------------------------------------------------------------
const SETUP = {
  type: 'object', required: ['ok'], properties: {
    ok: { type: 'boolean', description: 'true only if toolchain present and tree is in a usable, committed state' },
    toolchain: { type: 'string', description: 'what was verified (e.g. python+pytest, or go+mvn)' },
    treeClean: { type: 'boolean' }, abortReason: { type: 'string' }, notes: { type: 'string' },
    profileFound: { type: 'boolean', description: 'true if the stored profiling dir existed and was read' },
    profileDigest: { type: 'string', description: 'distilled ranked hotspot summary from the stored profiles (empty if none); seeds Research' },
  },
}
const RESEARCH = {
  type: 'object', required: ['items'], properties: { items: { type: 'array', items: {
    type: 'object', required: ['title', 'hotspot', 'approach', 'riskTier', 'breaksContractGuess'],
    properties: {
      title: { type: 'string' }, hotspot: { type: 'string', description: 'function(s)/area targeted' },
      approach: { type: 'string', description: 'concrete change, 2-5 sentences' },
      riskTier: { type: 'string', enum: ['safe', 'medium', 'restructure', 'high-ceiling'] },
      expectedBenefit: { type: 'string', description: 'qualitative — there is NO in-workflow measurement' },
      breaksContractGuess: { type: 'string', enum: ['none', 'public-api', 'custom-serializer', 'streaming', 'memory'] },
      invariantsAtRisk: { type: 'array', items: { type: 'string' } },
    } } } },
}
const PORTFOLIO = {
  type: 'object', required: ['items'], properties: { items: { type: 'array', items: {
    type: 'object', required: ['id', 'title', 'hotspot', 'approach', 'riskTier', 'standaloneRationale', 'breaksContract'],
    properties: {
      id: { type: 'string', description: 'unique kebab slug; becomes branch auto/cand-<glv>-<id>' },
      title: { type: 'string' }, hotspot: { type: 'string' }, approach: { type: 'string' },
      riskTier: { type: 'string', enum: ['safe', 'medium', 'restructure', 'high-ceiling'] },
      standaloneRationale: { type: 'string', description: 'why it is valuable & mergeable entirely on its own' },
      breaksContract: { type: 'string', enum: ['none', 'public-api', 'custom-serializer'] },
      invariantsAtRisk: { type: 'array', items: { type: 'string' } },
    } } } },
}
const INVESTIGATION = {
  type: 'object', required: ['id', 'viable', 'standalone', 'invariantClass', 'confidence', 'summary'], properties: {
    id: { type: 'string' }, viable: { type: 'boolean' }, standalone: { type: 'boolean' },
    invariantClass: { type: 'string', enum: ['safe', 'breaks-public-api', 'breaks-custom-serializer', 'breaks-streaming', 'breaks-memory'],
      description: 'breaks-streaming/breaks-memory => HARD prune (viable=false). breaks-public-api/custom-serializer => keep, flagged for human.' },
    confidence: { type: 'number', description: '0..1, used to rank into the narrow tail' },
    recommendedVariant: { type: 'string' },
    riskRegister: { type: 'array', items: { type: 'object', properties: {
      risk: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' }, mitigation: { type: 'string' } } } },
    invariantAnalysis: { type: 'string', description: 'which invariants hold / break, with file:line' },
    testImpact: { type: 'array', items: { type: 'string' } },
    benchmarkHint: { type: 'string', description: 'what the OPERATOR should measure to confirm this helps' },
    summary: { type: 'string' },
  },
}
const BUILD = {
  type: 'object', required: ['id', 'unitGreen', 'summary'], properties: {
    id: { type: 'string' }, unitGreen: { type: 'boolean' },
    branchName: { type: 'string', description: 'the actual checked-out branch — MUST equal auto/cand-<glv>-<id> or the downstream gate will not find this candidate' },
    repairAttempts: { type: 'number' }, touchedTests: { type: 'boolean', description: 'MUST be false' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    diffStat: { type: 'string' }, unitOutputTail: { type: 'string' }, summary: { type: 'string' },
  },
}
const REVIEW = {
  type: 'object', required: ['id', 'approved', 'verdict'], properties: {
    id: { type: 'string' }, approved: { type: 'boolean' },
    touchedTests: { type: 'boolean', description: 'true => auto-reject' },
    correctnessIssues: { type: 'array', items: { type: 'string' } },
    invariantIssues: { type: 'array', items: { type: 'string' }, description: 'streaming/memory => reject; api/custom-serializer => note only' },
    behaviorEquivalence: { type: 'string' }, verdict: { type: 'string' },
  },
}
const MVN = {
  type: 'object', required: ['id', 'fullSuiteGreen', 'suiteRan', 'summary'], properties: {
    id: { type: 'string' }, fullSuiteGreen: { type: 'boolean' },
    suiteRan: { type: 'boolean', description: 'true ONLY if the .glv-activated integration suite ACTUALLY executed (a minutes-long build with real test evidence per the GLV proof: radish feature/scenario counts for python, the docker go-test integration container for go). A sub-10s BUILD SUCCESS means the .glv profile did not activate => false. fullSuiteGreen with suiteRan=false is a false green and is dropped.' },
    integrationGreen: { type: 'boolean' }, featureGreen: { type: 'boolean' },
    repairedAtMvn: { type: 'boolean', description: 'true if code (never a test) changed to pass => triggers re-review' },
    failTail: { type: 'string' }, summary: { type: 'string' },
  },
}
const FINALIZE = {
  type: 'object', required: ['id', 'branch', 'clean'], properties: {
    id: { type: 'string' }, branch: { type: 'string' },
    clean: { type: 'boolean', description: 'single-purpose, mergeable diff vs BASE with one clean commit' },
    commitMessage: { type: 'string' }, diffStat: { type: 'string' },
    benchmarkHint: { type: 'string', description: 'what the operator should measure for this branch' },
  },
}

// ---- invariant lists (used in SHARED and in several phase prompts) -------------
const hardList = G.invariants.hard.map(s => '   - ' + s).join('\n')
const softList = G.invariants.soft.map(s => '   - ' + s).join('\n')

// =================================================================================
// PHASE 0 — SETUP. Light: confirm the toolchain and a committed tree. No server, no
// baseline. ALSO read the stored profiling results (if any) into a hotspot digest that
// seeds Research — the script runtime can't read files, but this agent can, so the
// digest must travel back through the structured result. Profile-read is NON-BLOCKING:
// a missing/unreadable profile NEVER flips ok=false (we fall back to the static seed).
phase('Setup')
log(`Correctness funnel for glv=${GLV} (${G.label}). Gated to 'mvn clean install'; operator benchmarks after.`)

const rig = await agent(
`Light setup check for the ${G.label} correctness funnel (NO server, NO benchmarking).
Confirm the toolchain needed to (a) run unit tests and (b) run 'mvn clean install -Dasciidoc.skip=true'
for ${G.module}:
${GLV === 'python'
  ? `- ${VENV_PY} runs and can import the package + pytest (unit tool: ${G.unitToolDesc}).`
  : `- 'go' and 'mvn' are on PATH; 'go vet'/'go test' run in ${G.module} (unit tool: ${G.unitToolDesc}).`}
- docker is available (the mvn gate is docker-compose orchestrated).
- the working tree at ${REPO} is committed enough that worktrees can fork from ${BASE} (treeClean).
Apply only trivial fixes (e.g. pip install pytest into the venv). If the toolchain is unusable, set
ok=false with abortReason.

${PROFILE_DIR ? `PROFILING DIGEST (this is the load-bearing seed for idea generation — do it carefully):
There are STORED profiling results for this GLV at: ${PROFILE_DIR}
${G.profileHint}
Read those files and distill a COMPACT, RANKED hotspot digest into 'profileDigest' (set profileFound=true):
- The top decode/deserialization hot spots by SELF cost, each with function + file:line where you can find
  it, the metric (CPU self% or wall, and/or allocation count/bytes), and one phrase on WHY it is hot.
- Note any explicitly-flagged measurement artifacts to discount (do NOT rank those as hot).
- 12-25 lines, concrete and source-anchored — this text is injected verbatim into the Research prompts, so
  it must let an engineer go straight to the right functions. Do NOT propose fixes here; just rank reality.
This profile read is NON-BLOCKING: if ${PROFILE_DIR} is missing/empty/unreadable, set profileFound=false
and profileDigest='' and DO NOT set ok=false for that reason alone.`
  : `No profiling dir configured (profileRoot empty); set profileFound=false, profileDigest='' — Research will use the static seed.`}
Return ONLY the structured object.`,
  { phase: 'Setup', schema: SETUP })

if (!rig || !rig.ok) { log(`ABORT: setup — ${rig && rig.abortReason}`); return { aborted: true, glv: GLV, reason: (rig && rig.abortReason) || 'setup failed', rig } }
log(`Setup OK (${rig.toolchain}). Profiling digest: ${rig.profileFound ? 'LIVE from ' + PROFILE_DIR : 'none — using static seed'}.`)

// ---- shared context block (GLV-aware) — built AFTER setup so it can weave in the -----
// live profiling digest. The digest (when present) is the authoritative hotspot source;
// the static registry seed is the fallback / supplement.
const PROFILE_SECTION = (rig.profileFound && rig.profileDigest)
  ? `MEASURED HOTSPOTS (from real stored profiling at ${PROFILE_DIR} — treat as the AUTHORITATIVE ranking;
prioritize ideas that attack these, and still verify each against the source before claiming anything):
${rig.profileDigest}

Static background (supplements the measured data above):
${G.seed}`
  : `Hotspot guidance (NO live profile was available this run — static seed):
${G.seed}`

const SHARED =
`Target: ${G.label} GraphBinary DESERIALIZATION hot path (repo ${REPO}).
Read the source to ground every claim: ${G.sourceGlobs}. Tests: ${G.testGlobs}.
${PROFILE_SECTION}

INVARIANTS (two tiers):
 HARD — any breach AUTO-PRUNES the idea (never worth trading for speed):
${hardList}
 SOFT — allowed but FLAGGED for human judgment (NOT auto-killed); a candidate that needs one of
 these is implemented, tested, and surfaced in the 'breaksContract' bucket:
${softList}
${ALLOW_HIGH_CEILING ? 'High-ceiling lane: ' + G.highCeilingNote : 'Do NOT propose high-ceiling (unsafe/native/Cython) candidates.'}

NOTE: there is NO benchmarking or profiling DONE IN this pipeline (the measured hotspots above are from a
PRIOR profiling run, read at setup). The operator benchmarks each surviving branch by hand afterward. So
judge ideas on plausibility + correctness + invariant-safety, and for each give a concrete benchmarkHint
(what to measure to confirm it helps). Do not claim NEW measured speedups.`

// =================================================================================
// PHASE 1 — RESEARCH. Wide, diverse-lens generation (breadth is cheap here).
phase('Research')
const LENSES = A.lenses || (GLV === 'python'
  ? [
      'small, low-risk tweaks (bound-method hoisting, cheaper int unpack via int.from_bytes for integers only, local caching)',
      'enum/type-code dispatch (aenum DataType construction + __hash__; int-keyed dispatch cache)',
      'the read/buffer path (struct lambda elimination, is_null cost) WITHOUT breaking streaming',
      'result object construction (Vertex/VertexProperty/Path: __slots__, fewer attribute writes)',
      'large structural refactor of the reader (per-type codegen, flatter dispatch, fewer Python frames)',
      'high-ceiling: C-extension / Cython acceleration of the innermost decode loop',
    ]
  : [
      'allocation reduction (preallocate slices/maps by known length, reuse buffers, avoid string([]byte) copies)',
      'decode dispatch (the type switch / interface dispatch in the GraphBinary reader)',
      'byte handling (encoding/binary vs manual math, bufio/read sizing) WITHOUT breaking streaming',
      'result construction & channel delivery (fewer allocations per element, GC pressure)',
      'large structural refactor of the reader (flatter dispatch, generated per-type decoders)',
      'high-ceiling: unsafe / encoding-binary / asm tricks on the innermost decode loop',
    ])
  .filter(l => ALLOW_HIGH_CEILING || !/high-ceiling/i.test(l))

const lensFindings = await parallel(LENSES.map((lens, i) => () => agent(
`${SHARED}

YOUR LENS: ${lens}.
Generate concrete ideas ONLY within this lens — tiny tweaks to large refactors as it implies. For each:
the area/function targeted, a concrete approach, riskTier, breaksContractGuess, invariants at risk, a
qualitative expectedBenefit, and a benchmarkHint. Be generous — this is the wide discovery pass.
Return ONLY the structured object.`,
  { phase: 'Research', label: `research:lens-${i + 1}`, schema: RESEARCH, model: 'opus' })))

const allIdeas = lensFindings.filter(Boolean).flatMap(r => r.items || [])
log(`Raw ideas: ${allIdeas.length} across ${LENSES.length} lenses. Synthesizing…`)

const portfolio = await agent(
`${SHARED}

Raw ideas from independent lenses (JSON): ${JSON.stringify(allIdeas)}

Synthesize a deduped PORTFOLIO of at most ${MAX_RESEARCH_CANDS} candidates:
- Merge duplicates; keep the strongest framing; span riskTiers from small to large.
- DROP any idea whose breaksContractGuess is 'streaming' or 'memory' (HARD invariants).
- For survivors set breaksContract to 'none' | 'public-api' | 'custom-serializer'.
- Each MUST be independently valuable & mergeable ON ITS OWN (standaloneRationale); each gets its own
  branch and we NEVER combine them. Two candidates may touch the same file — fine.
- Assign a unique kebab id.
Return ONLY the structured object.`,
  { phase: 'Research', label: 'research:synthesize', schema: PORTFOLIO, model: 'opus' })

let candidates = (portfolio.items || []).slice(0, MAX_RESEARCH_CANDS)
if (!candidates.length) return { error: 'no candidates from research', glv: GLV, allIdeas }
log(`Portfolio (${candidates.length}): ${candidates.map(c => `${c.id}[${c.riskTier}${c.breaksContract !== 'none' ? '/' + c.breaksContract : ''}]`).join(', ')}`)

// =================================================================================
// PHASE 2 — INVESTIGATE. Deep study; ruthless prune; two-tier invariant classify; rank.
phase('Investigate')
const investigations = await parallel(candidates.map(c => () => agent(
`${SHARED}

Deeply investigate candidate "${c.id}" — ${c.title}.
Area: ${c.hotspot}. Approach: ${c.approach}. Risk: ${c.riskTier}. Declared breaksContract: ${c.breaksContract}.

Produce a rigorous, citation-backed (file:line) study:
- recommendedVariant (safest form that still gets the benefit), a risk register, invariantAnalysis,
- invariantClass — classify precisely:
    'breaks-streaming'/'breaks-memory' => you MUST set viable=false (HARD prune),
    'breaks-public-api'/'breaks-custom-serializer' => viable MAY be true (flagged for human),
    'safe' => no contract impact.
- testImpact (which tests exercise this),
- benchmarkHint (what the operator should measure afterward to confirm a real win),
- standalone (MUST be true to proceed — its own branch), confidence (0..1).
Be willing to KILL candidates: the serial mvn tail is narrow on purpose. Set viable=false if it breaks a
hard invariant, is not standalone, or risk clearly outweighs benefit. Return ONLY the structured object.`,
  { phase: 'Investigate', label: `investigate:${c.id}`, schema: INVESTIGATION, model: 'opus' })))

const invById = Object.fromEntries(investigations.filter(Boolean).map(v => [v.id, v]))
const byId = Object.fromEntries(candidates.map(c => [c.id, c]))
const contractFromClass = (cls) => cls === 'breaks-public-api' ? 'public-api' : cls === 'breaks-custom-serializer' ? 'custom-serializer' : 'none'
let viable = investigations.filter(Boolean)
  .filter(v => v.viable && v.standalone && v.invariantClass !== 'breaks-streaming' && v.invariantClass !== 'breaks-memory')
  .map(v => ({ ...byId[v.id], breaksContract: contractFromClass(v.invariantClass), _confidence: v.confidence || 0 }))
  .filter(c => c.id)
  .sort((a, b) => b._confidence - a._confidence)
  .slice(0, IMPLEMENT_CAP)
log(`Viable after investigation: ${viable.length} (cap ${IMPLEMENT_CAP}) — ${viable.map(c => c.id).join(', ') || 'none'}`)
if (!viable.length) return { error: 'no candidate survived investigation', glv: GLV, investigations }

// =================================================================================
// PHASE 3+4 — IMPLEMENT (worktree, code-repair, unit gate) -> independent REVIEW. Pipelined.
const reviewed = await pipeline(viable,
  c => agent(
`Implement candidate "${c.id}" — ${c.title} — in ${G.label}.
Area: ${c.hotspot}. Recommended variant: ${(invById[c.id] || {}).recommendedVariant || '(safest form)'}.
Approach: ${c.approach}

You are in a fresh git worktree. The harness checked it out on an internal placeholder branch (e.g.
worktree-wf_...) that may be forked from the repo's DEFAULT branch, NOT from this run's intended base
${BASE}. Both must be corrected. Your FIRST actions MUST be, in the worktree:
    git fetch --quiet . ${BASE} || true
    git checkout -B auto/cand-${GLV}-${c.id} ${BASE}
This pins the candidate to the correct base ${BASE} AND the correct branch name (the DOWNSTREAM mvn gate and
finalizer look the candidate up STRICTLY by the name auto/cand-${GLV}-${c.id}; a placeholder name makes the
gate report "branch does not exist" and silently drops the candidate; a wrong base benchmarks it against the
wrong tree). Verify BOTH: 'git rev-parse --abbrev-ref HEAD' == auto/cand-${GLV}-${c.id} and
'git merge-base --is-ancestor ${BASE} HEAD' succeeds. Record the branch in branchName.
Work ONLY here, under ${G.sourceSubdir}/. Make ONE clean commit — the branch must stand alone and be
mergeable by itself.
Preserve the HARD invariants:
${hardList}
${c.breaksContract !== 'none' ? `This candidate intentionally affects the SOFT contract '${c.breaksContract}' — allowed and will be flagged; change nothing MORE than necessary.` : 'Do not change any public contract.'}

RULES:
- NEVER modify, skip, weaken, or delete a test to make things pass (touchedTests MUST be false).
- CODE-REPAIR LOOP: run the unit suite (${G.unitToolDesc}):
    ${G.unitTest(VENV_PY)}
  If it fails, you MAY fix YOUR OWN code and retry, up to ${REPAIR_CHEAP} attempts. If still red, set
  unitGreen=false and explain. Report repairAttempts and diffStat (git diff --stat vs ${BASE}).
Return ONLY the structured object.`,
    { phase: 'Implement', label: `impl:${c.id}`, isolation: 'worktree', schema: BUILD,
      model: (c.riskTier === 'restructure' || c.riskTier === 'high-ceiling') ? 'opus' : undefined }),
  (b, c) => {
    if (!b || !b.unitGreen) { log(`DROP ${c.id}: unit gate (${b && b.summary})`); return null }
    if (b.touchedTests) { log(`DROP ${c.id}: modified tests`); return null }
    return agent(
`Independently review candidate "${c.id}" (branch auto/cand-${GLV}-${c.id}) BEFORE the expensive mvn gate.
You did not write it. Read the diff vs ${BASE} in the worktree. With NO benchmark downstream, this review
+ the test suite are the ONLY automated checks — be thorough.
Judge:
 1) Behavior-equivalence & correctness: identical deserialized results for ALL types (ints incl.
    negative/boundary, floats, strings, null, bulked lists, maps, vertex/edge/path)? Cite the diff.
 2) Tests untouched (touchedTests). If any test was modified/skipped/weakened => approved=false.
 3) Invariants: HARD ones MUST hold (issues => approved=false):
${hardList}
    SOFT (public-api / custom-serializer) changes are NOTED in invariantIssues but do NOT cause rejection
    (this candidate's declared impact is '${c.breaksContract}').
approved=true ONLY if behavior-equivalent, tests untouched, and HARD invariants intact.
Return ONLY the structured object.`,
      { phase: 'Review', label: `review:${c.id}`, schema: REVIEW, model: 'opus' })
      .then(r => (r && r.approved && !r.touchedTests) ? { c, build: b, review: r } : (log(`DROP ${c.id}: review — ${r && r.verdict}`), null))
  },
)
const approved = reviewed.filter(Boolean)
log(`Approved for mvn gate: ${approved.length} — ${approved.map(x => x.c.id).join(', ') || 'none'}`)
if (!approved.length) return { error: 'no candidate passed implement+review', glv: GLV, viable: viable.map(c => c.id) }

// =================================================================================
// PHASE 5 — CORRECTNESS. mvn clean install (unit+integration+feature). STRICTLY SERIAL
// (Docker-orchestrated, fixed ports). <=1 code-repair; any repair re-enters Review.
phase('Correctness')
const passed = []
for (const x of approved) {
  const c = x.c
  const m = await agent(
`Run the FULL correctness gate for candidate "${c.id}" on branch auto/cand-${GLV}-${c.id}:
Docker-orchestrated maven build — unit + integration + feature against a containerized server.

STEP 0 — LOCATE THE CANDIDATE (do NOT skip; a wrong/missing tree makes the whole gate meaningless):
  Find the worktree for branch auto/cand-${GLV}-${c.id} ('git worktree list'). If no worktree is on that
  branch, it may still exist under an internal placeholder name (worktree-wf_...) that holds this
  candidate's commit — locate that worktree and 'git checkout -B auto/cand-${GLV}-${c.id}' there so the
  branch name is correct. If you truly cannot find the candidate's code anywhere, set fullSuiteGreen=false,
  suiteRan=false, and explain in failTail — do NOT build the wrong tree.

STEP 1 — ACTIVATE THE FULL SUITE (CRITICAL — without this, mvn is a NO-OP false green):
  The ${G.module} integration suite (${G.suiteDesc}) lives in a maven profile activated ONLY by the
  presence of a gitignored marker file '${G.module}/.glv'. A fresh worktree does NOT have it, so a plain
  'mvn clean install' will BUILD SUCCESS in seconds while running ZERO integration tests. You MUST:
    cd <worktree>/${G.module} && touch .glv
  (it is gitignored, so it does not dirty the candidate diff).

STEP 2 — RUN IT:
  cd <worktree>/${G.module} && docker compose down || true   # clear any stale stack first
  mvn clean install -Dasciidoc.skip=true
Run it in the BACKGROUND and POLL to completion (the build far exceeds the 10-min Bash cap — do NOT block
a single call on it; poll with short status checks so progress is visible). Only one build runs at a time,
so the fixed ports (45940/8182) are free.

STEP 3 — PROVE THE SUITE ACTUALLY RAN (false-green guard): the proof for ${G.label} is: ${G.suiteProof}.
Set suiteRan=true ONLY if you saw that evidence (and capture the concrete test/feature counts in summary);
otherwise set suiteRan=false, fullSuiteGreen=false and go back to STEP 1.

CODE-REPAIR: if it fails on a CODE bug, you MAY fix YOUR OWN code (NEVER a test) and retry up to
${REPAIR_MVN} time(s); set repairedAtMvn=true if you changed code. fullSuiteGreen=true ONLY on a real BUILD
SUCCESS with suiteRan=true. On failure capture the failing test/section in failTail. Return ONLY the object.`,
    { phase: 'Correctness', label: `mvn:${c.id}`, schema: MVN, model: 'opus' })
  if (m && m.fullSuiteGreen && m.suiteRan === false) {
    log(`DROP ${c.id}: mvn gate reported green but suiteRan=false (.glv no-op false-green) — ${m.summary}`); continue
  }
  if (!m || !m.fullSuiteGreen) { log(`DROP ${c.id}: mvn gate — ${m && m.summary}`); continue }
  if (m.repairedAtMvn) {
    const r2 = await agent(
`Re-review candidate "${c.id}" (branch auto/cand-${GLV}-${c.id}) — CODE-REPAIRED during the mvn gate.
Read the CURRENT diff vs ${BASE}. Same bar: behavior-equivalence across all types, tests untouched,
HARD invariants intact. approved=false on any violation. Return ONLY the structured object.`,
      { phase: 'Review', label: `re-review:${c.id}`, schema: REVIEW, model: 'opus' })
    if (!r2 || !r2.approved || r2.touchedTests) { log(`DROP ${c.id}: re-review after mvn repair failed`); continue }
  }
  passed.push(x)
}
log(`mvn-green: ${passed.length}/${approved.length} — ${passed.map(x => x.c.id).join(', ') || 'none'}`)

// =================================================================================
// PHASE 6 — FINALIZE + REPORT. Each survivor: clean standalone branch (NOT merged/pushed).
phase('Report')
const finals = await parallel(passed.map(x => () => agent(
`Finalize candidate "${x.c.id}" as a clean STANDALONE branch auto/cand-${GLV}-${x.c.id} (do NOT merge, do
NOT push). In its worktree: squash WIP into ONE commit that is a single-purpose, mergeable diff vs ${BASE};
write a concise imperative commit subject (<=50 chars, capitalized, no trailing period, no
conventional-commit prefix). Keep the diff PURE.
Report branch, clean (single-purpose vs ${BASE}), diffStat, commitMessage, and benchmarkHint (what the
operator should measure to confirm this change actually improves performance). Return ONLY the object.`,
  { phase: 'Report', label: `finalize:${x.c.id}`, schema: FINALIZE })
  .then(f => ({ ...x, final: f }))))

const enrich = (x) => ({
  id: x.c.id, branch: `auto/cand-${GLV}-${x.c.id}`, title: x.c.title, riskTier: x.c.riskTier,
  hotspot: x.c.hotspot, breaksContract: x.c.breaksContract,
  commit: x.final && x.final.commitMessage, diffStat: x.final && x.final.diffStat,
  cleanBranch: x.final && x.final.clean,
  benchmarkHint: (x.final && x.final.benchmarkHint) || (invById[x.c.id] || {}).benchmarkHint,
})
const done = finals.filter(Boolean)
const passedBucket = done.filter(x => x.c.breaksContract === 'none').map(enrich)
const breaksContract = done.filter(x => x.c.breaksContract !== 'none').map(enrich)

return {
  glv: GLV, scope: 'gated to `mvn clean install`; NO in-workflow benchmarking/profiling',
  config: { BASE, IMPLEMENT_CAP, MAX_RESEARCH_CANDS, ALLOW_HIGH_CEILING },
  funnel: {
    portfolio: candidates.map(c => c.id),
    viable: viable.map(c => c.id),
    approved: approved.map(x => x.c.id),
    mvnGreen: passed.map(x => x.c.id),
  },
  // Deliverable: each survivor is its OWN branch, sorted into two buckets. The OPERATOR benchmarks.
  passed: passedBucket,                  // green, no contract break — benchmark, then merge
  breaksContract: breaksContract,        // green, but changes public-api/custom-serializer — your call
  nextStep: `Each entry is an independent branch (auto/cand-${GLV}-<id>) that passes the FULL test suite, was reviewed for behavior-equivalence and invariants, and is a single clean commit. Nothing merged/pushed/combined. BENCHMARK each branch yourself (see each entry's benchmarkHint), then merge the ones that prove out — separately.`,
}
