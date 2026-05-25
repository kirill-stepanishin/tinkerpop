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
import sys
import time
import traceback

from gremlin_python.driver.util.profiling_application import main as profiler_main

POOL_SIZE_RANGE = [4, 8, 16, 32, 64]
MAX_WORKERS_RANGE = [4, 8, 16, 32]
PARALLELISM_RANGE = [4, 8, 16, 32]


def run_config_sweep(extra_args=None):
    extra_args = extra_args or []

    for pool_size in POOL_SIZE_RANGE:
        for max_workers in MAX_WORKERS_RANGE:
            for parallelism in PARALLELISM_RANGE:
                args = [
                    "--pool-size", str(pool_size),
                    "--max-workers", str(max_workers),
                    "--parallelism", str(parallelism),
                    "--no-exit",
                ] + extra_args

                print("Testing with: pool_size={}, max_workers={}, parallelism={}".format(
                    pool_size, max_workers, parallelism))

                # Override sys.argv so argparse in profiler_main picks up our args
                saved_argv = sys.argv
                sys.argv = ["profiling_application"] + args
                try:
                    profiler_main()
                except SystemExit:
                    pass
                finally:
                    sys.argv = saved_argv

                time.sleep(5)

    total = len(POOL_SIZE_RANGE) * len(MAX_WORKERS_RANGE) * len(PARALLELISM_RANGE)
    print("Total configurations tested: {}".format(total))


def main():
    extra_args = sys.argv[1:]
    try:
        run_config_sweep(extra_args)
        sys.exit(0)
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
