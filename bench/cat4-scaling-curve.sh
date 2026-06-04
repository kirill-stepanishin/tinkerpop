#!/usr/bin/env bash
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Category 4: Concurrency Scaling Curve
# Sweep concurrency from 4 → 512. Pool = concurrency (no pool bottleneck).
# Produces data for "req/s vs concurrency" chart per GLV.
# Also serves as the "fixed concurrency" comparison (replaces old Cat 2).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat4-scaling-curve"
banner "Category 4: Concurrency Scaling Curve"

EXECUTIONS=3
WARMUPS=3

# Request counts scaled by expected throughput at each tier.
# Target: each test cycle runs 30-90 seconds.
java_requests() {
  local C=$1
  if [ $C -le 64 ]; then echo 100000
  elif [ $C -le 512 ]; then echo 500000
  else echo 500000
  fi
}

fast_glv_requests() {
  local C=$1
  # Go/.NET/JS scale linearly: ~20*C req/sec
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

# Java 3.7: pool=C with maxInProcess=1 gives effective concurrency = C.
# Matches 4.0 where pool=C = C in-flight (HTTP 1:1).
section "Java — Scaling"
for C in 4 16 64 256 512 1000 5000; do
  echo "--- Java concurrency=$C ---"
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    requests $(java_requests $C) \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    parallelism 16 \
    minConnectionPoolSize $C \
    maxConnectionPoolSize $C \
    minInProcessPerConnection 1 \
    maxInProcessPerConnection 1 \
    minSimultaneousUsagePerConnection 1 \
    maxSimultaneousUsagePerConnection 1
done 2>&1 | tee "$RESULTS_DIR/java-scaling.log"

section "Go — Scaling"
for C in 4 16 64 128 256 512; do
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
for C in 4 16 64 128 256 512; do
  echo "--- .NET concurrency=$C ---"
  MAX_IP=16
  POOL=$(( (C + MAX_IP - 1) / MAX_IP ))
  if [ $C -le $MAX_IP ]; then
    MAX_IP=$C
    POOL=1
  fi
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $POOL \
    --max-in-process $MAX_IP \
    --requests $(fast_glv_requests $C) \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
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
