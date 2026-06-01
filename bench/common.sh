#!/usr/bin/env bash
# Shared configuration for TinkerPop 3.7-dev benchmark scripts.
# Source this file; don't execute it directly.

export BENCH_HOST="${BENCH_HOST:-16.59.222.63}"
export BENCH_BASE_DIR="${BENCH_BASE_DIR:-$HOME/bench-results/3.7}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ulimit -n 65536 2>/dev/null || true

# ── GLV paths (relative to repo root) ───────────────────────────
JAVA_DIR="$REPO_ROOT/gremlin-driver/target/apache-tinkerpop-gremlin-driver-3.7.7-SNAPSHOT-standalone"
PYTHON_DIR="$REPO_ROOT/gremlin-python/src/main/bin"
GO_BIN="$REPO_ROOT/gremlin-go/profiling_application"
JS_DIR="$REPO_ROOT/gremlin-javascript/src/main/bin"
DOTNET_DIR="$REPO_ROOT/gremlin-dotnet/src/main/bin"

# ── Runner functions ─────────────────────────────────────────────
run_java() {
  if [ ! -d "$JAVA_DIR" ]; then
    echo "  SKIP: Java driver not built. Run: mvn install -pl gremlin-driver -am -DskipTests"
    return 1
  fi
  "$JAVA_DIR/bin/profile-driver.sh" "$@"
}

run_python() {
  if [ ! -f "$PYTHON_DIR/profile-driver.sh" ]; then
    echo "  SKIP: Python profiler not found at $PYTHON_DIR"
    return 1
  fi
  "$PYTHON_DIR/profile-driver.sh" --transport ws "$@"
}

run_go() {
  if [ ! -f "$GO_BIN" ]; then
    echo "  SKIP: Go binary not found. Run: cd gremlin-go && go build -o profiling_application ./driver/util/"
    return 1
  fi
  "$GO_BIN" "$@"
}

run_js() {
  if [ ! -f "$JS_DIR/profile-driver.sh" ]; then
    echo "  SKIP: JavaScript profiler not found at $JS_DIR"
    return 1
  fi
  "$JS_DIR/profile-driver.sh" "$@"
}

run_dotnet() {
  if [ ! -f "$DOTNET_DIR/profile-driver.sh" ]; then
    echo "  SKIP: .NET profiler not found at $DOTNET_DIR"
    return 1
  fi
  export DOTNET_GCServer=1
  export DOTNET_ThreadPool_MinThreads=1024
  "$DOTNET_DIR/profile-driver.sh" "$@"
}

# ── Output helpers ───────────────────────────────────────────────
setup_output() {
  local category="$1"
  RESULTS_DIR="$BENCH_BASE_DIR/$category"
  mkdir -p "$RESULTS_DIR"
}

banner() {
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "  Version: 3.7-dev (WebSocket) | Host: $BENCH_HOST"
  echo "  Output:  $RESULTS_DIR"
  echo "  Time:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "════════════════════════════════════════════════════════════"
  echo ""
}

section() {
  echo ""
  echo "────────────────────────────────────────────────────────────"
  echo "  $1"
  echo "────────────────────────────────────────────────────────────"
}
