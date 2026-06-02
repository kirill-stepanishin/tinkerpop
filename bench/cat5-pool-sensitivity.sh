#!/usr/bin/env bash
# Category 5: Pool Sensitivity
# Fix parallelism high, sweep pool size (4 points per GLV).
# HTTP: pool directly limits concurrency, expect steep curves for all.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat5-pool-sensitivity"
banner "Category 5: Pool Sensitivity"

EXECUTIONS=3
WARMUPS=5

section "Java — Pool Sweep (parallelism=16)"
for POOL in 128 512 2000 5000; do
  echo "--- Java pool=$POOL ---"
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism 16 \
    requests 500000 \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    maxConnectionPoolSize $POOL
done 2>&1 | tee "$RESULTS_DIR/java-pool.log"

section "Go — Pool Sweep (parallelism=256)"
for POOL in 32 128 512 5000; do
  echo "--- Go pool=$POOL ---"
  run_go \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism 256 \
    --pool-size $POOL \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/go-pool.log"

section ".NET — Pool Sweep (parallelism=256)"
for POOL in 64 128 256 1000; do
  echo "--- .NET pool=$POOL ---"
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism 256 \
    --pool-size $POOL \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups 10 \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/dotnet-pool.log"

section "JavaScript — Pool Sweep (parallelism=64)"
for POOL in 8 32 128 256; do
  echo "--- JS pool=$POOL ---"
  run_js \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism 64 \
    --pool-size $POOL \
    --requests 30000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/js-pool.log"

section "Python — Pool Sweep (parallelism=256)"
for POOL in 16 64 128 256; do
  echo "--- Python pool=$POOL ---"
  run_python \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism 256 \
    --pool-size $POOL \
    --requests 3000 \
    --executions $EXECUTIONS \
    --warmups 2 \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/python-pool.log"

echo ""
echo "═══ Category 5 Complete ═══"
echo "Results: $RESULTS_DIR"
echo "Extract: grep -E '(pool=|avg req/sec)' $RESULTS_DIR/*.log"
