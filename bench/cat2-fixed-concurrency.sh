#!/usr/bin/env bash
# Category 2: Fixed Effective Concurrency (Throughput)
# All GLVs equalized to same in-flight requests: 16, 64, 256.
# 4.0 HTTP: pool = concurrency (1 request per connection).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat2-fixed-concurrency"
banner "Category 2: Fixed Effective Concurrency"

EXECUTIONS=3
WARMUPS=5

run_tier() {
  local C=$1

  section "Effective Concurrency = $C"

  echo "  ┌─ Java (pool=$C) ─┐"
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism 16 \
    requests 500000 \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    maxConnectionPoolSize $C 2>&1 | tee "$RESULTS_DIR/java-c${C}.log"

  echo "  ┌─ Python (pool=$C, parallelism=$C) ─┐"
  run_python \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 5000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/python-c${C}.log"

  echo "  ┌─ Go (pool=$C, parallelism=$C) ─┐"
  run_go \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/go-c${C}.log"

  echo "  ┌─ JavaScript (pool=$C, parallelism=$C) ─┐"
  run_js \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/js-c${C}.log"

  echo "  ┌─ .NET (pool=$C, parallelism=$C) ─┐"
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 500000 \
    --executions $EXECUTIONS \
    --warmups 10 \
    --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/dotnet-c${C}.log"
}

run_tier 16
run_tier 64
run_tier 256

echo ""
echo "═══ Category 2 Complete ═══"
echo "Results: $RESULTS_DIR"
grep "avg req/sec\|req/sec:" "$RESULTS_DIR"/*.log 2>/dev/null | grep -v warmup | tail -20 || true
