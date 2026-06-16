/*
 * GLV RECOVERY GATE — re-run the FULL mvn correctness gate for candidates that the main
 * funnel (run wf_f873c85b-825) implemented + reviewed but never gated (branch-naming bug),
 * plus one false-green that needs a real gate. Candidates are ALREADY implemented on their
 * branches; this workflow ONLY gates them (no research/investigate/implement). Strictly
 * serial — Docker fixed ports 45940/8182, one build at a time. Nothing merged or pushed.
 *
 * Each branch is gated with the corrected logic: activate the .glv profile (else mvn is a
 * no-op false green), prove the integration+feature suite actually ran, then finalize.
 */
export const meta = {
  name: 'glv-recovery-gate',
  description: 'Serial full mvn gate (unit+integration+radish) for 7 recovered gremlin-python deser candidates; each survivor stays on its own branch for manual benchmarking. Nothing merged/pushed.',
  phases: [
    { title: 'Gate',   detail: 'serial mvn clean install (.glv-activated) per branch; <=1 code-repair', model: 'opus' },
    { title: 'Report', detail: 'sort survivors into passed / breaks-contract', },
  ],
}

const REPO = '/Users/kiristep/dev/tinkerpop'
const BASE = 'de50057c9e'          // 4-glv-profiling tip — the correct base all candidates fork from
const MODULE = 'gremlin-python'
const REPAIR_MVN = 2

// The recovery work-list. branch = the git branch holding the candidate's single commit.
// contract: 'none' | 'public-api' | 'custom-serializer' (from the funnel's investigation).
const CANDIDATES = [
  { id: 'inline-type-byte-read',                  branch: 'recovery/cand-python-inline-type-byte-read',                  contract: 'none' },
  { id: 'marker-sentinel-fast-eq',                branch: 'recovery/cand-python-marker-sentinel-fast-eq',                contract: 'none' },
  { id: 'inline-null-flag-scalars',               branch: 'recovery/cand-python-inline-null-flag-scalars',               contract: 'custom-serializer' },
  { id: 'inline-element-init',                     branch: 'recovery/cand-python-inline-element-init',                     contract: 'none' },
  { id: 'null-code-module-const',                  branch: 'recovery/cand-python-null-code-module-const',                  contract: 'none' },
  { id: 'vertexproperty-single-properties-write',  branch: 'recovery/cand-python-vertexproperty-single-properties-write',  contract: 'none' },
  { id: 'read-object-bypass-in-collections',       branch: 'auto/cand-python-read-object-bypass-in-collections',           contract: 'none' },  // re-gate false-green
]

const HARD = [
  'incremental streaming: connection.py _receive yields each object as decoded (no whole-response buffering)',
  'bounded memory: no whole-body materialization (do NOT introduce io.BytesIO(read_body) or equivalent)',
].map(s => '   - ' + s).join('\n')

const MVN = {
  type: 'object', required: ['id', 'fullSuiteGreen', 'suiteRan', 'summary'], properties: {
    id: { type: 'string' }, fullSuiteGreen: { type: 'boolean' },
    suiteRan: { type: 'boolean', description: 'true ONLY if the integration+feature(radish) suite ACTUALLY executed (minutes-long build, real feature/scenario/step counts). A sub-10s BUILD SUCCESS means the .glv profile did NOT activate => false.' },
    integrationGreen: { type: 'boolean' }, featureGreen: { type: 'boolean' },
    featureCounts: { type: 'string', description: 'e.g. "163 features / 2149 scenarios / 9890 steps x3 modes" — the proof the suite ran' },
    buildMinutes: { type: 'number', description: 'wall-clock minutes of the successful build (sanity: a real full run is many minutes, not seconds)' },
    repairedAtMvn: { type: 'boolean' }, failTail: { type: 'string' }, summary: { type: 'string' },
  },
}
const REVIEW = {
  type: 'object', required: ['id', 'approved', 'verdict'], properties: {
    id: { type: 'string' }, approved: { type: 'boolean' }, touchedTests: { type: 'boolean' },
    correctnessIssues: { type: 'array', items: { type: 'string' } },
    invariantIssues: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
}
const FINALIZE = {
  type: 'object', required: ['id', 'branch', 'clean'], properties: {
    id: { type: 'string' }, branch: { type: 'string' }, clean: { type: 'boolean' },
    commitMessage: { type: 'string' }, diffStat: { type: 'string' }, benchmarkHint: { type: 'string' },
  },
}

phase('Gate')
log(`Recovery gate: ${CANDIDATES.length} gremlin-python candidates, strictly serial (Docker ports 45940/8182). Base ${BASE}. Nothing merged/pushed.`)

const passed = []
for (const c of CANDIDATES) {
  const m = await agent(
`Run the FULL correctness gate for ALREADY-IMPLEMENTED candidate "${c.id}" on branch ${c.branch} (repo ${REPO}).
This candidate's code is one commit on that branch; you are NOT implementing anything — only gating.

STEP 0 — LOCATE / CHECK OUT the branch in a worktree:
  In ${REPO}: 'git worktree list'. If a worktree is already on ${c.branch}, use it. Otherwise add one:
    git -C ${REPO} worktree add --force ${REPO}/.claude/worktrees/gate-${c.id} ${c.branch}
  Verify HEAD is exactly one commit ahead of ${BASE} and touches the gremlin-python deser source
  ('git rev-list --count ${BASE}..HEAD' == 1; 'git show --stat HEAD' touches structure/io/graphbinaryV4.py,
  structure/graph.py, or driver/serializer.py). If not, set fullSuiteGreen=false/suiteRan=false and explain.

STEP 1 — ACTIVATE THE FULL SUITE (CRITICAL): ${MODULE} integration + feature (radish) tests live in a maven
  profile activated ONLY by a gitignored marker '${MODULE}/.glv'. Without it 'mvn clean install' BUILD-SUCCEEDS
  in seconds running ZERO integration/feature tests (a FALSE GREEN). You MUST:
    cd <worktree>/${MODULE} && touch .glv

STEP 2 — RUN (in BACKGROUND, POLL to completion; far exceeds the 10-min Bash cap — never block one call on it):
    cd <worktree>/${MODULE} && docker compose down || true
    mvn clean install -Dasciidoc.skip=true
  Only one build runs at a time so ports 45940/8182 are free.

STEP 3 — PROVE THE SUITE RAN (false-green guard): a real run takes MINUTES and the log shows the docker
  integration tests + radish feature run (many features/scenarios/steps, typically ~160 features x3 modes).
  Set suiteRan=true and fill featureCounts + buildMinutes ONLY if you saw that. A sub-10-second BUILD SUCCESS
  => the profile did NOT activate => suiteRan=false, fullSuiteGreen=false, go back to STEP 1.

CODE-REPAIR: if it fails on a genuine CODE bug in the candidate, you MAY fix the candidate's OWN code
(NEVER a test, NEVER weaken/skip one) and retry up to ${REPAIR_MVN} times; set repairedAtMvn=true if you
changed code. If a failure is clearly pre-existing/environmental (e.g. a stale gremlin-socket-server jar
failing on base too, unrelated to GraphBinary deser), say so in failTail but still set fullSuiteGreen=false
unless the canonical 'mvn clean install' itself exits 0.
fullSuiteGreen=true ONLY on a real BUILD SUCCESS with suiteRan=true. Return ONLY the structured object.`,
    { phase: 'Gate', label: `mvn:${c.id}`, schema: MVN, model: 'opus' })

  if (!m || !m.fullSuiteGreen) { log(`DROP ${c.id}: mvn gate — ${m && m.summary}`); continue }
  if (m.suiteRan === false) { log(`DROP ${c.id}: false green (suiteRan=false, .glv no-op)`); continue }

  if (m.repairedAtMvn) {
    const r2 = await agent(
`Re-review candidate "${c.id}" (branch ${c.branch}) — its code was REPAIRED during the mvn gate.
Read the CURRENT diff vs ${BASE} in the worktree. Bar: behavior-equivalence across ALL GraphBinary types
(ints incl. negative/boundary, floats, strings, null, bulked lists, maps, vertex/edge/path), tests
UNTOUCHED (touchedTests=true => approved=false), and the HARD invariants intact:
${HARD}
This candidate's declared soft-contract impact is '${c.contract}' (public-api/custom-serializer changes are
NOTED but do NOT by themselves fail the review). approved=false on any correctness or HARD-invariant break.
Return ONLY the structured object.`,
      { phase: 'Gate', label: `re-review:${c.id}`, schema: REVIEW, model: 'opus' })
    if (!r2 || !r2.approved || r2.touchedTests) { log(`DROP ${c.id}: re-review after repair failed — ${r2 && r2.verdict}`); continue }
  }
  log(`GREEN ${c.id}: ${m.featureCounts || ''} (${m.buildMinutes || '?'} min)`)
  passed.push({ c, mvn: m })
}
log(`Recovery mvn-green: ${passed.length}/${CANDIDATES.length} — ${passed.map(x => x.c.id).join(', ') || 'none'}`)

phase('Report')
const finals = await parallel(passed.map(x => () => agent(
`Finalize recovered candidate "${x.c.id}" as a clean STANDALONE branch ${x.c.branch} (do NOT merge, do NOT
push). In its worktree: ensure the candidate is ONE clean commit that is a single-purpose, mergeable diff vs
${BASE}; if there are stray WIP commits squash them into one with a concise imperative subject (<=50 chars,
capitalized, no trailing period, no conventional-commit prefix). Keep the diff PURE (no .glv, no build junk).
Report branch, clean (single-purpose vs ${BASE}), diffStat, commitMessage, and a benchmarkHint (what the
operator should measure to confirm this change improves GraphBinary deserialization). Return ONLY the object.`,
  { phase: 'Report', label: `finalize:${x.c.id}`, schema: FINALIZE })
  .then(f => ({ ...x, final: f }))))

const done = finals.filter(Boolean)
const enrich = (x) => ({
  id: x.c.id, branch: x.c.branch, contract: x.c.contract,
  featureCounts: x.mvn.featureCounts, buildMinutes: x.mvn.buildMinutes,
  commit: x.final && x.final.commitMessage, diffStat: x.final && x.final.diffStat,
  cleanBranch: x.final && x.final.clean, benchmarkHint: x.final && x.final.benchmarkHint,
})
return {
  glv: 'python', scope: 'RECOVERY gate of pre-implemented candidates; gated to `mvn clean install`; NO benchmarking',
  base: BASE,
  gated: CANDIDATES.map(c => c.id),
  mvnGreen: passed.map(x => x.c.id),
  passed: done.filter(x => x.c.contract === 'none').map(enrich),
  breaksContract: done.filter(x => x.c.contract !== 'none').map(enrich),
  nextStep: 'Each entry is an independent branch that now passes the FULL test suite (verified suiteRan). Nothing merged/pushed. BENCHMARK each branch by hand (see benchmarkHint), then merge the winners separately.',
}
