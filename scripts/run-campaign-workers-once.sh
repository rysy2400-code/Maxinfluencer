#!/usr/bin/env bash
# 一次性顺序执行 Campaign 相关 Worker（供 cron 分别调度时亦可单独运行各脚本）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

run() {
  echo ""
  echo "========== $1 =========="
  node "scripts/$1"
}

run "process-influencer-email-events.js"
run "process-campaign-agent-events.js"
run "process-influencer-agent-events.js"
run "process-published-video-metrics.js"

echo ""
echo "All campaign workers finished."
