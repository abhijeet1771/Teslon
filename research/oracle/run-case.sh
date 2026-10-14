#!/usr/bin/env bash
# One oracle case: crawl the base build twice (to measure noise) and the
# changed build once, each on a freshly started app with the same seed, then
# diff. Fresh starts matter: the save-unchanged probe writes, so a second crawl
# of a used app sees the first crawl's edits.
#
#   research/oracle/run-case.sh <before.jar> <after.jar> <outdir> <seed-script>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
before=$1 after=$2 out=$3 seed=$4
mkdir -p "$out"
run() { # jar port name
  java -jar "$1" --spring.profiles.active=dev --server.port="$2" > "$out/$3.log" 2>&1 &
  local pid=$!
  until grep -qE "is running|APPLICATION FAILED" "$out/$3.log"; do
    sleep 1; kill -0 "$pid" 2>/dev/null || { echo "app died: $3"; exit 3; }
  done
  if grep -q "APPLICATION FAILED" "$out/$3.log"; then echo "app failed: $3"; kill "$pid"; exit 3; fi
  node "$seed" "http://localhost:$2"
  node "$here/crawl.mjs" "http://localhost:$2" "$out/$3.json" --submit-unchanged
  kill "$pid"; wait "$pid" 2>/dev/null || true
}
run "$before" 8091 before
run "$before" 8092 before-again
run "$after" 8093 after
node "$here/diff.mjs" "$out/before.json" "$out/after.json" --noise "$out/before-again.json" | tee "$out/truth.txt"
