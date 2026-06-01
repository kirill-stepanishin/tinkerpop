#!/usr/bin/env bash
# Run all benchmark categories for TinkerPop 4.0.
# Server must already be running 4.0 on $BENCH_HOST.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  TinkerPop 4.0 — Full Benchmark Suite (HTTP)               ║"
echo "║  Host: $BENCH_HOST                                          ║"
echo "║  Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Load graph
echo ""
echo "Loading Modern graph..."
run_java \
  testType 1 \
  host "$BENCH_HOST" \
  exercise true \
  requests 1 \
  executions 1 \
  warmups 1 \
  maxConnectionPoolSize 5000 2>/dev/null || \
run_go \
  --test-type throughput \
  --host "$BENCH_HOST" \
  --exercise \
  --requests 1 \
  --executions 1 \
  --warmups 1 \
  --min-expected-rps 1 2>/dev/null || \
echo "WARNING: Could not load graph. Load manually before latency tests."

echo ""
echo "▶ Category 2: Fixed Concurrency (~20 min)"
"$SCRIPT_DIR/cat2-fixed-concurrency.sh"

echo ""
echo "▶ Category 3: Peak Throughput (~15 min)"
"$SCRIPT_DIR/cat3-peak-throughput.sh"

echo ""
echo "▶ Category 4: Scaling Curve (~30 min)"
"$SCRIPT_DIR/cat4-scaling-curve.sh"

echo ""
echo "▶ Category 5: Pool Sensitivity (~20 min)"
"$SCRIPT_DIR/cat5-pool-sensitivity.sh"

echo ""
echo "▶ Category 1: Protocol Overhead (~30 min)"
"$SCRIPT_DIR/cat1-protocol-overhead.sh"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  4.0 benchmarks COMPLETE                                   ║"
echo "║  Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)                          ║"
echo "║  Results:  $BENCH_BASE_DIR                                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
