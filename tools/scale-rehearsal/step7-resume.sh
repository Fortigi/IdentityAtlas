#!/usr/bin/env bash
# Resume step 7 at the query set (the first bench ran beside a background refresh
# and was discarded), then chain into the repeat import as step7.sh would have.
set -uo pipefail
out=~/scale-runs/step7
stamp() { echo "$(date +%s) $1" >> $out/timeline.txt; echo "$(date -Is) $1"; }
mv $out/bench.tsv $out/bench-void-concurrent-refresh.tsv 2>/dev/null
MIN_MB=2500 nohup bash ~/harness/pgguard.sh $out/timeline.txt > /dev/null 2>&1 & G=$!
stamp bench
bash ~/harness/bench.sh step7 > $out/bench.out 2>&1
stamp bench-end
kill $G 2>/dev/null
stamp done
bash ~/harness/step7-repeat.sh main 1
