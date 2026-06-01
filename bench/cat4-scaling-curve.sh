#!/usr/bin/env bash
# Category 4: Concurrency Scaling Curve
# Sweep concurrency from low → high. Pool = concurrency (no pool bottleneck).
# Produces data for "req/s vs concurrency" chart per GLV.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat4-scaling-curve"
banner "Category 4: Concurrency Scaling Curve"

EXECUTIONS=3
WARMUPS=3

section "Java — Scaling"
for C in 1 4 16 64 128 256 512; do
  echo "--- Java concurrency=$C ---"
  POOL=$(( (C + 63) / 64 ))
  [ $POOL -lt 1 ] && POOL=1
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism 16 \
    requests 500000 \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    minConnectionPoolSize $POOL \
    maxConnectionPoolSize $POOL \
    maxInProcessPerConnection 64 \
    minInProcessPerConnection 64
done 2>&1 | tee "$RESULTS_DIR/java-scaling.log"

section "Python — Scaling"
for C in 1 4 8 16 32 64 128 256; do
  echo "--- Python concurrency=$C ---"
  run_python \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 3000 \
    --executions $EXECUTIONS \
    --warmups 2 \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/python-scaling.log"

section "Go — Scaling"
for C in 1 4 16 64 128 256 512; do
  echo "--- Go concurrency=$C ---"
  run_go \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/go-scaling.log"

section "JavaScript — Scaling"
for C in 1 4 8 16 32 64 128 256; do
  echo "--- JavaScript concurrency=$C ---"
  run_js \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/js-scaling.log"

section ".NET — Scaling"
for C in 1 4 16 64 128 256 512; do
  echo "--- .NET concurrency=$C ---"
  POOL=$(( (C + 63) / 64 ))
  [ $POOL -lt 1 ] && POOL=1
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $POOL \
    --max-in-process 64 \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/dotnet-scaling.log"

echo ""
echo "═══ Category 4 Complete ═══"
echo "Results: $RESULTS_DIR"
echo "Extract: grep -E '(concurrency=|avg req/sec)' $RESULTS_DIR/*.log"
