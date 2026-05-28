// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Gremlin.Net.Driver;

var config = ParseArgs(args);

if (config.Parallelism <= 0)
{
    Console.Error.WriteLine($"Invalid parallelism: {config.Parallelism}. Must be > 0.");
    Environment.Exit(1);
}

if (config.TestType == TestType.Latency)
    await RunLatencyTest(config);
else
    await RunThroughputTest(config);

if (!config.NoExit)
    Environment.Exit(0);

// ------- Latency Test -------

async Task RunLatencyTest(Config cfg)
{
    Console.WriteLine("-----------------------LATENCY TEST SELECTED----------------------");

    var server = new GremlinServer(cfg.Host, cfg.Port);
    var connectionSettings = new ConnectionSettings
    {
        MaxConnectionsPerServer = cfg.MaxConnectionsPerServer
    };

    using var client = new GremlinClient(server, connectionSettings: connectionSettings);

    Console.WriteLine("---------------------------WARMUP CYCLE---------------------------");
    for (int w = 1; w <= cfg.Warmups; w++)
    {
        var (elapsed, count) = await RunSingleLatencyIteration(client, cfg);
        var id = $"[warmup-{w}]";
        Console.WriteLine($"{id,-10}time: {elapsed}, result count: {count}");

        if (elapsed * 1000 > cfg.Timeout)
        {
            Console.WriteLine("Timeout exceeded during warmup. Skipping test cycles.");
            Console.WriteLine("avg latency (sec/req): 0");
            return;
        }

        await Task.Delay(cfg.PauseBetweenRuns);
    }

    Console.WriteLine("----------------------------TEST CYCLE----------------------------");
    double totalLatency = 0;
    int completed = 0;
    var overallStart = Stopwatch.GetTimestamp();

    for (int e = 1; e <= cfg.Executions; e++)
    {
        var (elapsed, count) = await RunSingleLatencyIteration(client, cfg);
        var id = $"[test-{e}]";
        Console.WriteLine($"{id,-10}time: {elapsed}, result count: {count}");

        totalLatency += elapsed;
        completed++;

        var overallElapsed = Stopwatch.GetElapsedTime(overallStart).TotalMilliseconds;
        if (overallElapsed > cfg.Timeout)
        {
            Console.WriteLine("Timeout exceeded. Stopping test cycles.");
            break;
        }

        if (e < cfg.Executions)
            await Task.Delay(cfg.PauseBetweenRuns);
    }

    Console.WriteLine($"avg latency (sec/req): {(completed > 0 ? totalLatency / completed : 0)}");
}

async Task<(double ElapsedSeconds, int ResultCount)> RunSingleLatencyIteration(GremlinClient client, Config cfg)
{
    var sw = Stopwatch.StartNew();
    await using var results = await client.SubmitAsync<dynamic>(cfg.Script);
    var list = await results.ToListAsync();
    int count = list.Count;
    sw.Stop();

    return (sw.Elapsed.TotalSeconds, count);
}

// ------- Throughput Test -------

async Task RunThroughputTest(Config cfg)
{
    Console.WriteLine("---------------------THROUGHPUT TEST SELECTED---------------------");

    if (cfg.Exercise)
    {
        Console.WriteLine("--------------------------INITIALIZATION--------------------------");
        await InitializeGraph(cfg);
    }

    var server = new GremlinServer(cfg.Host, cfg.Port);
    var connectionSettings = new ConnectionSettings
    {
        MaxConnectionsPerServer = cfg.MaxConnectionsPerServer
    };

    using var client = new GremlinClient(server, connectionSettings: connectionSettings);

    var random = new Random(0);
    bool meetsRpsExpectation = true;

    Console.WriteLine("---------------------------WARMUP CYCLE---------------------------");
    for (int w = 1; w <= cfg.Warmups && meetsRpsExpectation; w++)
    {
        var (elapsed, tooSlow, errors) = await RunThroughputIteration(client, cfg, 1000, random);
        long rps = elapsed > 0 ? (long)(1000 / elapsed) : 0;

        var id = $"[warmup-{w}]";
        var tooSlowStr = cfg.Exercise ? "N/A" : tooSlow.ToString();
        Console.WriteLine($"{id,-11}requests: {1000} | time(s): {elapsed,-14:F9} | req/sec: {rps,-7} | too slow: {tooSlowStr} | errors: {errors}");

        if (rps < cfg.MinExpectedRps && !cfg.Exercise)
            meetsRpsExpectation = false;

        await Task.Delay(cfg.PauseBetweenRuns);
    }

    if (!meetsRpsExpectation && !cfg.Exercise)
    {
        Console.WriteLine($"Warmup avg RPS below minExpectedRps ({cfg.MinExpectedRps}). Skipping test cycles.");
        Console.WriteLine("avg req/sec: 0");
        return;
    }

    Console.WriteLine("----------------------------TEST CYCLE----------------------------");
    long totalRps = 0;
    int completed = 0;
    var overallStart = Stopwatch.GetTimestamp();

    for (int e = 1; e <= cfg.Executions; e++)
    {
        var (elapsed, tooSlow, errors) = await RunThroughputIteration(client, cfg, cfg.Requests, random);
        long rps = elapsed > 0 ? (long)(cfg.Requests / elapsed) : 0;

        var id = $"[test-{e}]";
        var tooSlowStr = cfg.Exercise ? "N/A" : tooSlow.ToString();
        Console.WriteLine($"{id,-11}requests: {cfg.Requests} | time(s): {elapsed,-14:F9} | req/sec: {rps,-7} | too slow: {tooSlowStr} | errors: {errors}");

        totalRps += rps;
        completed++;

        var overallElapsed = Stopwatch.GetElapsedTime(overallStart).TotalMilliseconds;
        if (overallElapsed > cfg.Timeout)
        {
            Console.WriteLine("Timeout exceeded. Stopping test cycles.");
            break;
        }

        if (e < cfg.Executions)
            await Task.Delay(cfg.PauseBetweenRuns);
    }

    var avgRps = completed > 0 ? totalRps / completed : 0;
    Console.WriteLine($"avg req/sec: {avgRps}");

    if (cfg.Store != null)
    {
        var file = new FileInfo(cfg.Store);
        if (!file.Exists || file.Length == 0)
            await File.WriteAllTextAsync(cfg.Store, "parallelism\tmaxConnectionsPerServer\trequestPerSecond\n");
        await File.AppendAllTextAsync(cfg.Store, $"{cfg.Parallelism}\t{cfg.MaxConnectionsPerServer}\t{avgRps}\n");
    }
}

async Task<(double ElapsedSeconds, long TooSlow, long Errors)> RunThroughputIteration(
    GremlinClient client, Config cfg, int requestCount, Random random)
{
    var semaphore = new SemaphoreSlim(cfg.Parallelism);
    long tooSlow = 0;
    long errors = 0;
    var scripts = GetExerciseScripts();

    var sw = Stopwatch.StartNew();
    var tasks = new Task[requestCount];

    for (int i = 0; i < requestCount; i++)
    {
        await semaphore.WaitAsync();
        var script = cfg.Exercise ? scripts[random.Next(scripts.Length - 1)] : cfg.Script;

        tasks[i] = Task.Run(async () =>
        {
            var reqStart = Stopwatch.GetTimestamp();
            try
            {
                await using var results = await client.SubmitAsync<dynamic>(script);
                await results.ToListAsync();

                if (!cfg.Exercise)
                {
                    var reqElapsed = Stopwatch.GetElapsedTime(reqStart).TotalMilliseconds;
                    if (reqElapsed > cfg.TooSlowThreshold)
                        Interlocked.Increment(ref tooSlow);
                }
            }
            catch
            {
                Interlocked.Increment(ref errors);
            }
            finally
            {
                semaphore.Release();
            }
        });
    }

    await Task.WhenAll(tasks);
    sw.Stop();

    return (sw.Elapsed.TotalSeconds, tooSlow, errors);
}

async Task InitializeGraph(Config cfg)
{
    var server = new GremlinServer(cfg.Host, cfg.Port);
    using var client = new GremlinClient(server);

    await using var r1 = await client.SubmitAsync<long>("g.V().count()");
    var list = await r1.ToListAsync();
    var count = list.FirstOrDefault();
    if (count == 0)
        throw new InvalidOperationException(
            "Graph is empty. Start the server with gremlin-server-modern.yaml to pre-load data.");
    Console.WriteLine($"Graph verified: {count} vertices loaded");
}

// ------- Exercise Scripts -------

string[] GetExerciseScripts() =>
[
    "g.V()",
    "g.V(1).out('knows')",
    "g.V(1).out('knows').has('name','josh')",
    "g.V(1).as(\"a\").out(\"knows\").as(\"b\").select(\"a\", \"b\")",
    "g.V(1).as(\"a\").out(\"knows\").as(\"b\").select(\"a\", \"b\").by(\"name\")",
    "g.V().hasLabel(\"person\").as(\"p\").map(__.bothE().label().groupCount()).as(\"r\").select(\"p\", \"r\")",
    "g.V().choose(__.outE().count().is(0L), __.as(\"a\"), __.as(\"b\")).choose(__.select(\"a\"), __.select(\"a\"), __.select(\"b\"))",
    "g.V().group(\"a\").by(T.label).by(outE().values(\"weight\").sum()).cap(\"a\")",
    "g.V().repeat(__.union(__.out(\"knows\").group(\"a\").by(\"age\"), __.out(\"created\").group(\"b\").by(\"name\").by(count())).group(\"a\").by(\"name\")).times(2).cap(\"a\", \"b\")",
    "g.V().match(as(\"a\").out(\"knows\").as(\"b\"), as(\"b\").out(\"created\").has(\"name\", \"lop\"), as(\"b\").match(as(\"b\").out(\"created\").as(\"d\"), as(\"d\").in(\"created\").as(\"c\")).select(\"c\").as(\"c\")).select(\"a\", \"b\", \"c\")"
];

// ------- CLI Parsing -------

Config ParseArgs(string[] args)
{
    var cfg = new Config();

    for (int i = 0; i < args.Length; i++)
    {
        var key = args[i].TrimStart('-');
        switch (key)
        {
            case "test-type":
            case "testType":
                i++;
                cfg.TestType = args[i] switch
                {
                    "latency" or "0" => TestType.Latency,
                    "throughput" or "1" => TestType.Throughput,
                    _ => throw new ArgumentException($"Unknown test type: {args[i]}")
                };
                break;
            case "host": cfg.Host = args[++i]; break;
            case "port": cfg.Port = int.Parse(args[++i]); break;
            case "script": cfg.Script = args[++i]; break;
            case "parallelism": cfg.Parallelism = int.Parse(args[++i]); break;
            case "warmups": cfg.Warmups = int.Parse(args[++i]); break;
            case "executions": cfg.Executions = int.Parse(args[++i]); break;
            case "requests": cfg.Requests = int.Parse(args[++i]); break;
            case "pool-size":
            case "poolSize":
            case "max-connections":
            case "maxConnectionsPerServer":
                cfg.MaxConnectionsPerServer = int.Parse(args[++i]); break;
            case "too-slow-threshold":
            case "tooSlowThreshold":
                cfg.TooSlowThreshold = int.Parse(args[++i]); break;
            case "timeout": cfg.Timeout = long.Parse(args[++i]); break;
            case "min-expected-rps":
            case "minExpectedRps":
                cfg.MinExpectedRps = int.Parse(args[++i]); break;
            case "pause-between-runs":
            case "pauseBetweenRuns":
                cfg.PauseBetweenRuns = int.Parse(args[++i]); break;
            case "exercise":
                cfg.Exercise = true;
                if (i + 1 < args.Length && (args[i + 1] == "true" || args[i + 1] == "false"))
                    cfg.Exercise = bool.Parse(args[++i]);
                break;
            case "no-exit":
            case "noExit":
                cfg.NoExit = true;
                if (i + 1 < args.Length && (args[i + 1] == "true" || args[i + 1] == "false"))
                    cfg.NoExit = bool.Parse(args[++i]);
                break;
            case "store": cfg.Store = args[++i]; break;
            default:
                Console.Error.WriteLine($"Unknown argument: --{key}");
                break;
        }
    }

    return cfg;
}

// ------- Types -------

enum TestType { Latency, Throughput }

class Config
{
    public TestType TestType { get; set; } = TestType.Throughput;
    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 8182;
    public string Script { get; set; } = "g.inject(1)";
    public int Parallelism { get; set; } = 5000;
    public int Warmups { get; set; } = 5;
    public int Executions { get; set; } = 10;
    public int Requests { get; set; } = 10000;
    public int MaxConnectionsPerServer { get; set; } = 256;
    public int TooSlowThreshold { get; set; } = 125;
    public long Timeout { get; set; } = 1200000;
    public int MinExpectedRps { get; set; } = 1000;
    public int PauseBetweenRuns { get; set; } = 1000;
    public bool Exercise { get; set; }
    public bool NoExit { get; set; }
    public string? Store { get; set; }
}
