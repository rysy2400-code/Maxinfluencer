#!/usr/bin/env bash
# 本地消费一条 tiktok_influencer_search_task（默认 Nexbie pending）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TASK_ID="${1:-58354}"
CAMPAIGN_ID="${2:-CAMP-1782801670436-6J3AP9F7S}"

export SCRAPER_MODE=lite
export SEARCH_WORKER_LOOP=false
export SEARCH_TASK_ID="$TASK_ID"
export SEARCH_WORKER_PLATFORMS=tiktok
export SEARCH_WORKER_TRIGGER_HEARTBEAT=false
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://127.0.0.1:9222}"
export CDP_ENDPOINT_ENRICH="${CDP_ENDPOINT_ENRICH:-http://127.0.0.1:9223}"

# Lite TikTok：html-first 国家 + 9223 enrich
export TT_LITE_ALLOW_NAV=0
export TT_LITE_COUNTRY_DISABLE_NAV=1
export TT_LITE_COUNTRY_VIDEO_INFO=0
export TT_LITE_COUNTRY_STUB_DOCUMENT=0
export TT_LITE_TAB_POOL_SIZE=1
export TT_LITE_COUNTRY_HTML_FIRST=1
export TT_LITE_COUNTRY_CONCURRENCY=10
export TT_LITE_COUNTRY_PROBE_DELAY_MS=800
export TT_LITE_COUNTRY_VIDEO_INFO_CHAIN=1
export TT_LITE_UNIVERSAL_MAX_WAIT_MS=18000
export TT_LITE_MAX_VIDEOS=50
export LITE_TT_ENRICH_CONCURRENCY=10

if [[ -f .env.local ]]; then set -a; source .env.local; set +a; fi
if [[ -f .env ]]; then set -a; source .env; set +a; fi

trim_port() {
  local port=$1 keep=$2
  local tabs
  tabs=$(curl -s "http://127.0.0.1:${port}/json/list" || echo "[]")
  node -e "
    const tabs=JSON.parse(process.argv[1]);
    const pages=tabs.filter(t=>t.type==='page');
    if(pages.length<=${keep}){console.log('[trim] port=${port} pages='+pages.length+' ok');process.exit(0);}
    const rank=u=>/^https:\\/\\/www\\.tiktok\\.com\\/?(\\?\|\$)/.test(u)?0:u.includes('tiktok.com')?1:9;
    pages.sort((a,b)=>rank(a.url)-rank(b.url));
    const keep=new Set(pages.slice(0,${keep}).map(p=>p.id));
    let closed=0;
    for(const p of pages){if(keep.has(p.id))continue;
      try{require('child_process').execSync('curl -s \"http://127.0.0.1:${port}/json/close/'+p.id+'\"',{stdio:'ignore'});closed++;}catch{}}
    console.log('[trim] port=${port} closed='+closed);
  " "$tabs"
}

echo "================================================================"
echo "[local-task] campaign=${CAMPAIGN_ID} taskId=${TASK_ID}"
echo "  9222=${CDP_ENDPOINT} 9223=${CDP_ENDPOINT_ENRICH}"
echo "  country=full-pool@c10 1tab enrich_c=10 1tab affiliate=9222 1tab stub-no-goto"
echo "================================================================"

trim_port 9222 2
trim_port 9223 3

T0=$(date +%s)
LOG="logs/local-task-${TASK_ID}-$(date +%Y%m%d-%H%M%S).log"
mkdir -p logs
node scripts/worker-influencer-search.js 2>&1 | tee "$LOG"
EXIT=${PIPESTATUS[0]}
T1=$(date +%s)

echo ""
echo "================================================================"
echo "[local-task] exit=${EXIT} elapsed=$((T1-T0))s log=${LOG}"
echo "================================================================"

node --input-type=module <<NODE || true
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });
const { queryTikTok } = await import("./lib/db/mysql-tiktok.js");
const rows = await queryTikTok(
  "SELECT id,status,error_message,progress_search_found_count,progress_profile_browsed_count,progress_analyzed_count,progress_recommended_count,progress_contactable_count,finished_at FROM tiktok_influencer_search_task WHERE id=? LIMIT 1",
  ["${TASK_ID}"]
);
console.log("[local-task] final", JSON.stringify(rows?.[0] ?? null, null, 2));
NODE

exit "$EXIT"
