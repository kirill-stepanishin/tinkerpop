#!/usr/bin/env python3
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

"""Export benchmark results from ~/bench-results/{3.7,4.0}/ into a single CSV.

Parses log files produced by the per-repo run-all.sh scripts (tinkerpop-3.7-dev/bench
and tinkerpop/bench). Handles all 5 categories, both versions.

Usage:
    python3 export-results.py [--dir ~/bench-results] [--output results.csv]
"""

import argparse
import csv
import os
import re
import sys
from pathlib import Path

# ── Log line patterns ─────────────────────────────────────────────

RE_TEST_LINE = re.compile(r'^\[test-\d+\]')
RE_FIELD_REQUESTS = re.compile(r'requests:\s*(\d+)')
RE_FIELD_RPS = re.compile(r'req/sec:\s*(\d+)')
RE_FIELD_ERRORS = re.compile(r'errors:\s*(\d+)')

RE_LATENCY_TEST = re.compile(r'^\[test-\d+\]\s*time:\s*([0-9.]+)')

RE_AVG_RPS = re.compile(r'avg req/sec:\s*([0-9.]+)')
RE_AVG_LATENCY = re.compile(r'avg latency.*?:\s*([0-9.eE+\-]+)')

RE_MARKER_CONCURRENCY = re.compile(r'^---.*concurrency=(\d+)')
RE_MARKER_POOL = re.compile(r'^---.*pool=(\d+)')


def glv_from_filename(fname):
    fname = fname.lower()
    if fname.startswith('java'):
        return 'java'
    if fname.startswith('python'):
        return 'python'
    if fname.startswith('go'):
        return 'go'
    if fname.startswith('js') or fname.startswith('javascript'):
        return 'javascript'
    if fname.startswith('dotnet') or fname.startswith('net'):
        return 'dotnet'
    return 'unknown'


def parse_throughput_block(lines):
    """Parse a block of throughput output, return (avg_rps, errors, requests, executions)."""
    avg_rps = None
    total_errors = 0
    requests = None
    executions = 0
    per_cycle_rps = []

    for line in lines:
        m = RE_AVG_RPS.search(line)
        if m:
            val = float(m.group(1))
            if val > 0:
                avg_rps = val

        if RE_TEST_LINE.match(line):
            executions += 1
            m = RE_FIELD_ERRORS.search(line)
            if m:
                total_errors += int(m.group(1))
            m = RE_FIELD_REQUESTS.search(line)
            if m:
                requests = int(m.group(1))
            m = RE_FIELD_RPS.search(line)
            if m:
                per_cycle_rps.append(int(m.group(1)))

    # Fallback: compute avg from test cycles when reported avg is 0/missing
    if avg_rps is None and per_cycle_rps:
        avg_rps = sum(per_cycle_rps) / len(per_cycle_rps)

    return avg_rps, total_errors, requests, executions


def parse_latency_block(lines):
    """Parse a block of latency output, return (avg_latency, executions)."""
    avg_lat = None
    executions = 0
    per_cycle_lat = []

    for line in lines:
        m = RE_AVG_LATENCY.search(line)
        if m:
            avg_lat = float(m.group(1))

        m = RE_LATENCY_TEST.match(line)
        if m:
            executions += 1
            per_cycle_lat.append(float(m.group(1)))

    if avg_lat is None and per_cycle_lat:
        avg_lat = sum(per_cycle_lat) / len(per_cycle_lat)

    return avg_lat, executions


def split_multipoint(lines, marker_re):
    """Split log lines by marker regex, yield (marker_value, block_lines)."""
    current_marker = None
    block = []

    for line in lines:
        m = marker_re.match(line)
        if m:
            if current_marker is not None:
                yield current_marker, block
            current_marker = m.group(1)
            block = []
        else:
            block.append(line)

    if current_marker is not None:
        yield current_marker, block


def read_lines(path):
    with open(path, 'r', errors='replace') as f:
        return f.readlines()


# ── Category processors ───────────────────────────────────────────

def process_cat1(version, cat_dir):
    """Protocol overhead — latency tests, one file per GLV × size."""
    rows = []
    for logfile in sorted(cat_dir.glob('*.log')):
        fname = logfile.name
        glv = glv_from_filename(fname)

        if 'tiny' in fname:
            size = 'tiny'
        elif 'medium' in fname:
            size = 'medium'
        elif 'large' in fname:
            size = 'large'
        else:
            size = 'unknown'

        lines = read_lines(logfile)
        avg_lat, execs = parse_latency_block(lines)
        if avg_lat is None:
            continue

        rows.append({
            'version': version,
            'category': 'cat1-protocol-overhead',
            'glv': glv,
            'test_size': size,
            'concurrency': 1,
            'pool_size': 1,
            'avg_req_sec': '',
            'avg_latency_sec': avg_lat,
            'errors': 0,
            'requests': 1,
            'executions': execs,
        })
    return rows


def process_cat2(version, cat_dir):
    """Fixed concurrency — one file per GLV × concurrency tier."""
    rows = []
    for logfile in sorted(cat_dir.glob('*.log')):
        fname = logfile.name
        glv = glv_from_filename(fname)

        m = re.search(r'-c(\d+)\.log$', fname)
        if not m:
            continue
        conc = int(m.group(1))

        lines = read_lines(logfile)
        avg_rps, errors, requests, execs = parse_throughput_block(lines)
        if avg_rps is None:
            continue

        rows.append({
            'version': version,
            'category': 'cat2-fixed-concurrency',
            'glv': glv,
            'test_size': '',
            'concurrency': conc,
            'pool_size': conc,
            'avg_req_sec': avg_rps,
            'avg_latency_sec': '',
            'errors': errors,
            'requests': requests or '',
            'executions': execs,
        })
    return rows


def process_cat3(version, cat_dir):
    """Peak throughput — one file per GLV."""
    rows = []
    for logfile in sorted(cat_dir.glob('*.log')):
        fname = logfile.name
        glv = glv_from_filename(fname)

        lines = read_lines(logfile)
        avg_rps, errors, requests, execs = parse_throughput_block(lines)
        if avg_rps is None:
            continue

        rows.append({
            'version': version,
            'category': 'cat3-peak-throughput',
            'glv': glv,
            'test_size': '',
            'concurrency': 'peak',
            'pool_size': 'peak',
            'avg_req_sec': avg_rps,
            'avg_latency_sec': '',
            'errors': errors,
            'requests': requests or '',
            'executions': execs,
        })
    return rows


def process_cat4(version, cat_dir):
    """Scaling curve — multi-point per file, split by concurrency markers."""
    rows = []
    for logfile in sorted(cat_dir.glob('*.log')):
        fname = logfile.name
        glv = glv_from_filename(fname)

        lines = read_lines(logfile)
        for conc_val, block in split_multipoint(lines, RE_MARKER_CONCURRENCY):
            avg_rps, errors, requests, execs = parse_throughput_block(block)
            if avg_rps is None:
                continue
            rows.append({
                'version': version,
                'category': 'cat4-scaling-curve',
                'glv': glv,
                'test_size': '',
                'concurrency': int(conc_val),
                'pool_size': int(conc_val),
                'avg_req_sec': avg_rps,
                'avg_latency_sec': '',
                'errors': errors,
                'requests': requests or '',
                'executions': execs,
            })
    return rows


def process_cat5(version, cat_dir):
    """Pool sensitivity — multi-point per file, split by pool markers."""
    fixed_parallelism = {
        'java': 16,
        'javascript': 64,
        'python': 256,
        'go': 256,
        'dotnet': 256,
    }

    rows = []
    for logfile in sorted(cat_dir.glob('*.log')):
        fname = logfile.name
        glv = glv_from_filename(fname)
        par = fixed_parallelism.get(glv, 256)

        lines = read_lines(logfile)
        for pool_val, block in split_multipoint(lines, RE_MARKER_POOL):
            avg_rps, errors, requests, execs = parse_throughput_block(block)
            if avg_rps is None:
                continue
            rows.append({
                'version': version,
                'category': 'cat5-pool-sensitivity',
                'glv': glv,
                'test_size': '',
                'concurrency': par,
                'pool_size': int(pool_val),
                'avg_req_sec': avg_rps,
                'avg_latency_sec': '',
                'errors': errors,
                'requests': requests or '',
                'executions': execs,
            })
    return rows


CATEGORIES = {
    'cat1-protocol-overhead': process_cat1,
    'cat2-fixed-concurrency': process_cat2,
    'cat3-peak-throughput': process_cat3,
    'cat4-scaling-curve': process_cat4,
    'cat5-pool-sensitivity': process_cat5,
}

FIELDNAMES = [
    'version', 'category', 'glv', 'test_size',
    'concurrency', 'pool_size', 'avg_req_sec', 'avg_latency_sec',
    'errors', 'requests', 'executions',
]


def main():
    parser = argparse.ArgumentParser(description='Export TinkerPop benchmark results to CSV')
    parser.add_argument('--dir', default=os.path.expanduser('~/bench-results'),
                        help='Root results directory (default: ~/bench-results)')
    parser.add_argument('--output', default='results.csv',
                        help='Output CSV path (default: results.csv)')
    args = parser.parse_args()

    bench_dir = Path(args.dir)
    if not bench_dir.is_dir():
        print(f"ERROR: Results directory not found: {bench_dir}", file=sys.stderr)
        sys.exit(1)

    all_rows = []

    for version in ['3.7', '4.0']:
        version_dir = bench_dir / version
        if not version_dir.is_dir():
            print(f"  (no results for {version})")
            continue

        print(f"Processing version {version}...")
        for cat_name, processor in CATEGORIES.items():
            cat_dir = version_dir / cat_name
            if not cat_dir.is_dir():
                continue
            rows = processor(version, cat_dir)
            all_rows.extend(rows)
            print(f"  {cat_name}: {len(rows)} data points")

    with open(args.output, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"\nDone. {len(all_rows)} data points exported to {args.output}")
    print(f"\nQuick S3 upload:")
    print(f"  aws s3 cp {args.output} s3://YOUR-BUCKET/bench-results/$(date +%Y%m%d)-results.csv")


if __name__ == '__main__':
    main()
