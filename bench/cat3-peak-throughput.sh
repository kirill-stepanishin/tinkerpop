#!/usr/bin/env bash
# Category 3: Peak Throughput (Optimal Tuning)
# Each GLV at best-known settings. Finds the ceiling.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat3-peak-throughput"
banner "Category 3: Peak Throughput (Optimal Settings)"

EXECUTIONS=3
WARMUPS=5

section "Java — pool=256 × maxInProcess=64 (16384 effective concurrency)"
run_java \
  testType 1 \
  host "$BENCH_HOST" \
  parallelism 16 \
  requests 100000 \
  executions $EXECUTIONS \
  warmups $WARMUPS \
  minConnectionPoolSize 256 \
  maxConnectionPoolSize 256 2>&1 | tee "$RESULTS_DIR/java-peak.log"

section "Python — pool=256, parallelism=256"
run_python \
  --test-type throughput \
  --host "$BENCH_HOST" \
  --parallelism 256 \
  --pool-size 256 \
  --requests 5000 \
  --executions $EXECUTIONS \
  --warmups $WARMUPS \
  --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/python-peak.log"

section "Go — pool=64, parallelism=256 (WS mux helps)"
run_go \
  --test-type throughput \
  --host "$BENCH_HOST" \
  --parallelism 256 \
  --pool-size 64 \
  --requests 100000 \
  --executions $EXECUTIONS \
  --warmups $WARMUPS \
  --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/go-peak.log"

section "JavaScript — pool=8, parallelism=128 (WS mux — few conns suffice)"
run_js \
  --test-type throughput \
  --host "$BENCH_HOST" \
  --parallelism 128 \
  --pool-size 8 \
  --requests 50000 \
  --executions $EXECUTIONS \
  --warmups $WARMUPS \
  --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/js-peak.log"

section ".NET — pool=256, parallelism=256"
run_dotnet \
  --test-type throughput \
  --host "$BENCH_HOST" \
  --parallelism 256 \
  --pool-size 256 \
  --requests 100000 \
  --executions $EXECUTIONS \
  --warmups 10 \
  --min-expected-rps 1 2>&1 | tee "$RESULTS_DIR/dotnet-peak.log"

echo ""
echo "═══ Category 3 Complete ═══"
echo "Results: $RESULTS_DIR"
grep "avg req/sec\|req/sec:" "$RESULTS_DIR"/*-peak.log 2>/dev/null | grep -v warmup || true
