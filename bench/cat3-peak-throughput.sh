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

# Category 3: Java Peak Throughput
# Java's optimal WS multiplexing config (pool=128, default maxInProcess=64).
# 5M requests to reach steady state. Other GLVs peak in cat4.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
setup_output "cat3-peak-throughput"
banner "Category 3: Java Peak Throughput"

EXECUTIONS=3
WARMUPS=2

section "Java — pool=128, WS multiplexed (5M requests for steady state)"
run_java \
  testType 1 \
  host "$BENCH_HOST" \
  parallelism 16 \
  requests 5000000 \
  executions $EXECUTIONS \
  warmups $WARMUPS \
  minConnectionPoolSize 128 \
  maxConnectionPoolSize 128 2>&1 | tee "$RESULTS_DIR/java-peak.log" || true

echo ""
echo "═══ Category 3 Complete ═══"
echo "Results: $RESULTS_DIR"
grep "avg req/sec" "$RESULTS_DIR"/*.log 2>/dev/null || true
