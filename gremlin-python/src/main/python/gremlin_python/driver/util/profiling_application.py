#
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
#
import argparse
import json
import os
import random
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError, wait

from gremlin_python.driver.client import Client
from gremlin_python.driver.serializer import (
    GraphBinarySerializersV1,
    GraphSONSerializersV2d0,
    GraphSONSerializersV3d0,
)

SERIALIZERS = {
    "graphbinaryv1": GraphBinarySerializersV1,
    "graphsonv2": GraphSONSerializersV2d0,
    "graphsonv3": GraphSONSerializersV3d0,
}

SCRIPTS = [
    "g.V()",
    "g.V(1).out('knows')",
    "g.V(1).out('knows').has('name','josh')",
    'g.V(1).as("a").out("knows").as("b").select("a", "b")',
    'g.V(1).as("a").out("knows").as("b").select("a", "b").by("name")',
    'g.V().hasLabel("person").as("p").map(__.bothE().label().groupCount()).as("r").select("p", "r")',
    'g.V().choose(__.outE().count().is(0L), __.as("a"), __.as("b")).choose(__.select("a"), __.select("a"), __.select("b"))',
    'g.V().group("a").by(T.label).by(outE().values("weight").sum()).cap("a")',
    'g.V().repeat(__.union(__.out("knows").group("a").by("age"), __.out("created").group("b").by("name").by(count())).group("a").by("name")).times(2).cap("a", "b")',
    'g.V().match(as("a").out("knows").as("b"),as("b").out("created").has("name","lop"),as("b").match(as("b").out("created").as("d"),as("d").in("created").as("c")).select("c").as("c")).select("a","b","c")',
]


class ProfilingApplication:

    def __init__(self, execution_name, url, pool_size, max_workers, serializer,
                 requests, executor, script,
                 too_slow_threshold, exercise, suppress_stack_traces):
        self._execution_name = execution_name
        self._url = url
        self._pool_size = pool_size
        self._max_workers = max_workers
        self._serializer = serializer
        self._requests = requests
        self._executor = executor
        self._script = script
        self._too_slow_threshold = too_slow_threshold
        self._exercise = exercise
        self._suppress_stack_traces = suppress_stack_traces
        self._random = random.Random(0)
        # per-execution error count, read by the caller after execute_* runs
        self.errors = 0

    def _create_client(self):
        return Client(self._url, "g",
                      pool_size=self._pool_size,
                      max_workers=self._max_workers,
                      message_serializer=self._serializer)

    def _choose_script(self):
        # Exclude the last (most complex match) script, matching Java behavior
        return SCRIPTS[self._random.randint(0, len(SCRIPTS) - 2)]

    def execute_throughput(self):
        too_slow = [0]
        errors = [0]
        lock = threading.Lock()
        execution_id = "[{}]".format(self._execution_name)
        too_slow_sec = self._too_slow_threshold / 1000.0 if self._too_slow_threshold > 0 else None

        client = self._create_client()
        try:
            def do_request():
                s = self._choose_script() if self._exercise else self._script
                try:
                    result_set = client.submit_async(s).result()
                    result_set.all().result(timeout=too_slow_sec)
                except (FuturesTimeoutError, TimeoutError):
                    with lock:
                        too_slow[0] += 1
                except Exception:
                    with lock:
                        errors[0] += 1
                    if not self._suppress_stack_traces:
                        traceback.print_exc()

            start = time.perf_counter_ns()
            futures = []
            for _ in range(self._requests):
                futures.append(self._executor.submit(do_request))
            wait(futures)
            end = time.perf_counter_ns()

            total_seconds = (end - start) / 1_000_000_000.0
            req_sec = round(self._requests / total_seconds)
            self.errors = errors[0]
            too_slow_display = "N/A" if self._exercise else str(too_slow[0])
            print("{:<10} requests: {} | time(s): {:<14.3f} | req/sec: {:<7} | too slow: {} | errors: {}".format(
                execution_id, self._requests, total_seconds,
                req_sec, too_slow_display, errors[0]), flush=True)
            return req_sec
        except Exception as ex:
            print("Failed Execution: {} - {}".format(self._execution_name, str(ex)))
            self.errors = errors[0] + 1
            return 0
        finally:
            client.close()

    def execute_latency(self, record_errors=False):
        # record_errors=False (warmup default): a request error aborts via
        # RuntimeError, leaving the warmup-gate behavior unchanged.
        # record_errors=True (measured TEST CYCLE): mirror the Go app -- count
        # the error as this execution's error count, still record the measured
        # seconds, and return normally so the caller continues the loop and the
        # single RESULT_JSON line is always emitted. Client creation stays
        # outside the try so a true setup/connection failure remains a hard
        # exit regardless of this flag.
        execution_id = "[{}]".format(self._execution_name)
        client = self._create_client()
        try:
            start = time.perf_counter_ns()
            try:
                result_set = client.submit(self._script)
                size = 0
                for item in result_set:
                    if isinstance(item, list):
                        size += len(item)
                    else:
                        size += 1
            except Exception as ex:
                if not record_errors:
                    if not self._suppress_stack_traces:
                        traceback.print_exc()
                    raise RuntimeError(str(ex)) from ex
                end = time.perf_counter_ns()
                self.errors = 1
                total_seconds = (end - start) / 1_000_000_000.0
                if not self._suppress_stack_traces:
                    traceback.print_exc()
                print("{:<10} time: {:<7}, result count: {}".format(
                    execution_id, "{:.4f}".format(total_seconds), 0), flush=True)
                return total_seconds
            end = time.perf_counter_ns()

            total_seconds = (end - start) / 1_000_000_000.0
            print("{:<10} time: {:<7}, result count: {}".format(
                execution_id, "{:.4f}".format(total_seconds), size), flush=True)
            return total_seconds
        finally:
            client.close()


def _resolve_serializer(name):
    name_lower = name.lower()
    if name_lower not in SERIALIZERS:
        raise ValueError("Unknown serializer: {}. Options: {}".format(
            name, ", ".join(SERIALIZERS.keys())))
    return SERIALIZERS[name_lower]()


def main():
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description="Profiling application for gremlin-python driver (3.7)")
    parser.add_argument("--host", default="localhost", help="Server host")
    parser.add_argument("--port", type=int, default=8182, help="Server port")
    parser.add_argument("--parallelism", type=int, default=16, help="Test executor thread pool size")
    parser.add_argument("--test-type", default="throughput", choices=["throughput", "latency"], help="Test mode")
    parser.add_argument("--min-expected-rps", type=int, default=1000, help="Min RPS to continue past warmup")
    parser.add_argument("--timeout", type=int, default=1200000, help="Overall timeout in ms")
    parser.add_argument("--warmups", type=int, default=5, help="Warmup iterations")
    parser.add_argument("--executions", type=int, default=10, help="Test iterations")
    parser.add_argument("--requests", type=int, default=10000, help="Requests per test execution")
    parser.add_argument("--pool-size", type=int, default=8, help="Client connection pool size")
    parser.add_argument("--concurrency", type=int, default=None,
                        help="Canonical concurrency for the cell (provenance passthrough, echoed in RESULT_JSON)")
    parser.add_argument("--max-workers", type=int, default=None, help="Client ThreadPoolExecutor size")
    parser.add_argument("--too-slow-threshold", type=int, default=125, help="Per-request timeout ms")
    parser.add_argument("--serializer", default="graphbinaryv1",
                        choices=list(SERIALIZERS.keys()), help="Serializer")
    parser.add_argument("--pause-between-runs", type=int, default=1000, help="Pause between executions ms")
    parser.add_argument("--suppress-stack-traces", action="store_true", help="Suppress errors")
    parser.add_argument("--exercise", action="store_true", help="Random scripts + Modern graph")
    parser.add_argument("--script", default="1+1", help="Script to execute")
    parser.add_argument("--store", default=None, help="TSV output file path")
    parser.add_argument("--transport", default="ws", choices=["http", "ws"], help="Transport protocol")
    parser.add_argument("--no-exit", action="store_true", help="Don't call sys.exit()")
    args = parser.parse_args()

    executor = ThreadPoolExecutor(max_workers=args.parallelism)
    url = "{}://{}:{}/gremlin".format(args.transport, args.host, args.port)
    serializer_instance = _resolve_serializer(args.serializer)

    # Raw per-execution values collected during the TEST CYCLE only (warmups
    # excluded). Echoed verbatim in the single RESULT_JSON line; no stats here.
    measurements = []
    errors_per_execution = []

    try:
        if args.test_type == "latency":
            print("-----------------------LATENCY TEST SELECTED----------------------")
        else:
            print("---------------------THROUGHPUT TEST SELECTED---------------------")

        if args.exercise:
            print("--------------------------INITIALIZATION--------------------------")
            init_client = Client(url, "g",
                                 pool_size=args.pool_size,
                                 max_workers=args.max_workers,
                                 message_serializer=serializer_instance)
            try:
                init_client.submit("graph.clear()")
                print("Cleared existing 'graph'")
                init_client.submit("TinkerFactory.generateModern(graph)")
                print("Modern graph loaded")
            finally:
                init_client.close()

        if args.test_type == "throughput":
            f = args.store
            if f is not None and (not os.path.exists(f) or os.path.getsize(f) == 0):
                with open(f, "w") as fh:
                    fh.write("parallelism\tpool_size\tmax_workers\trequest_per_second\n")

            meets_rps_expectation = True
            print("---------------------------WARMUP CYCLE---------------------------")
            for ix in range(args.warmups):
                if not meets_rps_expectation:
                    break
                app = ProfilingApplication(
                    "warmup-{}".format(ix + 1), url, args.pool_size,
                    args.max_workers, serializer_instance,
                    1000, executor, args.script, args.too_slow_threshold,
                    args.exercise, args.suppress_stack_traces)
                avg_rps = app.execute_throughput()
                meets_rps_expectation = avg_rps >= args.min_expected_rps
                time.sleep(args.pause_between_runs / 1000.0)

            exceeded_timeout = False
            total_requests_per_second = 0
            completed_executions = 0

            if args.exercise or meets_rps_expectation:
                start = time.perf_counter_ns()
                print("----------------------------TEST CYCLE----------------------------")
                for ix in range(args.executions):
                    if exceeded_timeout:
                        break
                    app = ProfilingApplication(
                        "test-{}".format(ix + 1), url, args.pool_size,
                        args.max_workers, serializer_instance,
                        args.requests, executor, args.script,
                        args.too_slow_threshold, args.exercise,
                        args.suppress_stack_traces)
                    rps = app.execute_throughput()
                    measurements.append(rps)
                    errors_per_execution.append(app.errors)
                    total_requests_per_second += rps
                    completed_executions += 1
                    elapsed_ns = time.perf_counter_ns() - start
                    exceeded_timeout = elapsed_ns > args.timeout * 1_000_000
                    time.sleep(args.pause_between_runs / 1000.0)

            if not meets_rps_expectation or exceeded_timeout or completed_executions == 0:
                avg_rps = 0
            else:
                avg_rps = round(total_requests_per_second / completed_executions)
            print("avg req/sec: {}".format(avg_rps))

            if f is not None:
                with open(f, "a") as fh:
                    fh.write("{}\t{}\t{}\t{}\n".format(
                        args.parallelism, args.pool_size,
                        args.max_workers, avg_rps))

        elif args.test_type == "latency":
            meets_timeout_expectation = True
            print("---------------------------WARMUP CYCLE---------------------------")
            for ix in range(args.warmups):
                if not meets_timeout_expectation:
                    break
                app = ProfilingApplication(
                    "warmup-{}".format(ix + 1), url, args.pool_size,
                    args.max_workers, serializer_instance,
                    1000, executor, args.script, args.too_slow_threshold,
                    args.exercise, args.suppress_stack_traces)
                latency = app.execute_latency()
                meets_timeout_expectation = latency < (args.timeout / 1000.0)
                time.sleep(args.pause_between_runs / 1000.0)

            exceeded_timeout = False
            total_time = 0.0
            completed_executions = 0

            if args.exercise or meets_timeout_expectation:
                start = time.perf_counter_ns()
                print("----------------------------TEST CYCLE----------------------------")
                for ix in range(args.executions):
                    if exceeded_timeout:
                        break
                    app = ProfilingApplication(
                        "test-{}".format(ix + 1), url, args.pool_size,
                        args.max_workers, serializer_instance,
                        args.requests, executor, args.script,
                        args.too_slow_threshold, args.exercise,
                        args.suppress_stack_traces)
                    latency = app.execute_latency(record_errors=True)
                    measurements.append(latency)
                    errors_per_execution.append(app.errors)
                    total_time += latency
                    completed_executions += 1
                    elapsed_ns = time.perf_counter_ns() - start
                    exceeded_timeout = elapsed_ns > args.timeout * 1_000_000
                    time.sleep(args.pause_between_runs / 1000.0)

            if not meets_timeout_expectation or exceeded_timeout or completed_executions == 0:
                avg_latency = 0.0
            else:
                avg_latency = total_time / completed_executions
            print("avg latency (sec/req): {}".format(avg_latency))

        # Single machine-readable result line (see bench/SCHEMA.md). Always
        # printed exactly once; measurements/errors are empty if the test cycle
        # was skipped (warmup gate failed) or cut short (timeout). Warmups are
        # excluded. No statistics are computed here.
        result_payload = {
            "glv": "python",
            "metric": args.test_type,
            "script": args.script,
            "concurrency": args.concurrency,
            "pool": args.pool_size,
            "parallelism": args.parallelism,
            "requests": args.requests,
            "warmups": args.warmups,
            "executions": args.executions,
            "measurements": measurements,
            "errors": errors_per_execution,
        }
        print("RESULT_JSON: " + json.dumps(result_payload), flush=True)

        if not args.no_exit:
            sys.exit(0)
    except Exception:
        traceback.print_exc()
        if not args.no_exit:
            sys.exit(1)
    finally:
        executor.shutdown(wait=True)


if __name__ == "__main__":
    main()
