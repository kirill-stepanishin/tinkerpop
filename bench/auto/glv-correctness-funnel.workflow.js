/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file. Apache License 2.0.
 *
 * GLV CORRECTNESS FUNNEL — an autonomous, GLV-parameterized pipeline that discovers,
 * implements, reviews and test-gates GraphBinary deserialization optimizations for a
 * Gremlin Language Variant. Run it with the Claude Code `Workflow` tool:
 *
 *   Workflow({ scriptPath: "bench/auto/glv-correctness-funnel.workflow.js",
 *              args: { glv: "python",              // or "go" | "dotnet" | "javascript"
 *                      profileRoot: "<dir>" } })   // REQUIRED: stored profiling results
 *
 * Both args are required. Setup locates this GLV's profiles under profileRoot, works out
 * which profiler produced them, and distils a ranked hotspot digest that is the ONLY
 * hotspot input the pipeline has. Nothing about where the time goes — no ranking, no
 * filename, no measurement — is hardcoded here. No profile, no run.
 *
 * It stops at a green `mvn clean install` (unit + integration + feature) and never
 * benchmarks. The deliverable is therefore not "proven faster" but "a plausible
 * optimization that passes the FULL suite, reviewed, alone on branch
 * auto/cand-<glv>-<id>, ready for the operator to measure". Survivors are bucketed
 * into `passed` (no contract break) and `breaksContract` (public-API or
 * custom-serializer change — a human call). Nothing is merged, combined, or pushed.
 *
 * Invariants carry the weight precisely BECAUSE there is no benchmark gate: a green
 * suite proves only what the tests assert, not that streaming still streams. HARD
 * invariants auto-prune a candidate; SOFT ones only flag it for the human.
 */

// `meta` must be the first statement and a pure literal.
export const meta = {
  name: 'glv-correctness-funnel',
  description: 'GLV-parameterized: discover, implement, review and gate (unit+integration+feature tests) ' +
      'performance optimizations; each survivor on its own branch for the operator to benchmark + merge',
  phases: [
    { title: 'Setup',       detail: 'confirm toolchain + clean tree, then distil the profile into a hotspot digest', model: 'opus' },
    { title: 'Research',    detail: 'derive lenses from the hotspot digest, then generate ideas one agent per lens', model: 'opus' },
    { title: 'Investigate', detail: 'deep per-candidate study; ruthless prune; two-tier invariant classification', model: 'opus' },
    { title: 'Implement',   detail: 'one agent per candidate in own worktree; code-repair loop; unit gate', model: 'sonnet (opus for restructure/high-ceiling)' },
    { title: 'Review',      detail: 'independent correctness + invariant review before the expensive gate', model: 'opus' },
    { title: 'Correctness', detail: 'mvn clean install incl. integration + feature — strictly serial; <=1 code-repair', model: 'sonnet' },
    { title: 'Report',      detail: 'every test-passing branch, sorted into passed / breaks-contract, ready to benchmark', model: 'haiku' },
  ],
}

// ===========================================================================
//  GLV REGISTRY — the only GLV-specific knowledge. Add a GLV by adding an entry.
// ===========================================================================
const GLV_REGISTRY = {
  python: {
    label: 'gremlin-python',
    module: 'gremlin-python',                        // holds the pom.xml for the mvn gate
    sourceSubdir: 'gremlin-python/src/main/python',  // source + unit tests
    // An editable install resolves to the ORIGINAL tree, so PYTHONPATH must point at the
    // worktree's own source or pytest tests the original code, not the candidate's.
    unitTest: (py) => `cd <worktree>/gremlin-python/src/main/python && ` +
      `PYTHONPATH="$(pwd)" ${py} -m pytest tests/unit/structure/io/ tests/unit/driver/test_http_streaming.py -q`,
    unitToolDesc: 'pytest (no server)',
    // What the gated suite runs, and the log evidence proving it ran (vs a no-op false green).
    suiteDesc: 'pytest integration (~347 tests, no-server unit + server-backed) AND the radish feature/gherkin suite, x3 serializer modes (graphbinary bulked / parameterized / plain)',
    suiteProof: 'a MINUTES-long build whose log shows the docker integration tests plus the radish feature run — typically ~163 features / ~2149 scenarios / ~9890 steps, printed once per mode (x3). A sub-10-second BUILD SUCCESS with no radish/pytest counts means the profile did NOT activate',
    // python/go/dotnet hide the suite behind a gitignored .glv marker a fresh worktree lacks.
    suiteActivation: 'cd <worktree>/gremlin-python && touch .glv  (it is gitignored, so it does not dirty the candidate diff)',
    // The docker-compose context mounts sibling target/ dirs a fresh worktree has not built;
    // without them the first mvn fails in seconds — looks like a suite no-op but is not.
    prereqBuild: 'mvn install -pl gremlin-server,gremlin-test,gremlin-tools/gremlin-socket-server -am -DskipTests',
    sourceGlobs: 'gremlin_python/structure/io/graphbinaryV4.py, driver/serializer.py, driver/connection.py, driver/aiohttp/transport.py',
    testGlobs: 'tests/unit/structure/io/*, tests/unit/driver/test_http_streaming.py',
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
    // A worktree carries its own go.mod, so it is naturally isolated. But `go test ./driver/...`
    // would sweep in server-dependent tests (connection_test.go) that are NOT gated by
    // RUN_INTEGRATION_TESTS and fail with no server up, so target only the server-free hot-path
    // suites; `go build ./...` catches compile breaks elsewhere.
    unitTest: () => `cd <worktree>/gremlin-go && go build ./... && ` +
      `go test ./driver/ -run 'TestGraphBinary|TestSerializer|TestResult|TestGraph|TestGValue' -count=1`,
    unitToolDesc: 'go build + go test (server-free hot-path suites)',
    // Go's gated suite is a docker `go test`, NOT radish — gremlin-go has no .feature files.
    suiteDesc: "the docker-compose Go integration suite: `docker compose up --build --exit-code-from gremlin-go-integration-tests` — go test against a containerized gremlin-server (build SUCCESS requires the integration container to exit 0)",
    suiteProof: 'a MINUTES-long build whose log shows docker compose building images, the gremlin-server container becoming healthy, and the gremlin-go-integration-tests container running `go test` (PASS/ok lines, package timings) and exiting 0. There is NO radish output for Go — do NOT expect feature/scenario/step counts. A sub-10-second BUILD SUCCESS with no docker/go-test activity means the profile did NOT activate',
    suiteActivation: 'cd <worktree>/gremlin-go && touch .glv  (it is gitignored, so it does not dirty the candidate diff)',
    prereqBuild: 'mvn install -pl gremlin-server,gremlin-test,gremlin-tools/gremlin-socket-server -am -DskipTests',
    sourceGlobs: 'gremlin-go/driver/ (GraphBinary reader/serializer, type deserialization, connection/result streaming)',
    testGlobs: 'gremlin-go/driver/*_test.go (GraphBinary + serializer unit tests)',
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

  dotnet: {
    label: 'gremlin-dotnet',
    module: 'gremlin-dotnet',                        // reactor parent (src + test); holds docker-compose.yml
    sourceSubdir: 'gremlin-dotnet/src/Gremlin.Net',  // where the deser source lives
    // Builds from its own csproj/sln, so a worktree is naturally isolated. The cheap pre-filter is
    // the server-FREE UnitTest project (GraphBinary round-trips over MemoryStream); `dotnet test`
    // also builds Gremlin.Net, catching compile breaks. IntegrationTest needs a server — excluded.
    // DOTNET_ROLL_FORWARD lets the net8.0 test HOST launch on a box shipping only a newer runtime.
    unitTest: () => `cd <worktree>/gremlin-dotnet && ` +
      `DOTNET_ROLL_FORWARD=LatestMajor dotnet test test/Gremlin.Net.UnitTest/Gremlin.Net.UnitTest.csproj -c Release`,
    unitToolDesc: 'dotnet test (Gremlin.Net.UnitTest, server-free; DOTNET_ROLL_FORWARD=LatestMajor for net8.0 on a newer runtime)',
    // The gated suite DOES include a Gherkin runner, but xUnit/TRX-framed, not radish.
    suiteDesc: "the docker-compose .NET integration suite: `docker compose up --build --exit-code-from gremlin-dotnet-integration-tests` — `dotnet test ./Gremlin.Net.sln -c Release` (xUnit unit + integration incl. the Gherkin feature runner) plus the three Examples projects, against a containerized gremlin-server (build SUCCESS requires the integration container to exit 0)",
    suiteProof: 'a MINUTES-long build whose log shows docker compose building images, the gremlin-server-test-dotnet container becoming healthy, and the gremlin-dotnet-integration-tests container running `dotnet test ./Gremlin.Net.sln` (xUnit PASS lines incl. Gherkin scenarios and a "Passed!" summary) followed by the three Examples projects, exiting 0. The framing is xUnit/TRX, NOT radish — do NOT expect radish feature/scenario/step counts. A sub-10-second BUILD SUCCESS with no docker/dotnet-test activity means the profile did NOT activate',
    suiteActivation: 'cd <worktree>/gremlin-dotnet && touch src/.glv test/.glv  (CRITICAL: .NET needs BOTH markers — gremlin-dotnet/src/.glv AND gremlin-dotnet/test/.glv. Touching only one leaves the suite a no-op false green. Both are gitignored, so they do not dirty the candidate diff.)',
    prereqBuild: 'mvn install -pl gremlin-server,gremlin-test,gremlin-tools/gremlin-socket-server -am -DskipTests',
    sourceGlobs: 'gremlin-dotnet/src/Gremlin.Net/Structure/IO/GraphBinary4/ (GraphBinaryReader.cs entry/dispatch, TypeSerializerRegistry.cs DataType->serializer lookup, Types/*Serializer.cs per-type readers, StreamExtensions.cs primitive byte reads, ResponseSerializer.cs ReadStreamingAsync decode loop), Driver/Connection.cs + Driver/ResultSet.cs (Channel delivery)',
    testGlobs: 'gremlin-dotnet/test/Gremlin.Net.UnitTest/Structure/IO/GraphBinary4/*.cs (GraphBinary round-trip + serializer unit tests)',
    invariants: {
      hard: [
        'incremental streaming: ResponseSerializer.ReadStreamingAsync must keep yielding each result object as decoded into the Channel (no buffering the whole response before delivery)',
        'bounded memory: no whole-response/whole-body materialization in a single buffer for large results',
      ],
      soft: [
        'public-api: exported types/signatures of GraphBinaryReader/GraphBinaryWriter, ITypeSerializer, DataType (type-code identity), and IMessageSerializer unchanged',
        'custom-serializer: the ProviderDefinedType registry (ProviderDefinedTypeRegistry) and any custom type-handler extension point intact',
      ],
    },
    highCeilingNote: 'The high-ceiling lane for .NET is unsafe/Span/stackalloc/ArrayPool and aggressive async-removal on the innermost decode loop; it is gated like any other change (dotnet test + mvn), no separate build-proof needed since .NET is already compiled.',
  },

  javascript: {
    label: 'gremlin-javascript',
    module: 'gremlin-js/gremlin-javascript',        // holds pom.xml + docker-compose.yml
    // Source of truth is the git-tracked lib/ tree (src/ holds only bin scripts): the driver layer
    // is .ts, the GraphBinary deser hot path plain .js under lib/structure/io/binary/internals/.
    sourceSubdir: 'gremlin-js/gremlin-javascript/lib',
    // An npm WORKSPACE: node_modules is hoisted to gremlin-js/, so a fresh worktree must `npm ci`
    // there first; mocha+ts-node then runs straight against lib/ with no transpile step. The cheap
    // pre-filter is the server-free GraphBinary + result-set/structure suites; connection-, client-,
    // traversal- and auth-test construct a Client and need a server, so they are excluded.
    unitTest: () => `cd <worktree>/gremlin-js && npm ci && cd <worktree>/gremlin-js/gremlin-javascript && ` +
      `npx cross-env TS_NODE_PROJECT='tsconfig.test.json' mocha 'test/unit/graphbinary/**/*.{js,ts}' ` +
      `test/unit/result-set-test.js test/unit/structure-types-test.js test/unit/graph-serializer-test.js`,
    unitToolDesc: 'mocha+ts-node (server-free GraphBinary + result-set/structure unit suites; npm ci first because node_modules is workspace-hoisted)',
    // DIVERGENCE: JS has no .glv marker — its docker profile (glv-js) is activeByDefault, so plain
    // `mvn clean install` already runs the suite. The false-green trap is the skipTests flag instead.
    suiteDesc: "the docker-compose JS integration suite: `docker compose up --build --exit-code-from gremlin-js-integration-tests` — inside the node container `npm ci && npm run test` (mocha unit + graphbinary integration) then `npm run features-docker` (cucumber-js feature/gherkin suite) then the three examples/node scripts, against a containerized gremlin-server (build SUCCESS requires the integration container to exit 0)",
    suiteProof: 'a MINUTES-long build whose log shows docker compose building images, the gremlin-server-test-js container becoming healthy, and the gremlin-js-integration-tests container running `npm ci`, the mocha unit+integration passing counts, the cucumber-js feature run (scenario/step counts), and the three node examples printing "All examples completed successfully", exiting 0. The framing is mocha + cucumber-js, NOT radish. A sub-10-second BUILD SUCCESS with no docker/npm activity means the integration exec was skipped (skipTests) — do NOT pass any -DskipTests / -Dmaven.test.skip flag',
    suiteActivation: 'NOTHING TO TOUCH — gremlin-javascript has no .glv marker; the docker integration profile (glv-js) is activeByDefault=true, so `mvn clean install` runs it automatically. Your job is the OPPOSITE: do NOT pass -DskipTests or -Dmaven.test.skip=true (either makes the integration exec a no-op false green). Run a plain `mvn clean install -Dasciidoc.skip=true`.',
    prereqBuild: 'mvn install -pl gremlin-server,gremlin-test,gremlin-tools/gremlin-socket-server -am -DskipTests',
    sourceGlobs: 'gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/ (StreamReader.js async-per-read primitive reads, AnySerializer.js per-element type dispatch (2x readUInt8), GraphBinaryReader.js readResponseStream decode loop + per-type *Serializer.js readers, DataType.js type-code map), lib/driver/connection.ts (stream() incremental path vs submit()/#handleResponse buffered path) + lib/driver/result-set.ts',
    testGlobs: 'gremlin-js/gremlin-javascript/test/unit/graphbinary/*.{js,ts} (GraphBinary round-trip + StreamReader unit tests), test/unit/result-set-test.js',
    invariants: {
      hard: [
        'incremental streaming: connection.ts stream() -> GraphBinaryReader.readResponseStream must keep yielding each result object as decoded from the StreamReader (no buffering the whole response before delivery); the separate buffered submit()/#handleResponse path may stay buffered but must not become the only path',
        'bounded memory: no NEW whole-response materialization on the streaming path (do not collect all decoded elements into one array before yielding)',
      ],
      soft: [
        'public-api: exported types/signatures of GraphBinaryReader/GraphBinaryWriter, the per-type Serializer interface (serialize/deserialize/deserializeValue), DataType type-code identity, and ResultSet unchanged',
        'custom-serializer: the provider-defined-type registry (CompositePDTSerializer / pdtRegistry) and any custom type-handler extension point intact',
      ],
    },
    highCeilingNote: 'The high-ceiling lane for JS is full removal of async on the innermost decode loop (a synchronous decoder over the already-buffered body) and direct Buffer-offset reads bypassing the stateful StreamReader; it is gated like any other change (mocha + mvn docker suite), no separate build-proof needed since JS needs no compile step for the unit gate.',
  },
}

// ---- normalize args -----------------------------------------------------------
// The harness may hand `args` over as a JSON-encoded STRING. A string is truthy, so a
// naive `args && args.glv` would pass the guard yet read undefined off the string.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
if (!A || typeof A !== 'object') A = {}

const GLV = A.glv || 'python'
const G = GLV_REGISTRY[GLV]
if (!G) throw new Error(`unknown glv '${GLV}'. Known: ${Object.keys(GLV_REGISTRY).join(', ')}`)

// ---- knobs (override any of these via args) -----------------------------------
const REPO       = A.repo   || '.'        // repo root
const BASE       = A.base   || 'master'   // branch candidates fork from
const VENV_PY    = A.python || 'python3'  // python lane: interpreter with the driver + pytest
// REQUIRED: the stored profiling results are the pipeline's only hotspot input. Setup
// locates this GLV's profiles underneath it — no directory layout is assumed here.
const PROFILE_ROOT = A.profileRoot
if (!PROFILE_ROOT) throw new Error('args.profileRoot is required — it is the only hotspot input this pipeline has')
const ALLOW_HIGH_CEILING = A.allowHighCeiling !== false  // default ON
const LENS_COUNT         = A.lensCount    || 6      // research fan-out width
const MAX_RESEARCH_CANDS = A.maxResearch  || 10
const IMPLEMENT_CAP      = A.implementCap || 6      // narrow the serial mvn tail
const REPAIR_CHEAP = A.repairCheap || 2             // code-repair attempts at the unit stage
const REPAIR_MVN   = A.repairMvn   || 1             // code-repair attempts at the mvn gate

// ---- schemas ------------------------------------------------------------------
const SETUP = {
  type: 'object', required: ['ok'], properties: {
    ok: { type: 'boolean', description: 'true only if toolchain present and tree is in a usable, committed state' },
    toolchain: { type: 'string', description: 'what was verified (e.g. python+pytest, or go+mvn)' },
    treeClean: { type: 'boolean' }, abortReason: { type: 'string' }, notes: { type: 'string' },
    profileFound: { type: 'boolean', description: 'true only if this GLV\'s profiling results were found and read; false ABORTS the run' },
    profileDir: { type: 'string', description: 'the directory the profiles were actually read from' },
    profileDigest: { type: 'string', description: 'ranked hotspot summary distilled from the stored profiles; the only hotspot input Research gets' },
  },
}
const LENS_PLAN = {
  type: 'object', required: ['lenses'], properties: { lenses: { type: 'array', items: {
    type: 'object', required: ['lens', 'highCeiling'],
    properties: {
      lens: { type: 'string', description: 'the attack surface + kind of change, incl. its boundary and the idiomatic techniques that apply; injected verbatim as one agent\'s brief' },
      hotspotsCovered: { type: 'string', description: 'which ranked digest hotspot(s) this lens attacks' },
      highCeiling: { type: 'boolean', description: 'true for the one aggressive/unsafe-lane lens' },
    } } } },
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
    suiteRan: { type: 'boolean', description: 'true ONLY if the gated integration suite ACTUALLY executed (a minutes-long build with real test evidence per the GLV proof: radish feature/scenario counts for python, the docker go-test integration container for go, xUnit/Gherkin for dotnet, mocha+cucumber-js for javascript). A sub-10s BUILD SUCCESS means the suite did not activate (a missing .glv marker for python/go/dotnet, or a skipTests flag for javascript) => false. fullSuiteGreen with suiteRan=false is a false green and is dropped.' },
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

const hardList = G.invariants.hard.map(s => '   - ' + s).join('\n')
const softList = G.invariants.soft.map(s => '   - ' + s).join('\n')

// =================================================================================
// PHASE 0 — SETUP. Confirm the toolchain and a committed tree; no server, no baseline.
// Also distills the stored profile into the ranked hotspot digest every later phase
// reasons from: the script runtime cannot read files but this agent can, so the digest
// travels back in the structured result. BLOCKING — no digest, no run.
phase('Setup')
log(`Correctness funnel for glv=${GLV} (${G.label}). Gated to 'mvn clean install'; operator benchmarks after.`)

const rig = await agent(
`Light setup check for the ${G.label} correctness funnel (NO server, NO benchmarking).
Confirm the toolchain needed to (a) run unit tests and (b) run 'mvn clean install -Dasciidoc.skip=true'
for ${G.module}:
${GLV === 'python'
  ? `- ${VENV_PY} runs and can import the package + pytest (unit tool: ${G.unitToolDesc}).`
  : GLV === 'dotnet'
  ? `- 'dotnet' (SDK) and 'mvn' are on PATH; 'dotnet test' runs the Gremlin.Net.UnitTest project (unit tool: ${G.unitToolDesc}).`
  : GLV === 'javascript'
  ? `- 'node' (>=22), 'npm' and 'mvn' are on PATH; from the gremlin-js workspace root 'npm ci' then mocha runs the server-free GraphBinary unit suites (unit tool: ${G.unitToolDesc}). node_modules is workspace-hoisted to gremlin-js/, so a fresh worktree installs there.`
  : `- 'go' and 'mvn' are on PATH; 'go vet'/'go test' run in ${G.module} (unit tool: ${G.unitToolDesc}).`}
- docker is available (the mvn gate is docker-compose orchestrated).
- the working tree at ${REPO} is committed enough that worktrees can fork from ${BASE} (treeClean).
Apply only trivial fixes (e.g. pip install pytest into the venv). If the toolchain is unusable, set
ok=false with abortReason.

PROFILING DIGEST — the load-bearing task of this phase; nothing downstream knows where the time goes
except through what you write here, so do it carefully.
Stored profiling results live under ${PROFILE_ROOT}. Find this GLV's own results there (look for a
subdirectory named for ${G.label} or its language, whichever convention that tree uses), then work out
what you have: the file extensions and names tell you which profiler produced them and which are raw
traces vs a written analysis. If an analysis document is present, read it FIRST — it may already rank the
decode tower — then confirm its claims against the raw data rather than trusting it wholesale.
Distill a COMPACT, RANKED hotspot digest into 'profileDigest' (set profileFound=true):
- The top decode/deserialization hot spots by SELF cost, each with function + file:line where you can find
  it, the metric (CPU self% or wall, and/or allocation count/bytes), and one phrase on WHY it is hot.
- Interpret each profiler on its own terms — self vs cumulative cost are different questions, and sampling
  profilers attribute idle/scheduling time (server wait, thread-pool park/spin, GC polling) as if it were
  on-CPU work. Identify any such artifact and DISCOUNT it; report it as an artifact instead of ranking it
  hot, and say which signal you ranked by instead.
- Note pre-existing failures in the profile output as out-of-scope rather than as regressions.
- 12-25 lines, concrete and source-anchored — this text is injected verbatim into the Research prompts, so
  it must let an engineer go straight to the right functions. Do NOT propose fixes here; just rank reality.
Record the directory you actually read in 'profileDir'. If you cannot find profiling results for this GLV,
or they are unreadable, set profileFound=false AND ok=false with an abortReason saying so — without a
profile this pipeline has no hotspots to work from and MUST NOT proceed on guesswork.
Return ONLY the structured object.`,
  { phase: 'Setup', schema: SETUP, model: 'opus' })

if (!rig || !rig.ok) { log(`ABORT: setup — ${rig && rig.abortReason}`); return { aborted: true, glv: GLV, reason: (rig && rig.abortReason) || 'setup failed', rig } }
if (!rig.profileFound || !rig.profileDigest) {
  log(`ABORT: no hotspot digest under ${PROFILE_ROOT} — refusing to research on guesswork`)
  return { aborted: true, glv: GLV, reason: `no profiling data for ${GLV} under ${PROFILE_ROOT}`, rig }
}
const profileDir = rig.profileDir || PROFILE_ROOT
log(`Setup OK (${rig.toolchain}). Hotspot digest read from ${profileDir}.`)

// Shared context for every phase, built after Setup so it carries the digest.
const SHARED =
`Target: ${G.label} GraphBinary DESERIALIZATION hot path (repo ${REPO}).
Read the source to ground every claim: ${G.sourceGlobs}. Tests: ${G.testGlobs}.

MEASURED HOTSPOTS (distilled from real profiling at ${profileDir} — this is the AUTHORITATIVE ranking and
the ONLY hotspot data you get; prioritize ideas that attack these, and verify each against the source before
claiming anything. If something is not in here, do not assume it is hot):
${rig.profileDigest}

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
// PHASE 1 — RESEARCH. Lenses are DERIVED from the digest, not hardcoded: one planner
// agent partitions the measured hotspots into disjoint attack surfaces, then one agent
// generates ideas per lens. That keeps the fan-out aimed at where the time actually is
// for THIS GLV, and keeps language-specific technique lists out of this script.
phase('Research')
const plan = await agent(
`${SHARED}

Plan the RESEARCH FAN-OUT for ${G.label}. You are not generating optimization ideas — you are dividing the
work so that independent agents can, one per lens, in parallel.

A "lens" is one attack surface: a bounded area of the decode path plus the KIND of change appropriate to it.
Derive them from the MEASURED HOTSPOTS above and from reading the source — not from generic advice, and not
from what would be idiomatic in some other language. Produce ${LENS_COUNT} lenses that:
- COVER the ranked hotspots: every significant entry in the digest must fall inside at least one lens. Spend
  more lenses on the costlier areas; do not spend one on something the profile shows is cheap.
- are DISJOINT: two agents working different lenses should not converge on the same edit. State each lens's
  boundary well enough that a reader knows what is out of scope for it.
- span a RISK LADDER: at least one lens must be small/local low-risk tweaks and at least one a large
  structural refactor of the reader, with the rest in between. Breadth of risk is the point — the cheap
  tweaks are the reliable wins and the refactors are the upside.
- name the ${G.label}-idiomatic techniques that apply, in the lens text, so its agent starts from the right
  vocabulary for this language.
${ALLOW_HIGH_CEILING
  ? `- include EXACTLY ONE lens with highCeiling=true for the aggressive lane (${G.highCeilingNote})`
  : '- do NOT include a high-ceiling lens; set highCeiling=false on all of them.'}
For each lens give the lens text itself, which digest hotspot(s) it attacks, and highCeiling.
Return ONLY the structured object.`,
  { phase: 'Research', label: 'research:plan-lenses', schema: LENS_PLAN, model: 'opus' })

const LENSES = (A.lenses
    ? A.lenses.map(l => (typeof l === 'string' ? { lens: l, highCeiling: /high-ceiling/i.test(l) } : l))
    : (plan && plan.lenses) || []
  ).filter(l => l && l.lens && (ALLOW_HIGH_CEILING || !l.highCeiling))
if (!LENSES.length) return { error: 'lens planning produced no lenses', glv: GLV, plan }
log(`Lenses (${LENSES.length}): ${LENSES.map(l => l.lens.split(/[(:—]/)[0].trim()).join(' | ')}`)

const lensFindings = await parallel(LENSES.map((l, i) => () => agent(
`${SHARED}

YOUR LENS: ${l.lens}
It was chosen to attack these measured hotspots: ${l.hotspotsCovered || '(see the ranked digest above)'}.
Generate concrete ideas ONLY within this lens — tiny tweaks to large refactors as it implies. Stay inside
your boundary; other agents are covering the other lenses in parallel. For each idea:
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
  { phase: 'Research', label: 'research:synthesize', schema: PORTFOLIO, model: 'sonnet' })

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
      // Local edits are Sonnet work; the big rewrites get Opus.
      model: (c.riskTier === 'restructure' || c.riskTier === 'high-ceiling') ? 'opus' : 'sonnet' }),
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
// PHASE 5 — CORRECTNESS. mvn clean install (unit+integration+feature), STRICTLY SERIAL
// because the docker suite binds fixed ports. <=1 code-repair; a repair re-enters Review.
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

STEP 1 — BUILD UPSTREAM PREREQUISITES (a fresh worktree needs these or the docker gate fails fast):
  The ${G.module} docker-compose build context mounts sibling target/ artifacts (gremlin-test/target etc.)
  that a fresh worktree has NOT built. Without them the FIRST 'mvn clean install' fails in seconds on a
  missing docker build context — looks like a suite no-op but is NOT. From the WORKTREE ROOT, build them once:
    cd <worktree> && ${G.prereqBuild}
  (Heavy but cached; only the first build in a fresh worktree pays it.) If this step itself fails, capture it
  in failTail — it is an environment/setup failure, NOT a candidate code bug, so do NOT spend code-repair on it.

STEP 2 — ENSURE THE FULL SUITE WILL RUN (CRITICAL — otherwise mvn is a NO-OP false green):
  The ${G.module} integration suite (${G.suiteDesc}) is gated. If it does not run, 'mvn clean install' will
  BUILD SUCCESS in seconds while executing ZERO integration tests. For ${G.label} the activation is:
    ${G.suiteActivation}

STEP 3 — RUN IT:
  cd <worktree>/${G.module} && docker compose down || true   # clear any stale stack first
  mvn clean install -Dasciidoc.skip=true
Run it in the BACKGROUND and POLL to completion (the build far exceeds the 10-min Bash cap — do NOT block
a single call on it; poll with short status checks so progress is visible). Only one build runs at a time,
so the fixed docker host ports the suite binds (e.g. 45940-45943 / 4588 / 8182, per GLV) are free.

STEP 4 — PROVE THE SUITE ACTUALLY RAN (false-green guard): the proof for ${G.label} is: ${G.suiteProof}.
Set suiteRan=true ONLY if you saw that evidence with your own eyes in the build log, and QUOTE the lines that
show it in summary — the actual counts/container lines, not a paraphrase. If you cannot quote them, you did
not see them: set suiteRan=false, fullSuiteGreen=false and go back to STEP 2 (suite activation) — or STEP 1
if the failure was a missing build context. A BUILD SUCCESS is NOT itself evidence; do not infer the suite
ran because the build passed, and never assume it ran because it was supposed to.

CODE-REPAIR: if it fails on a CODE bug, you MAY fix YOUR OWN code (NEVER a test) and retry up to
${REPAIR_MVN} time(s); set repairedAtMvn=true if you changed code. fullSuiteGreen=true ONLY on a real BUILD
SUCCESS with suiteRan=true. On failure capture the failing test/section in failTail. Return ONLY the object.`,
    // Mostly recipe-execution and polling; the one judgment (suiteRan) is pinned to
    // quotable log evidence, and the script re-checks it structurally below.
    { phase: 'Correctness', label: `mvn:${c.id}`, schema: MVN, model: 'sonnet' })
  if (m && m.fullSuiteGreen && m.suiteRan === false) {
    log(`DROP ${c.id}: mvn gate reported green but suiteRan=false (suite-not-activated false-green) — ${m.summary}`); continue
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
// PHASE 6 — FINALIZE + REPORT. Each survivor becomes a clean standalone branch.
phase('Report')
const finals = await parallel(passed.map(x => () => agent(
`Finalize candidate "${x.c.id}" as a clean STANDALONE branch auto/cand-${GLV}-${x.c.id} (do NOT merge, do
NOT push). In its worktree: squash WIP into ONE commit that is a single-purpose, mergeable diff vs ${BASE};
write a concise imperative commit subject (<=50 chars, capitalized, no trailing period, no
conventional-commit prefix). Keep the diff PURE.
Report branch, clean (single-purpose vs ${BASE}), diffStat, commitMessage, and benchmarkHint (what the
operator should measure to confirm this change actually improves performance). Return ONLY the object.`,
  { phase: 'Report', label: `finalize:${x.c.id}`, schema: FINALIZE, model: 'haiku' })
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
  passed: passedBucket,                  // green, no contract break — benchmark, then merge
  breaksContract: breaksContract,        // green, but changes public-api/custom-serializer — your call
  nextStep: `Each entry is an independent branch (auto/cand-${GLV}-<id>) that passes the FULL test suite, was reviewed for behavior-equivalence and invariants, and is a single clean commit. Nothing merged/pushed/combined. BENCHMARK each branch yourself (see each entry's benchmarkHint), then merge the ones that prove out — separately.`,
}
