#!/usr/bin/env bash
# Category 1: Protocol Overhead (Latency)
# Sequential requests, pool=1. Measures per-request transport cost.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat1-protocol-overhead"
banner "Category 1: Protocol Overhead (Latency)"

# ─── Test 1a: Tiny — g.V() ──────────────────────────────────────
section "Test 1a: g.V() — 6 vertices"

section "  Java"
run_java \
  testType 0 \
  host "$BENCH_HOST" \
  script "g.V()" \
  maxConnectionPoolSize 1 \
  warmups 3 \
  executions 3 2>&1 | tee "$RESULTS_DIR/java-latency-tiny.log"

section "  Go"
run_go \
  --test-type latency \
  --host "$BENCH_HOST" \
  --script "g.V()" \
  --pool-size 1 \
  --warmups 3 \
  --executions 3 2>&1 | tee "$RESULTS_DIR/go-latency-tiny.log"

section "  .NET"
run_dotnet \
  --test-type latency \
  --host "$BENCH_HOST" \
  --script "g.V()" \
  --pool-size 1 \
  --warmups 3 \
  --executions 3 2>&1 | tee "$RESULTS_DIR/dotnet-latency-tiny.log"

section "  JavaScript"
run_js \
  --test-type latency \
  --host "$BENCH_HOST" \
  --script "g.V()" \
  --pool-size 1 \
  --warmups 3 \
  --executions 3 2>&1 | tee "$RESULTS_DIR/js-latency-tiny.log"

section "  Python"
run_python \
  --test-type latency \
  --host "$BENCH_HOST" \
  --script "g.V()" \
  --pool-size 1 \
  --warmups 3 \
  --executions 3 2>&1 | tee "$RESULTS_DIR/python-latency-tiny.log"

# ─── Test 1b: Medium — ~354K vertices ───────────────────────────
section "Test 1b: g.V().repeat(both()).times(12) — ~354K vertices (Java/Go/.NET only)"

section "  Java"
run_java \
  testType 0 \
  host "$BENCH_HOST" \
  script "g.V().repeat(both()).times(12)" \
  maxConnectionPoolSize 1 \
  warmups 2 \
  executions 3 \
  timeout 600000 2>&1 | tee "$RESULTS_DIR/java-latency-medium.log"

section "  Go"
run_go \
  --test-type latency \
  --host "$BENCH_HOST" \
  --script "g.V().repeat(both()).times(12)" \
  --pool-size 1 \
  --warmups 2 \
  --executions 3 \
  --timeout 600000 2>&1 | tee "$RESULTS_DIR/go-latency-medium.log"

section "  .NET"
run_dotnet \
  --test-type latency \
  --host "$BENCH_HOST" \
  --script "g.V().repeat(both()).times(12)" \
  --pool-size 1 \
  --warmups 2 \
  --executions 3 \
  --timeout 600000 2>&1 | tee "$RESULTS_DIR/dotnet-latency-medium.log"

echo ""
echo "═══ Category 1 Complete ═══"
echo "Results: $RESULTS_DIR"
grep "avg latency" "$RESULTS_DIR"/*.log 2>/dev/null || true
