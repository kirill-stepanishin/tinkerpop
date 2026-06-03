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

# Category 5: Pool Sensitivity
# Fix parallelism high, sweep pool size (4 points per GLV).
# Shows how much wrong pool size hurts.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat5-pool-sensitivity"
banner "Category 5: Pool Sensitivity"

EXECUTIONS=3
WARMUPS=3

section "Java — Pool Sweep (parallelism=16)"
for POOL in 8 32 128 256; do
  echo "--- Java pool=$POOL ---"
  run_java \
    testType 1 \
    host "$BENCH_HOST" \
    parallelism 16 \
    requests 200000 \
    executions $EXECUTIONS \
    warmups $WARMUPS \
    minConnectionPoolSize $POOL \
    maxConnectionPoolSize $POOL
done 2>&1 | tee "$RESULTS_DIR/java-pool.log"

section "Go — Pool Sweep (parallelism=256)"
for POOL in 4 32 128 256; do
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
for POOL in 8 32 128 256; do
  echo "--- .NET pool=$POOL ---"
  run_dotnet \
    --test-type throughput \
    --host "$BENCH_HOST" \
    --parallelism 256 \
    --pool-size $POOL \
    --requests 50000 \
    --executions $EXECUTIONS \
    --warmups $WARMUPS \
    --min-expected-rps 1
done 2>&1 | tee "$RESULTS_DIR/dotnet-pool.log"

section "JavaScript — Pool Sweep (parallelism=64)"
for POOL in 1 4 16 64; do
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
for POOL in 8 32 128 256; do
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
