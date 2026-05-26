/*
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
*/

package main

import (
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sync"
	"sync/atomic"
	"time"

	gremlingo "github.com/apache/tinkerpop/gremlin-go/v4/driver"
)

type scriptChooser struct {
	mu       sync.Mutex
	rng      *rand.Rand
	exercise bool
	script   string
}

func newScriptChooser(exercise bool, script string) *scriptChooser {
	return &scriptChooser{
		rng:      rand.New(rand.NewSource(0)),
		exercise: exercise,
		script:   script,
	}
}

func (sc *scriptChooser) next() string {
	if sc.exercise {
		sc.mu.Lock()
		idx := sc.rng.Intn(len(scripts) - 1)
		sc.mu.Unlock()
		return scripts[idx]
	}
	return sc.script
}

var scripts = []string{
	`g.V()`,
	`g.V(1).out('knows')`,
	`g.V(1).out('knows').has('name','josh')`,
	`g.V(1).as("a").out("knows").as("b").select("a", "b")`,
	`g.V(1).as("a").out("knows").as("b").select("a", "b").by("name")`,
	`g.V().hasLabel("person").as("p").map(__.bothE().label().groupCount()).as("r").select("p", "r")`,
	`g.V().choose(__.outE().count().is(0L), __.as("a"), __.as("b")).choose(__.select("a"), __.select("a"), __.select("b"))`,
	`g.V().group("a").by(T.label).by(outE().values("weight").sum()).cap("a")`,
	`g.V().repeat(__.union(__.out("knows").group("a").by("age"), __.out("created").group("b").by("name").by(count())).group("a").by("name")).times(2).cap("a", "b")`,
	`g.V().match(as("a").out("knows").as("b"),as("b").out("created").as("c"),as("c").in("created").as("d"),as("d").where(P.neq("a")).where(P.neq("b"))).select("a","b","c","d")`,
}

func main() {
	testType := flag.String("test-type", "throughput", "Test type: throughput or latency")
	host := flag.String("host", "localhost", "Gremlin server host")
	port := flag.Int("port", 8182, "Gremlin server port")
	parallelism := flag.Int("parallelism", 16, "Number of parallel goroutines")
	warmups := flag.Int("warmups", 5, "Number of warmup iterations")
	executions := flag.Int("executions", 10, "Number of test iterations")
	requests := flag.Int("requests", 10000, "Number of requests per iteration")
	script := flag.String("script", "g.inject(1)", "Gremlin script to execute")
	exercise := flag.Bool("exercise", false, "Exercise mode using multiple scripts")
	poolSize := flag.Int("pool-size", 8, "Connection pool size")
	tooSlowThreshold := flag.Int("too-slow-threshold", 125, "Too slow threshold in ms")
	timeout := flag.Int("timeout", 1200000, "Timeout in ms")
	minExpectedRps := flag.Int("min-expected-rps", 1000, "Minimum expected requests per second")
	pauseBetweenRuns := flag.Int("pause-between-runs", 1000, "Pause between runs in ms")
	store := flag.String("store", "", "TSV output file path")
	_ = flag.Bool("no-exit", false, "Do not exit after completion")

	flag.Parse()

	url := fmt.Sprintf("http://%s:%d/gremlin", *host, *port)

	chooser := newScriptChooser(*exercise, *script)

	createClient := func() (*gremlingo.Client, error) {
		ps := *poolSize
		return gremlingo.NewClient(url, func(settings *gremlingo.ClientSettings) {
			settings.MaximumConcurrentConnections = ps
		})
	}

	switch *testType {
	case "throughput":
		runThroughputTest(createClient, chooser, *warmups, *executions, *requests,
			*parallelism, *tooSlowThreshold, *timeout, *minExpectedRps,
			*pauseBetweenRuns, *exercise, *poolSize, *store)
	case "latency":
		runLatencyTest(createClient, chooser, *warmups, *executions, *timeout,
			*pauseBetweenRuns, *exercise)
	default:
		fmt.Fprintf(os.Stderr, "Unknown test type: %s\n", *testType)
		os.Exit(1)
	}
}

func runThroughputTest(createClient func() (*gremlingo.Client, error), chooser *scriptChooser,
	warmups, executions, requests, parallelism, tooSlowThreshold, timeout, minExpectedRps,
	pauseBetweenRuns int, exercise bool, poolSize int, store string) {

	fmt.Println("-----------------------THROUGHPUT TEST SELECTED--------------------")

	if exercise {
		fmt.Println("--------------------------INITIALIZATION--------------------------")
		client, err := createClient()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create client: %v\n", err)
			os.Exit(1)
		}
		rs, err := client.Submit("graph.clear()")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to clear graph: %v\n", err)
			os.Exit(1)
		}
		rs.All()
		rs, err = client.Submit("TinkerFactory.generateModern(graph)")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to generate modern graph: %v\n", err)
			os.Exit(1)
		}
		rs.All()
		client.Close()
	}

	fmt.Println("---------------------------WARMUP CYCLE---------------------------")

	var warmupRpsTotal float64
	warmupRequests := 1000

	for i := 0; i < warmups; i++ {
		client, err := createClient()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create client for warmup: %v\n", err)
			os.Exit(1)
		}

		start := time.Now()
		var wg sync.WaitGroup
		sem := make(chan struct{}, parallelism)

		for j := 0; j < warmupRequests; j++ {
			s := chooser.next()
			wg.Add(1)
			sem <- struct{}{}
			go func(script string) {
				defer wg.Done()
				defer func() { <-sem }()
				rs, err := client.Submit(script)
				if err == nil {
					rs.All()
				}
			}(s)
		}
		wg.Wait()

		elapsed := time.Since(start).Seconds()
		rps := float64(warmupRequests) / elapsed
		warmupRpsTotal += rps
		fmt.Printf("[warmup-%d] requests: %d | time(s): %.3f    | req/sec: %d\n",
			i+1, warmupRequests, elapsed, int(math.Round(rps)))

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	avgWarmupRps := warmupRpsTotal / float64(warmups)
	if avgWarmupRps < float64(minExpectedRps) && !exercise {
		fmt.Printf("avg req/sec during warmup (%.0f) is below min expected (%d), skipping test cycles\n",
			avgWarmupRps, minExpectedRps)
		return
	}

	fmt.Println("----------------------------TEST CYCLE----------------------------")

	globalStart := time.Now()
	var rpsTotal float64

	for i := 0; i < executions; i++ {
		if time.Since(globalStart).Milliseconds() > int64(timeout) {
			fmt.Printf("Timeout reached, skipping remaining cycles\n")
			break
		}

		client, err := createClient()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create client for test cycle: %v\n", err)
			os.Exit(1)
		}

		var tooSlowCount int64
		var errorCount int64
		var wg sync.WaitGroup
		sem := make(chan struct{}, parallelism)
		thresholdDuration := time.Duration(tooSlowThreshold) * time.Millisecond

		start := time.Now()

		for j := 0; j < requests; j++ {
			s := chooser.next()
			wg.Add(1)
			sem <- struct{}{}
			go func(script string) {
				defer wg.Done()
				defer func() { <-sem }()
				reqStart := time.Now()
				rs, err := client.Submit(script)
				if err != nil {
					atomic.AddInt64(&errorCount, 1)
					return
				}
				_, err = rs.All()
				if err != nil {
					atomic.AddInt64(&errorCount, 1)
					return
				}
				if time.Since(reqStart) > thresholdDuration {
					atomic.AddInt64(&tooSlowCount, 1)
				}
			}(s)
		}
		wg.Wait()

		elapsed := time.Since(start).Seconds()
		rps := float64(requests) / elapsed
		rpsTotal += rps

		tooSlowStr := fmt.Sprintf("%d", atomic.LoadInt64(&tooSlowCount))
		if exercise {
			tooSlowStr = "N/A"
		}

		fmt.Printf("[test-%d]   requests: %d | time(s): %.3f    | req/sec: %d   | too slow: %s | errors: %d\n",
			i+1, requests, elapsed, int(math.Round(rps)), tooSlowStr, atomic.LoadInt64(&errorCount))

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	avgRps := int(math.Round(rpsTotal / float64(executions)))
	fmt.Printf("avg req/sec: %d\n", avgRps)

	if store != "" {
		writeStore(store, parallelism, poolSize, avgRps)
	}
}

func runLatencyTest(createClient func() (*gremlingo.Client, error), chooser *scriptChooser,
	warmups, executions, timeout, pauseBetweenRuns int, exercise bool) {

	fmt.Println("-----------------------LATENCY TEST SELECTED----------------------")

	if exercise {
		fmt.Println("--------------------------INITIALIZATION--------------------------")
		client, err := createClient()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create client: %v\n", err)
			os.Exit(1)
		}
		rs, err := client.Submit("graph.clear()")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to clear graph: %v\n", err)
			os.Exit(1)
		}
		rs.All()
		rs, err = client.Submit("TinkerFactory.generateModern(graph)")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to generate modern graph: %v\n", err)
			os.Exit(1)
		}
		rs.All()
		client.Close()
	}

	fmt.Println("---------------------------WARMUP CYCLE---------------------------")

	timeoutSec := float64(timeout) / 1000.0
	var warmupLatencyTotal float64

	for i := 0; i < warmups; i++ {
		client, err := createClient()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create client for warmup: %v\n", err)
			os.Exit(1)
		}

		s := chooser.next()
		start := time.Now()
		rs, err := client.Submit(s)
		if err == nil {
			rs.All()
		}
		elapsed := time.Since(start).Seconds()
		warmupLatencyTotal += elapsed

		fmt.Printf("[warmup-%d]  time: %.6f\n", i+1, elapsed)

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	avgWarmupLatency := warmupLatencyTotal / float64(warmups)
	if avgWarmupLatency > timeoutSec {
		fmt.Printf("avg warmup latency (%.6f s) exceeds timeout (%.3f s), skipping test cycles\n",
			avgWarmupLatency, timeoutSec)
		return
	}

	fmt.Println("----------------------------TEST CYCLE----------------------------")

	globalStart := time.Now()
	var latencyTotal float64

	for i := 0; i < executions; i++ {
		if time.Since(globalStart).Milliseconds() > int64(timeout) {
			fmt.Printf("Timeout reached, skipping remaining cycles\n")
			break
		}

		client, err := createClient()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create client for test cycle: %v\n", err)
			os.Exit(1)
		}

		s := chooser.next()
		start := time.Now()
		rs, err := client.Submit(s)
		var resultCount int
		if err == nil {
			results, _ := rs.All()
			resultCount = len(results)
		}
		elapsed := time.Since(start).Seconds()
		latencyTotal += elapsed

		fmt.Printf("[test-%d]  time: %.6f, result count: %d\n", i+1, elapsed, resultCount)

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	avgLatency := latencyTotal / float64(executions)
	fmt.Printf("avg latency (sec/req): %.6f\n", avgLatency)
}

func writeStore(storePath string, parallelism, poolSize, rps int) {
	var f *os.File
	var err error

	if _, statErr := os.Stat(storePath); os.IsNotExist(statErr) {
		f, err = os.Create(storePath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create store file: %v\n", err)
			return
		}
		fmt.Fprintf(f, "parallelism\tpool_size\trequest_per_second\n")
	} else {
		f, err = os.OpenFile(storePath, os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to open store file: %v\n", err)
			return
		}
	}
	defer f.Close()

	fmt.Fprintf(f, "%d\t%d\t%d\n", parallelism, poolSize, rps)
}
