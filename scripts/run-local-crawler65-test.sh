#!/usr/bin/env bash
# 本地对齐 65 机器 Lite 模式：9222 搜索+国家(api-only) / 9223 enrich
# 国家预筛：仅 signed API（item_detail + item_list），不 page.goto 视频/搜索/主页
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEYWORD="${1:-Nexbie shoe try on}"
COUNTRY_BATCH="${2:-10}"
ENRICH_BATCH="${3:-5}"

export SCRAPER_MODE=lite
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://127.0.0.1:9222}"
export CDP_ENDPOINT_ENRICH="${CDP_ENDPOINT_ENRICH:-http://127.0.0.1:9223}"

# 与 65 guard 一致 + 严格 api-only 国家
export TT_LITE_TAB_POOL_SIZE=1
export TT_LITE_ALLOW_NAV=0
export TT_LITE_SEARCH_ALLOW_NAV=1
export TT_LITE_ENRICH_ALLOW_NAV=1
export TT_LITE_COUNTRY_DISABLE_NAV=1
export TT_LITE_COUNTRY_VIDEO_INFO=0
export TT_LITE_COUNTRY_STUB_DOCUMENT=0
export TT_LITE_COUNTRY_HTML_FIRST=0
export TT_LITE_COUNTRY_API_ONLY=1
export TT_LITE_COUNTRY_CONCURRENCY=10
export TT_LITE_COUNTRY_PROBE_DELAY_MS=800
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
    const rank=u=>{
      if(/Access Denied/i.test(u)) return 99;
      if(/^https:\\/\\/www\\.tiktok\\.com\\/?(\\?\|\$)/.test(u)) return 0;
      if(u.includes('tiktok.com')) return 1;
      return 9;
    };
    pages.sort((a,b)=>{
      const ra=rank(a.url)+( /Access Denied/i.test(a.title||'')?50:0);
      const rb=rank(b.url)+( /Access Denied/i.test(b.title||'')?50:0);
      return ra-rb;
    });
    const keep=new Set(pages.slice(0,${keep}).map(p=>p.id));
    let closed=0;
    for(const p of pages){if(keep.has(p.id))continue;
      try{require('child_process').execSync('curl -s \"http://127.0.0.1:${port}/json/close/'+p.id+'\"',{stdio:'ignore'});closed++;}catch{}}
    console.log('[trim] port=${port} closed='+closed);
  " "$tabs"
}

check_cdp() {
  local port=$1
  if ! curl -sf "http://127.0.0.1:${port}/json/version" >/dev/null; then
    echo "[FAIL] CDP ${port} not ready"
    exit 2
  fi
  echo "[cdp] port=${port} OK"
}

echo "================================================================"
echo "[local-crawler65] keyword=\"${KEYWORD}\""
echo "  search+country=9222 (fetch-only video_html_fetch location)  enrich=9223"
echo "  baseline=3e32dc6+overlay  TT_LITE_COUNTRY_FETCH_ONLY=1"
echo "================================================================"

check_cdp 9222
check_cdp 9223
trim_port 9222 1
trim_port 9223 1

SEARCH_EXIT=1
COUNTRY_EXIT=1
ENRICH_EXIT=1

echo ""
echo "=== Phase 1: Search API only (9222) ==="
node scripts/probe-tiktok-search-api-only.mjs "$KEYWORD" && SEARCH_EXIT=0 || SEARCH_EXIT=$?
echo "[phase1] search_exit=${SEARCH_EXIT}"

echo ""
echo "=== Phase 2: Country fetch-only (9222, video_html_fetch, no page nav) ==="
node scripts/probe-tiktok-country-batch.mjs --fetch-only --concurrency 10 "$KEYWORD" "$COUNTRY_BATCH" && COUNTRY_EXIT=0 || COUNTRY_EXIT=$?
echo "[phase2] country_exit=${COUNTRY_EXIT}"

trim_port 9222 1
trim_port 9223 1

echo ""
echo "=== Phase 3: Enrich + LLM (9223) ==="
node scripts/probe-tiktok-enrich-llm-batch.mjs "$KEYWORD" "$ENRICH_BATCH" && ENRICH_EXIT=0 || ENRICH_EXIT=$?
echo "[phase3] enrich_exit=${ENRICH_EXIT}"

echo ""
echo "================================================================"
echo "[local-crawler65] search=${SEARCH_EXIT} country=${COUNTRY_EXIT} enrich=${ENRICH_EXIT}"
echo "================================================================"

if [[ $SEARCH_EXIT -eq 0 && $COUNTRY_EXIT -eq 0 && $ENRICH_EXIT -eq 0 ]]; then exit 0; fi
exit 1
