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
# Sweep effective concurrency from 4 → 5000.
# Each GLV configured to achieve C in-flight requests using its native model:
#   - Java: WS multiplexing (pool × maxInProcess = C)
#   - Go/Python: pool = C (no multiplexing)
#   - .NET: WS multiplexing (pool × maxInProcess = C)
#   - JS: WS multiplexing (parallelism = C, small pool)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat4-scaling-curve"
banner "Category 4: Concurrency Scaling Curve"

EXECUTIONS=3
WARMUPS=2

java_requests() {
  local C=$1
  if [ $C -le 16 ]; then echo 5000
  elif [ $C -le 64 ]; then echo 50000
  elif [ $C -le 512 ]; then echo 500000
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

# Java 3.7: WS multiplexing. effective concurrency = pool × maxInProcess.
# nioPoolSize=4 to avoid single-thread NIO bottleneck.
# maxSimultaneousUsagePerConnection matches maxInProcess to avoid borrow contention.
section "Java — Scaling"
for C in 4 16 64 256 512 1000 5000; do
  echo "--- Java concurrency=$C ---"
  MAX_IP=64
  POOL=$(( (C + MAX_IP - 1) / MAX_IP ))
  if [ $C -le $MAX_IP ]; then
    MAX_IP=$C
    POOL=1
  fi
  PAR=16
  if [ $C -ge 256 ]; then PAR=32; fi
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    requests $(java_requests $C) \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    parallelism $PAR \
    nioPoolSize 4 \
    minConnectionPoolSize $POOL \
    maxConnectionPoolSize $POOL \
    minInProcessPerConnection $MAX_IP \
    maxInProcessPerConnection $MAX_IP \
    minSimultaneousUsagePerConnection $MAX_IP \
    maxSimultaneousUsagePerConnection $MAX_IP
done 2>&1 | tee "$RESULTS_DIR/java-scaling.log" || true

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
done 2>&1 | tee "$RESULTS_DIR/go-scaling.log" || true

# .NET 3.7: WS multiplexing. pool × maxInProcess = C.
section ".NET — Scaling"
for C in 4 16 64 128 256 512 1000; do
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
done 2>&1 | tee "$RESULTS_DIR/dotnet-scaling.log" || true

# JS 3.7: WS multiplexing. parallelism = C, small pool.
section "JavaScript — Scaling"
for C in 4 16 64 128 256 512 1000; do
  echo "--- JavaScript concurrency=$C ---"
  run_js \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size 8 \
    --requests $(fast_glv_requests $C) \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/js-scaling.log" || true

# Python 3.7: no multiplexing. pool = C.
section "Python — Scaling"
for C in 4 16 64 128 256 512 1000; do
  echo "--- Python concurrency=$C ---"
  run_python \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests $(python_requests $C) \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/python-scaling.log" || true

echo ""
echo "═══ Category 4 Complete ═══"
echo "Results: $RESULTS_DIR"
echo "Extract: grep -E '(concurrency=|avg req/sec)' $RESULTS_DIR/*.log"
