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
	exercise := flag.Bool("exercise", false, "Exercise mode with Modern graph scripts")
	poolSize := flag.Int("pool-size", 8, "Connection pool size")
	tooSlowThreshold := flag.Int("too-slow-threshold", 125, "Too slow threshold in ms")
	timeout := flag.Int("timeout", 1200000, "Timeout in ms")
	minExpectedRps := flag.Int("min-expected-rps", 1000, "Minimum expected requests per second")
	pauseBetweenRuns := flag.Int("pause-between-runs", 1000, "Pause between runs in ms")
	store := flag.String("store", "", "TSV output file path")
	noExit := flag.Bool("no-exit", false, "Do not exit after completion")

	flag.Parse()

	url := fmt.Sprintf("http://%s:%d/gremlin", *host, *port)

	chooser := newScriptChooser(*exercise, *script)

	switch *testType {
	case "throughput":
		runThroughputTest(url, *parallelism, *warmups, *executions, *requests,
			*exercise, *poolSize, *tooSlowThreshold, *timeout, *minExpectedRps,
			*pauseBetweenRuns, *store, chooser)
	case "latency":
		runLatencyTest(url, *warmups, *executions, *exercise, *poolSize,
			*timeout, *pauseBetweenRuns, chooser)
	default:
		fmt.Fprintf(os.Stderr, "Unknown test type: %s\n", *testType)
		os.Exit(1)
	}

	if *noExit {
		select {}
	}
}

func createClient(url string, poolSize int) (*gremlingo.Client, error) {
	return gremlingo.NewClient(url, func(settings *gremlingo.ClientSettings) {
		settings.MaximumConcurrentConnections = poolSize
		settings.LogVerbosity = gremlingo.Error
	})
}

func initializeGraph(url string, poolSize int) {
	client, err := createClient(url, poolSize)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating client for initialization: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	rs, err := client.Submit("graph.clear()")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error clearing graph: %v\n", err)
		os.Exit(1)
	}
	_, _ = rs.All()

	rs, err = client.Submit("TinkerFactory.generateModern(graph)")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error generating modern graph: %v\n", err)
		os.Exit(1)
	}
	_, _ = rs.All()
}

func runThroughputTest(url string, parallelism, warmups, executions, requests int,
	exercise bool, poolSize, tooSlowThreshold, timeout, minExpectedRps,
	pauseBetweenRuns int, store string, chooser *scriptChooser) {

	fmt.Println("-----------------------THROUGHPUT TEST SELECTED--------------------")

	if exercise {
		fmt.Println("--------------------------INITIALIZATION--------------------------")
		initializeGraph(url, poolSize)
	}

	fmt.Println("---------------------------WARMUP CYCLE---------------------------")
	warmupRequests := 1000
	var totalWarmupRps float64
	thresholdDuration := time.Duration(tooSlowThreshold) * time.Millisecond

	for i := 0; i < warmups; i++ {
		client, err := createClient(url, poolSize)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error creating client for warmup: %v\n", err)
			os.Exit(1)
		}

		start := time.Now()
		var wg sync.WaitGroup
		sem := make(chan struct{}, parallelism)

		for r := 0; r < warmupRequests; r++ {
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				s := chooser.next()
				rs, err := client.Submit(s)
				if err == nil {
					_, _ = rs.All()
				}
			}()
		}
		wg.Wait()

		elapsed := time.Since(start).Seconds()
		rps := float64(warmupRequests) / elapsed
		totalWarmupRps += rps
		fmt.Printf("[warmup-%d] requests: %d | time(s): %.3f    | req/sec: %d\n",
			i+1, warmupRequests, elapsed, int(math.Round(rps)))

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	if warmups > 0 {
		avgWarmupRps := totalWarmupRps / float64(warmups)
		if avgWarmupRps < float64(minExpectedRps) && !exercise {
			fmt.Printf("avg req/sec during warmup (%.0f) is below minimum expected (%d), skipping test cycles\n",
				avgWarmupRps, minExpectedRps)
			return
		}
	}

	fmt.Println("----------------------------TEST CYCLE----------------------------")
	var totalRps float64
	var completedExecs int
	testStart := time.Now()

	for i := 0; i < executions; i++ {
		if time.Since(testStart).Milliseconds() > int64(timeout) {
			fmt.Printf("Timeout reached, skipping remaining test cycles\n")
			break
		}

		client, err := createClient(url, poolSize)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error creating client for test: %v\n", err)
			os.Exit(1)
		}

		var tooSlow int64
		var errors int64
		start := time.Now()
		var wg sync.WaitGroup
		sem := make(chan struct{}, parallelism)

		for r := 0; r < requests; r++ {
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				reqStart := time.Now()
				s := chooser.next()
				rs, err := client.Submit(s)
				if err != nil {
					atomic.AddInt64(&errors, 1)
				} else {
					_, err = rs.All()
					if err != nil {
						atomic.AddInt64(&errors, 1)
					}
				}
				if time.Since(reqStart) > thresholdDuration {
					atomic.AddInt64(&tooSlow, 1)
				}
			}()
		}
		wg.Wait()

		elapsed := time.Since(start).Seconds()
		rps := float64(requests) / elapsed
		totalRps += rps
		completedExecs++

		if exercise {
			fmt.Printf("[test-%d]   requests: %d | time(s): %.3f    | req/sec: %d   | too slow: N/A | errors: %d\n",
				i+1, requests, elapsed, int(math.Round(rps)), atomic.LoadInt64(&errors))
		} else {
			fmt.Printf("[test-%d]   requests: %d | time(s): %.3f    | req/sec: %d   | too slow: %d | errors: %d\n",
				i+1, requests, elapsed, int(math.Round(rps)), atomic.LoadInt64(&tooSlow), atomic.LoadInt64(&errors))
		}

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	if completedExecs > 0 {
		avgRps := int(math.Round(totalRps / float64(completedExecs)))
		fmt.Printf("avg req/sec: %d\n", avgRps)

		if store != "" {
			writeStore(store, parallelism, poolSize, avgRps)
		}
	}
}

func runLatencyTest(url string, warmups, executions int, exercise bool,
	poolSize, timeout, pauseBetweenRuns int, chooser *scriptChooser) {

	fmt.Println("-----------------------LATENCY TEST SELECTED----------------------")

	if exercise {
		fmt.Println("--------------------------INITIALIZATION--------------------------")
		initializeGraph(url, poolSize)
	}

	fmt.Println("---------------------------WARMUP CYCLE---------------------------")
	timeoutSec := float64(timeout) / 1000.0

	for i := 0; i < warmups; i++ {
		client, err := createClient(url, poolSize)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error creating client for warmup: %v\n", err)
			os.Exit(1)
		}

		start := time.Now()
		s := chooser.next()
		rs, err := client.Submit(s)
		if err == nil {
			_, _ = rs.All()
		}
		elapsed := time.Since(start).Seconds()
		fmt.Printf("[warmup-%d]  time: %.6f\n", i+1, elapsed)

		client.Close()

		if elapsed > timeoutSec {
			fmt.Printf("Warmup latency (%.6f s) exceeds timeout (%.3f s), skipping test cycles\n",
				elapsed, timeoutSec)
			return
		}
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	fmt.Println("----------------------------TEST CYCLE----------------------------")
	var totalLatency float64
	var completedExecs int
	testStart := time.Now()

	for i := 0; i < executions; i++ {
		if time.Since(testStart).Milliseconds() > int64(timeout) {
			fmt.Printf("Timeout reached, skipping remaining test cycles\n")
			break
		}

		client, err := createClient(url, poolSize)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error creating client for test: %v\n", err)
			os.Exit(1)
		}

		start := time.Now()
		s := chooser.next()
		rs, err := client.Submit(s)
		var resultCount int
		if err == nil {
			results, _ := rs.All()
			resultCount = len(results)
		}
		elapsed := time.Since(start).Seconds()
		totalLatency += elapsed
		completedExecs++

		fmt.Printf("[test-%d]  time: %.6f, result count: %d\n", i+1, elapsed, resultCount)

		client.Close()
		time.Sleep(time.Duration(pauseBetweenRuns) * time.Millisecond)
	}

	if completedExecs > 0 {
		avgLatency := totalLatency / float64(completedExecs)
		fmt.Printf("avg latency (sec/req): %.6f\n", avgLatency)
	}
}

func writeStore(storePath string, parallelism, poolSize, rps int) {
	fi, statErr := os.Stat(storePath)
	writeHeader := statErr != nil || fi.Size() == 0

	f, err := os.OpenFile(storePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening store file: %v\n", err)
		return
	}
	defer f.Close()

	if writeHeader {
		fmt.Fprintf(f, "parallelism\tpool_size\trequest_per_second\n")
	}
	fmt.Fprintf(f, "%d\t%d\t%d\n", parallelism, poolSize, rps)
}
