/*
 *  Licensed to the Apache Software Foundation (ASF) under one
 *  or more contributor license agreements.  See the NOTICE file
 *  distributed with this work for additional information
 *  regarding copyright ownership.  The ASF licenses this file
 *  to you under the Apache License, Version 2.0 (the
 *  "License"); you may not use this file except in compliance
 *  with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import gremlin from '../../../build/esm/index.js';

const { Client } = gremlin.driver;

const SCRIPTS = [
  "g.V()",
  "g.V().count()",
  "g.V().values('name')",
  "g.V().has('name','marko').out('knows').values('name')",
  "g.V().has('name','marko').out('created').values('name')",
  "g.E()",
  "g.E().count()",
  "g.V().has('name','marko').outE('knows').inV().values('name')",
  "g.V().group().by(T.label).by(values('name').fold())",
  "g.V().match(__.as('a').out('created').as('b'),__.as('b').has('name','lop')).select('a','b')"
];

class Semaphore {
  constructor(max) {
    this._max = max;
    this._count = 0;
    this._queue = [];
  }

  acquire() {
    if (this._count < this._max) {
      this._count++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._count--;
    }
  }
}

class ScriptChooser {
  constructor(scripts) {
    this._scripts = scripts;
    this._seed = 0;
  }

  next() {
    this._seed = (this._seed * 1664525 + 1013904223) & 0x7fffffff;
    const idx = this._seed % (this._scripts.length - 1);
    return this._scripts[idx];
  }
}

function parseArgs(argv) {
  const args = {
    testType: 'throughput',
    host: 'localhost',
    port: 8182,
    parallelism: 16,
    warmups: 5,
    executions: 10,
    requests: 10000,
    script: 'g.inject(1)',
    exercise: false,
    poolSize: 8,
    tooSlowThreshold: 125,
    timeout: 1200000,
    minExpectedRps: 1000,
    pauseBetweenRuns: 1000,
    store: '',
    noExit: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--test-type': args.testType = argv[++i]; break;
      case '--host': args.host = argv[++i]; break;
      case '--port': args.port = parseInt(argv[++i]); break;
      case '--parallelism': args.parallelism = parseInt(argv[++i]); break;
      case '--warmups': args.warmups = parseInt(argv[++i]); break;
      case '--executions': args.executions = parseInt(argv[++i]); break;
      case '--requests': args.requests = parseInt(argv[++i]); break;
      case '--script': args.script = argv[++i]; break;
      case '--exercise': args.exercise = true; break;
      case '--pool-size': args.poolSize = parseInt(argv[++i]); break;
      case '--too-slow-threshold': args.tooSlowThreshold = parseInt(argv[++i]); break;
      case '--timeout': args.timeout = parseInt(argv[++i]); break;
      case '--min-expected-rps': args.minExpectedRps = parseInt(argv[++i]); break;
      case '--pause-between-runs': args.pauseBetweenRuns = parseInt(argv[++i]); break;
      case '--store': args.store = argv[++i]; break;
      case '--no-exit': args.noExit = true; break;
    }
  }

  return args;
}

function createClients(url, poolSize) {
  return Array.from({ length: poolSize }, () => new Client(url));
}

async function closeClients(clients) {
  for (const client of clients) {
    try { await client.close(); } catch (e) { /* ignore */ }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeStore(storePath, parallelism, poolSize, rps) {
  const header = 'parallelism\tpool_size\trequest_per_second\n';
  if (!fs.existsSync(storePath) || fs.statSync(storePath).size === 0) {
    fs.writeFileSync(storePath, header);
  }
  fs.appendFileSync(storePath, `${parallelism}\t${poolSize}\t${rps}\n`);
}

async function initializeGraph(url) {
  const client = new Client(url);
  try {
    const result = await client.submit('g.V().count()', null);
    const count = result.first();
    if (count === 0) {
      throw new Error('Graph is empty. Start the server with gremlin-server-modern.yaml to pre-load data.');
    }
    console.log(`Graph verified: ${count} vertices loaded`);
  } finally {
    await client.close();
  }
}

async function runThroughputTest(args, url) {
  console.log('---------------------THROUGHPUT TEST SELECTED---------------------');

  if (args.exercise) {
    console.log('--------------------------INITIALIZATION--------------------------');
    await initializeGraph(url);
  }

  console.log('---------------------------WARMUP CYCLE---------------------------');

  let totalWarmupRps = 0;
  const chooser = args.exercise ? new ScriptChooser(SCRIPTS) : null;

  for (let w = 1; w <= args.warmups; w++) {
    const clients = createClients(url, args.poolSize);
    const sem = new Semaphore(args.parallelism);
    const warmupRequests = 1000;

    const start = performance.now();
    const promises = [];

    for (let r = 0; r < warmupRequests; r++) {
      const script = chooser ? chooser.next() : args.script;
      const client = clients[r % clients.length];
      promises.push((async () => {
        await sem.acquire();
        try {
          await client.submit(script, null);
        } catch (e) { /* ignore warmup errors */ }
        finally { sem.release(); }
      })());
    }

    await Promise.allSettled(promises);
    const elapsed = (performance.now() - start) / 1000;
    const rps = Math.round(warmupRequests / elapsed);
    totalWarmupRps += rps;

    console.log(`[warmup-${w}] requests: ${warmupRequests} | time(s): ${elapsed.toFixed(3)}    | req/sec: ${rps}`);
    await closeClients(clients);

    if (w < args.warmups) await sleep(args.pauseBetweenRuns);
  }

  const avgWarmupRps = args.warmups > 0 ? Math.round(totalWarmupRps / args.warmups) : 0;

  if (!args.exercise && avgWarmupRps < args.minExpectedRps) {
    console.log(`avg req/sec during warmup (${avgWarmupRps}) is below minimum expected (${args.minExpectedRps}), skipping test cycles`);
    console.log('avg req/sec: 0');
    return;
  }

  console.log('----------------------------TEST CYCLE----------------------------');

  let totalRps = 0;
  let completedExecutions = 0;
  const testStart = performance.now();

  for (let e = 1; e <= args.executions; e++) {
    if ((performance.now() - testStart) > args.timeout) {
      console.log('Timeout reached, skipping remaining test cycles');
      break;
    }

    const clients = createClients(url, args.poolSize);
    const sem = new Semaphore(args.parallelism);
    const execChooser = args.exercise ? new ScriptChooser(SCRIPTS) : null;
    let tooSlow = 0;
    let errors = 0;

    const start = performance.now();
    const promises = [];

    for (let r = 0; r < args.requests; r++) {
      const script = execChooser ? execChooser.next() : args.script;
      const client = clients[r % clients.length];
      promises.push((async () => {
        await sem.acquire();
        const reqStart = performance.now();
        try {
          await client.submit(script, null);
          if ((performance.now() - reqStart) > args.tooSlowThreshold) tooSlow++;
        } catch (e) {
          errors++;
        } finally {
          sem.release();
        }
      })());
    }

    await Promise.allSettled(promises);
    const elapsed = (performance.now() - start) / 1000;
    const rps = Math.round(args.requests / elapsed);
    totalRps += rps;
    completedExecutions++;

    if (args.exercise) {
      console.log(`[test-${e}]   requests: ${args.requests} | time(s): ${elapsed.toFixed(3)}    | req/sec: ${rps}   | too slow: N/A | errors: ${errors}`);
    } else {
      console.log(`[test-${e}]   requests: ${args.requests} | time(s): ${elapsed.toFixed(3)}    | req/sec: ${rps}   | too slow: ${tooSlow} | errors: ${errors}`);
    }

    await closeClients(clients);
    if (e < args.executions) await sleep(args.pauseBetweenRuns);
  }

  const avgRps = completedExecutions > 0 ? Math.round(totalRps / completedExecutions) : 0;
  console.log(`avg req/sec: ${avgRps}`);

  if (args.store) {
    writeStore(args.store, args.parallelism, args.poolSize, avgRps);
  }
}

async function runLatencyTest(args, url) {
  console.log('-----------------------LATENCY TEST SELECTED----------------------');

  if (args.exercise) {
    console.log('--------------------------INITIALIZATION--------------------------');
    await initializeGraph(url);
  }

  console.log('---------------------------WARMUP CYCLE---------------------------');

  for (let w = 1; w <= args.warmups; w++) {
    const client = new Client(url);
    try {
      const start = performance.now();
      const result = await client.submit(args.script, null);
      const elapsed = (performance.now() - start) / 1000;
      const resultCount = result.length;
      console.log(`[warmup-${w}]time: ${elapsed.toFixed(9)}, result count: ${resultCount}`);

      if (elapsed > args.timeout / 1000) {
        console.log(`Warmup latency (${elapsed.toFixed(6)} s) exceeds timeout (${(args.timeout / 1000).toFixed(3)} s), skipping test cycles`);
        console.log('avg latency (sec/req): 0');
        return;
      }
    } finally {
      await client.close();
    }
  }

  console.log('----------------------------TEST CYCLE----------------------------');

  let totalTime = 0;
  let completedExecutions = 0;
  const testStart = performance.now();

  for (let e = 1; e <= args.executions; e++) {
    if ((performance.now() - testStart) > args.timeout) {
      console.log('Timeout reached, skipping remaining test cycles');
      break;
    }

    const client = new Client(url);
    try {
      const start = performance.now();
      const result = await client.submit(args.script, null);
      const elapsed = (performance.now() - start) / 1000;
      const resultCount = result.length;
      totalTime += elapsed;
      completedExecutions++;
      console.log(`[test-${e}]  time: ${elapsed.toFixed(9)}, result count: ${resultCount}`);
    } finally {
      await client.close();
    }

    if (e < args.executions) await sleep(args.pauseBetweenRuns);
  }

  const avgLatency = completedExecutions > 0 ? totalTime / completedExecutions : 0;
  console.log(`avg latency (sec/req): ${avgLatency}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const url = `http://${args.host}:${args.port}/gremlin`;

  try {
    if (args.testType === 'latency') {
      await runLatencyTest(args, url);
    } else {
      await runThroughputTest(args, url);
    }
  } catch (err) {
    console.error(`Failed Execution: ${err.name} - ${err.message}`);
    if (!args.noExit) process.exit(1);
  }

  if (args.noExit) {
    await new Promise(() => {});
  }

  process.exit(0);
}

main();
