<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->

# Benchmark Execution Walkthrough

Step-by-step guide to run the TinkerPop 3.7 vs 4.0 benchmark suite.

---

## Quick Start

```bash
# On client EC2, from this repo (3.7 branch):
cd bench
chmod +x *.sh
./run-all.sh 2>&1 | tee ~/bench-results/3.7-full.log
```

Then swap the server to 4.0, and on the 4.0 repo:
```bash
cd bench
chmod +x *.sh
./run-all.sh 2>&1 | tee ~/bench-results/4.0-full.log
```

---

## What Each Category Measures

| # | Script | What it answers | Duration |
|---|--------|----------------|----------|
| 1 | `cat1-protocol-overhead.sh` | Per-request WS vs HTTP cost | ~30 min |
| 2 | `cat2-fixed-concurrency.sh` | Fair version comparison at same server load | ~20 min |
| 3 | `cat3-peak-throughput.sh` | Absolute ceiling per GLV | ~15 min |
| 4 | `cat4-scaling-curve.sh` | Where does each GLV plateau? | ~30 min |
| 5 | `cat5-pool-sensitivity.sh` | How much does wrong pool size hurt? | ~20 min |

Total: ~2 hours per version.

---

## Full Procedure

### 1. Prerequisites (one-time setup)

**Server EC2** (US-EAST-2, m7a.8xlarge):
```bash
# Build 3.7 server
cd ~/tinkerpop-3.7 && git checkout 3.7-glv-benchmarking
mvn clean install -pl gremlin-server -am -DskipTests -Dasciidoc.skip=true

# Build 4.0 server
cd ~/tinkerpop-4 && git checkout 4-glv-benchmarking
mvn clean install -pl gremlin-server -am -DskipTests -Dasciidoc.skip=true

# Configure both (run for each):
cd <server-standalone-dir>
sed -i 's/^host: localhost/host: 0.0.0.0/' conf/gremlin-server.yaml
sed -i 's/^evaluationTimeout: 30000$/evaluationTimeout: 30000000/' conf/gremlin-server.yaml
sed -i '/^channelizer:/a maxWorkQueueSize: 65536\nthreadPoolWorker: 8\ngremlinPool: 16' conf/gremlin-server.yaml
```

**Client EC2** (US-WEST-2, m7a.4xlarge):
```bash
# Build all GLVs for 3.7
cd ~/tinkerpop-3.7 && git checkout 3.7-glv-benchmarking
mvn clean install -pl gremlin-driver -am -DskipTests -Dasciidoc.skip=true
cd gremlin-python/src/main/python && pip3.11 install -e .
cd ~/tinkerpop-3.7/gremlin-go && go build -o profiling_application ./driver/util/
cd ~/tinkerpop-3.7/gremlin-javascript/src/main/javascript/gremlin-javascript && npm install
cd ~/tinkerpop-3.7/gremlin-dotnet/src/Gremlin.Net.Profiling && dotnet build -c Release

# Build all GLVs for 4.0
cd ~/tinkerpop-4 && git checkout 4-glv-benchmarking
mvn clean install -pl gremlin-driver -am -DskipTests -Dasciidoc.skip=true
cd gremlin-python/src/main/python && pip3.11 install -e .
cd ~/tinkerpop-4/gremlin-go && go build -o profiling_application ./driver/util/
cd ~/tinkerpop-4/gremlin-dotnet/src/Gremlin.Net.Profiling && dotnet build -c Release

# Shell scripts
find ~/tinkerpop-3.7 ~/tinkerpop-4 -path '*/main/bin/profile-driver.sh' -exec chmod +x {} \;

# Environment (add to ~/.bashrc)
export BENCH_HOST="16.59.222.63"
export DOTNET_GCServer=1
export DOTNET_ThreadPool_MinThreads=1024
ulimit -n 65536
```

### 2. Run 3.7 Benchmarks

**Server EC2:**
```bash
cd ~/tinkerpop-3.7/gremlin-server/target/apache-tinkerpop-gremlin-server-3.7.7-SNAPSHOT-standalone
ulimit -n 65536
export JAVA_OPTIONS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
bin/gremlin-server.sh console
# Wait for: Channel started at port 8182
```

**Client EC2:**
```bash
cd ~/tinkerpop-3.7/bench
chmod +x *.sh
./run-all.sh 2>&1 | tee ~/bench-results/3.7-full.log
```

### 3. Server Swap

**Server EC2:**
1. `Ctrl+C` to stop 3.7 server
2. Start 4.0:
```bash
cd ~/tinkerpop-4/gremlin-server/target/apache-tinkerpop-gremlin-server-4.0.0-SNAPSHOT-standalone
ulimit -n 65536
export JAVA_OPTIONS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
bin/gremlin-server.sh console
# Wait for: Channel started at port 8182
```

### 4. Run 4.0 Benchmarks

**Client EC2:**
```bash
cd ~/tinkerpop-4/bench
chmod +x *.sh
./run-all.sh 2>&1 | tee ~/bench-results/4.0-full.log
```

### 5. Collect Results

```bash
# All results are in:
ls ~/bench-results/3.7/cat*/
ls ~/bench-results/4.0/cat*/

# Quick comparison:
grep "avg req/sec" ~/bench-results/3.7/cat3-peak-throughput/*.log
grep "avg req/sec" ~/bench-results/4.0/cat3-peak-throughput/*.log
```

---

## Running Individual Categories

```bash
# Run just one category (no need to run-all):
cd ~/tinkerpop-3.7/bench
./cat2-fixed-concurrency.sh

# Override host:
BENCH_HOST=10.0.1.50 ./cat3-peak-throughput.sh

# Override results directory:
BENCH_BASE_DIR=/data/results ./cat4-scaling-curve.sh
```

---

## Result Structure

```
~/bench-results/
├── 3.7/
│   ├── cat1-protocol-overhead/
│   │   ├── java-latency-tiny.log
│   │   ├── python-latency-tiny.log
│   │   ├── go-latency-tiny.log
│   │   ├── js-latency-tiny.log
│   │   ├── dotnet-latency-tiny.log
│   │   └── *-latency-medium.log
│   ├── cat2-fixed-concurrency/
│   │   ├── {java,python,go,js,dotnet}-c{16,64,256}.log
│   ├── cat3-peak-throughput/
│   │   └── {java,python,go,js,dotnet}-peak.log
│   ├── cat4-scaling-curve/
│   │   └── {java,python,go,js,dotnet}-scaling.log
│   └── cat5-pool-sensitivity/
│       └── {java,python,go,js,dotnet}-pool.log
├── 4.0/
│   └── (same structure)
├── 3.7-full.log
└── 4.0-full.log
```

---

## Interpreting Results

**Category 2 (most important for version comparison):**
- Compare same GLV at same concurrency tier: `java-c256.log` in 3.7/ vs 4.0/
- If req/s is similar → migration is safe
- If 4.0 is significantly lower → investigate pool/warmup issues

**Category 4 (most informative chart):**
- Plot concurrency (x) vs req/s (y), one line per GLV
- The "knee" is the useful concurrency limit — beyond it, more connections don't help
- Compare 3.7 vs 4.0 knee position: 4.0 typically plateaus at higher concurrency (more connections needed)

**Category 5 (tuning guide):**
- 3.7 WS: expect FLAT curve for Java/JS/.NET (multiplexing absorbs pool changes)
- 3.7 WS: expect STEEP curve for Python/Go (no multiplexing)
- 4.0 HTTP: expect STEEP curve for ALL (pool = concurrency)

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "SKIP: Java driver not built" | `mvn install -pl gremlin-driver -am -DskipTests` |
| "SKIP: Go binary not found" | `cd gremlin-go && go build -o profiling_application ./driver/util/` |
| `avg req/sec: 0` | Warmup gate failed. Scripts use `--min-expected-rps 1`, check connectivity |
| `errors: N` (N > 0) | Server overloaded or connection issue. Re-run after cooldown |
| Connection refused | Server not running or security group doesn't allow port 8182 |
| Want to skip a GLV | Remove/rename its binary; script prints SKIP and continues |
| Script fails on one GLV | Add `|| true` after the `run_*` call in the script |

---

## Latency Test Sizing

Tests use `times(12)` (~354K vertices) instead of `times(15)` (~2.8M) or `times(18)` (~40M) to keep each latency run under 2 minutes while still being representative of serialization overhead. The relationship is exponential (each +3 is ~14× more data), so the relative performance difference between GLVs and versions is preserved at smaller sizes.

If you want the full-size tests, change `times(12)` to `times(15)` in `cat1-protocol-overhead.sh` and increase the timeout.
