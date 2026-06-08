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

# RESULT_JSON Contract

Each profiling application (one per GLV: java, go, dotnet, javascript, python)
prints **exactly one** machine-readable result line to **stdout**, prefixed with
the literal marker `RESULT_JSON: ` followed by a single-line JSON object.

```
RESULT_JSON: {"glv": "...", "metric": "...", ...}
```

This line **supplements** the existing human-readable output; it does not replace
it. All pre-existing lines (`[test-N] ...`, `avg req/sec: ...`,
`avg latency (sec/req): ...`, cycle banners, etc.) are emitted unchanged. The
orchestrator greps for the single `RESULT_JSON: ` line and **fails loudly** if it
is missing.

## Rules

- **Exactly one** `RESULT_JSON: ` line per process invocation, on stdout.
- The line is always printed, even when the test cycle is skipped (e.g. warmup
  failed the RPS gate or the run timed out). In that case `measurements` and
  `errors` are empty arrays.
- Apps perform **no statistics**. They emit only echoed parameters and the raw
  per-execution values. Mean/median/p99/stddev are computed by the orchestrator.
- **Warmups are excluded** from `measurements` and `errors`. Only the measured
  test-cycle executions are reported.
- JSON is a single line (no embedded newlines), UTF-8, standard `json.dumps`
  output. Numbers are emitted as JSON numbers.

## Fields

| Field          | Type            | Description                                                                                  |
|----------------|-----------------|----------------------------------------------------------------------------------------------|
| `glv`          | string          | GLV identifier: one of `java`, `go`, `dotnet`, `javascript`, `python`.                       |
| `metric`       | string          | `throughput` or `latency`.                                                                   |
| `script`       | string          | The Gremlin script that was executed.                                                        |
| `concurrency`  | integer \| null | Canonical concurrency for the cell (provenance passthrough). `null` when not supplied.       |
| `pool`         | integer \| null | Client connection pool size used by the app.                                                 |
| `parallelism`  | integer         | Test executor / load-generator parallelism used by the app.                                  |
| `requests`     | integer         | Requests per measured execution.                                                             |
| `warmups`      | integer         | Number of warmup iterations requested (excluded from `measurements`).                        |
| `executions`   | integer         | Number of measured test iterations requested.                                                |
| `measurements` | array           | Raw per-execution values, warmups excluded. **throughput** → req/sec (number per execution); **latency** → seconds (number per execution). Normally length == `executions`; shorter if the run was cut short (timeout). |
| `errors`       | array           | Per-execution error count (integer per execution), aligned 1:1 with `measurements`.          |

## Example (throughput, python)

```
RESULT_JSON: {"glv": "python", "metric": "throughput", "script": "g.V()", "concurrency": 256, "pool": 256, "parallelism": 256, "requests": 5000, "warmups": 2, "executions": 3, "measurements": [4821, 4903, 4877], "errors": [0, 0, 0]}
```

## Example (latency, python)

```
RESULT_JSON: {"glv": "python", "metric": "latency", "script": "g.V().repeat(both()).times(12)", "concurrency": null, "pool": 8, "parallelism": 16, "requests": 10000, "warmups": 2, "executions": 3, "measurements": [0.0421, 0.0438, 0.0419], "errors": [0, 0, 0]}
```
