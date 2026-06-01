#!/usr/bin/env bash
# Category 2: Fixed Effective Concurrency (Throughput)
# All GLVs equalized to same in-flight requests: 16, 64, 256.
# Answers: "At the same server pressure, which driver is more efficient?"

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat2-fixed-concurrency"
banner "Category 2: Fixed Effective Concurrency"

EXECUTIONS=3
WARMUPS=5

# 3.7 WS: Java uses pool × maxInProcess for effective concurrency.
# To get exactly C in-flight: pool=ceil(C/64), maxInProcess=min(C,64).
# When C<=64: pool=1, maxInProcess=C. When C>64: pool=ceil(C/64), maxInProcess=64.
# Python/Go/JS/.NET: pool = concurrency (no WS mux in Python/Go; JS/NET have mux but
# we set pool=C for fairness so pool contention is not a factor).

run_tier() {
  local C=$1
  local JAVA_MAX_IN_PROCESS=$C
  local JAVA_POOL=1
  if [ $C -gt 64 ]; then
    JAVA_MAX_IN_PROCESS=64
    JAVA_POOL=$(( (C + 63) / 64 ))
  fi

  section "Effective Concurrency = $C"

  echo "  ┌─ Java (pool=$JAVA_POOL × maxInProcess=$JAVA_MAX_IN_PROCESS = $C) ─┐"
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism 16 \
    requests 100000 \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    minConnectionPoolSize $JAVA_POOL \
    maxConnectionPoolSize $JAVA_POOL \
    maxInProcessPerConnection $JAVA_MAX_IN_PROCESS \
    minInProcessPerConnection $JAVA_MAX_IN_PROCESS 2>&1 | tee "$RESULTS_DIR/java-c${C}.log"

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

  echo "  ┌─ .NET (pool=$JAVA_POOL × maxInProcess=$JAVA_MAX_IN_PROCESS = $C, parallelism=$C) ─┐"
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $JAVA_POOL \
    --max-in-process $JAVA_MAX_IN_PROCESS \
    --requests 500000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/dotnet-c${C}.log"
}

run_tier 16
run_tier 64
run_tier 256

echo ""
echo "═══ Category 2 Complete ═══"
echo "Results: $RESULTS_DIR"
grep "avg req/sec\|req/sec:" "$RESULTS_DIR"/*.log 2>/dev/null | grep -v warmup | tail -20 || true
