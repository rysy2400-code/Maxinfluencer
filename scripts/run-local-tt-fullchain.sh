#!/usr/bin/env bash
# Local TikTok Lite full-chain: search+country(c=10,20) → enrich+LLM(c=10,10)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEYWORD="${1:-AI design tool demo}"
COUNTRY_BATCH="${2:-20}"
ENRICH_BATCH="${3:-10}"

export SCRAPER_MODE=lite
export TT_LITE_ALLOW_NAV=0
export TT_LITE_SEARCH_ALLOW_NAV=0
export TT_LITE_ENRICH_ALLOW_NAV=0
export TT_LITE_STRICT_API_ONLY_NO_GOTO=1
export TT_LITE_COUNTRY_DISABLE_NAV=1
export TT_LITE_COUNTRY_VIDEO_INFO=0
export TT_LITE_COUNTRY_HTML_FIRST=1
export TT_LITE_COUNTRY_CONCURRENCY=10
export TT_LITE_COUNTRY_API_ONLY=1
export TT_LITE_COUNTRY_PROBE_DELAY_MS=800
export TT_LITE_COUNTRY_VIDEO_INFO_CHAIN=0
export TT_LITE_UNIVERSAL_MAX_WAIT_MS=18000
export TT_LITE_MAX_VIDEOS=50
export LITE_TT_ENRICH_CONCURRENCY=10
export TT_LITE_TAB_POOL_SIZE=1
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://127.0.0.1:9222}"
export CDP_ENDPOINT_ENRICH="${CDP_ENDPOINT_ENRICH:-http://127.0.0.1:9223}"

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
    console.log('[trim] port=${port} closed='+closed+' kept=${keep}');
  " "$tabs"
}

echo "================================================================"
echo "[fullchain] keyword=\"${KEYWORD}\" country=${COUNTRY_BATCH}@c10 enrich=${ENRICH_BATCH}@c10"
echo "  9222=${CDP_ENDPOINT} 9223=${CDP_ENDPOINT_ENRICH}"
echo "================================================================"

trim_port 9222 1
trim_port 9223 1

T0=$(date +%s)

echo ""
echo "=== Phase 1: search + country (batch=${COUNTRY_BATCH}, c=10) ==="
T1=$(date +%s)
node scripts/probe-tiktok-country-batch.mjs \
  --api-only --concurrency 10 "$KEYWORD" "$COUNTRY_BATCH"
COUNTRY_EXIT=$?
T2=$(date +%s)
echo "[fullchain] phase1 exit=${COUNTRY_EXIT} elapsed=$((T2-T1))s"

trim_port 9222 1
trim_port 9223 1

echo ""
echo "=== Phase 2: enrich + LLM (batch=${ENRICH_BATCH}, c=10) ==="
T3=$(date +%s)
node scripts/probe-tiktok-enrich-llm-batch.mjs \
  "$KEYWORD" "$ENRICH_BATCH"
ENRICH_EXIT=$?
T4=$(date +%s)
echo "[fullchain] phase2 exit=${ENRICH_EXIT} elapsed=$((T4-T3))s"

TOTAL=$((T4-T0))
echo ""
echo "================================================================"
echo "[fullchain] TOTAL ${TOTAL}s | country_exit=${COUNTRY_EXIT} enrich_exit=${ENRICH_EXIT}"
echo "================================================================"

if [[ $COUNTRY_EXIT -eq 0 && $ENRICH_EXIT -eq 0 ]]; then exit 0; fi
exit 1
