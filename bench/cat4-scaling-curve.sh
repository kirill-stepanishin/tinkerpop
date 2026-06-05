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
# HTTP: pool = concurrency for all GLVs (one request per connection).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat4-scaling-curve"
banner "Category 4: Concurrency Scaling Curve"

EXECUTIONS=3
WARMUPS=2

java_requests() {
  local C=$1
  if [ $C -le 4 ]; then echo 1000
  elif [ $C -le 16 ]; then echo 5000
  elif [ $C -le 64 ]; then echo 50000
  else echo 500000
  fi
}

fast_glv_requests() {
  local C=$1
  if [ $C -le 4 ]; then echo 1000
  elif [ $C -le 16 ]; then echo 5000
  elif [ $C -le 64 ]; then echo 10000
  elif [ $C -le 128 ]; then echo 30000
  elif [ $C -le 1000 ]; then echo 50000
  else echo 500000
  fi
}

python_requests() {
  local C=$1
  if [ $C -le 4 ]; then echo 500
  elif [ $C -le 16 ]; then echo 1000
  elif [ $C -le 64 ]; then echo 3000
  elif [ $C -le 1000 ]; then echo 5000
  else echo 10000
  fi
}

# Java 4.0: HTTP, pool = concurrency. minConnectionPoolSize forces eager creation.
# parallelism must scale with C — submission threads are the concurrency driver for HTTP.
section "Java — Scaling"
for C in 4 16 64 256 512 1000 5000; do
  echo "--- Java concurrency=$C ---"
  PAR=$C
  if [ $PAR -gt 64 ]; then PAR=64; fi
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism $PAR \
    requests $(java_requests $C) \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    minConnectionPoolSize $C \
    maxConnectionPoolSize $C
done 2>&1 | tee "$RESULTS_DIR/java-scaling.log" || true

section "Go — Scaling"
for C in 4 16 64 128 256 512 1000 5000; do
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

section ".NET — Scaling"
for C in 4 16 64 128 256 512 1000 5000; do
  echo "--- .NET concurrency=$C ---"
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism $C \
    --pool-size $C \
    --requests $(fast_glv_requests $C) \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/dotnet-scaling.log" || true

section "JavaScript — Scaling"
for C in 4 16 64 128 256 512 1000 5000; do
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
done 2>&1 | tee "$RESULTS_DIR/js-scaling.log" || true

section "Python — Scaling"
for C in 4 16 64 128 256 512 1000 5000; do
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
