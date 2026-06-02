#!/usr/bin/env bash
# Category 4: Concurrency Scaling Curve
# Sweep concurrency from 4 → 5000 (higher range for HTTP since pool=concurrency).
# Also serves as the "fixed concurrency" comparison (replaces old Cat 2).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat4-scaling-curve"
banner "Category 4: Concurrency Scaling Curve"

EXECUTIONS=3
WARMUPS=5

# Request counts scaled by expected throughput.
java_requests() {
  local C=$1
  # Java 4.0 with pool=C scales well. At C=5000 expect ~35K req/sec.
  if [ $C -le 64 ]; then echo 100000
  else echo 500000
  fi
}

fast_glv_requests() {
  local C=$1
  if [ $C -le 8 ]; then echo 5000
  elif [ $C -le 32 ]; then echo 10000
  elif [ $C -le 128 ]; then echo 30000
  else echo 50000
  fi
}

python_requests() {
  local C=$1
  if [ $C -le 8 ]; then echo 1000
  elif [ $C -le 64 ]; then echo 3000
  else echo 5000
  fi
}

section "Java — Scaling"
for C in 4 16 64 256 512 1000 5000; do
  echo "--- Java concurrency=$C ---"
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism 16 \
    requests $(java_requests $C) \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    maxConnectionPoolSize $C
done 2>&1 | tee "$RESULTS_DIR/java-scaling.log"

section "Go — Scaling"
for C in 4 16 64 128 256 512 1000; do
  echo "--- Go concurrency=$C ---"
  run_go \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests $(fast_glv_requests $C) \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/go-scaling.log"

section ".NET — Scaling"
for C in 4 16 64 128 256 512 1000; do
  echo "--- .NET concurrency=$C ---"
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests $(fast_glv_requests $C) \
    --executions $EXECUTIONS \
    --warmups 10 \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/dotnet-scaling.log"

section "JavaScript — Scaling"
for C in 4 16 64 128 256; do
  echo "--- JavaScript concurrency=$C ---"
  run_js \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests $(fast_glv_requests $C) \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/js-scaling.log"

section "Python — Scaling"
for C in 4 16 64 128 256; do
  echo "--- Python concurrency=$C ---"
  run_python \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests $(python_requests $C) \
    --executions $EXECUTIONS \
    --warmups 2 \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/python-scaling.log"

echo ""
echo "═══ Category 4 Complete ═══"
echo "Results: $RESULTS_DIR"
echo "Extract: grep -E '(concurrency=|avg req/sec)' $RESULTS_DIR/*.log"
