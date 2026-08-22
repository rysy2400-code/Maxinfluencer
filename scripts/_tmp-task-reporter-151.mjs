#!/usr/bin/env node
/**
 * On 151: per-task reporter for TikTok workers.
 * For each completed task (per browser port):
 *   - result summary (status, search found, enrich ok, fail count/reason)
 *   - duration
 *   - API call estimate:
 *       search   = sum of stats.apiBatches from search-tiktok-lite-*.json dumps in task window
 *       country  = progress_country_checked_count (DB)
 *       enrich   = user/detail ok + item_list pages from tiktok-enrich.log (by endpoint port, in window)
 *   - traffic MB = mihomo /connections downloadTotal+uploadTotal delta per port (3s sampling)
 * Writes to logs/task-reporter-151.log
 * Run: node --experimental-default-type=module scripts\_tmp-task-reporter-151.mjs
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
tiktokPool.on("error", () => {});
process.on("unhandledRejection", (e) => {
  try {
    fs.appendFileSync(REPORT_LOG, `${new Date().toISOString()} UNHANDLED_REJECTION ${String(e?.message || e).slice(0, 160)}\n`, "utf8");
  } catch { /* ignore */ }
});
process.on("uncaughtException", (e) => {
  try {
    fs.appendFileSync(REPORT_LOG, `${new Date().toISOString()} UNCAUGHT_EXCEPTION ${String(e?.message || e).slice(0, 160)}\n`, "utf8");
  } catch { /* ignore */ }
});

const ROOT = "C:\\maxinfluencer";
const LOGS = path.join(ROOT, "logs");
const REPORT_LOG = path.join(LOGS, "task-reporter-151.log");
const ENRICH_LOG = path.join(LOGS, "tiktok-enrich.log");
const SEARCH_DUMP_GLOB = /^search-tiktok-lite-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

const PORTS = [
  { cdp: 9222, ctrl: 9090, suffix: "9222" },
  { cdp: 9223, ctrl: 9108, suffix: "9223" },
  { cdp: 9224, ctrl: 9109, suffix: "9224" },
  { cdp: 9225, ctrl: 9110, suffix: "9225" },
];

const DURATION_MS = 2 * 60 * 60 * 1000;
const TRAFFIC_INTERVAL_MS = 3000;
const DB_INTERVAL_MS = 10000;
const startedAt = Date.now();
const trafficHist = {};
const resetTimes = {};
const reported = new Set();
let enrichTailCache = "";
let dumpCache = null;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync(REPORT_LOG, line + "\n", "utf8"); } catch { /* ignore */ }
  console.log(line);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function querySafe(sql, params) {
  try {
    return await Promise.race([
      queryTikTok(sql, params),
      new Promise((_, rej) => setTimeout(() => rej(new Error("db timeout")), 20000)),
    ]);
  } catch (e) {
    log(`DB_ERR ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}

// ---- traffic sampling ----
async function sampleTraffic() {
  const now = Date.now();
  for (const p of PORTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`http://127.0.0.1:${p.ctrl}/connections`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      const total = (Number(j.downloadTotal) || 0) + (Number(j.uploadTotal) || 0);
      const hist = (trafficHist[p.cdp] = trafficHist[p.cdp] || []);
      const last = hist.length ? hist[hist.length - 1].total : 0;
      if (last > 0 && total < last) {
        log(`TRAFFIC_RESET port=${p.cdp} prev=${last} now=${total}`);
        (resetTimes[p.cdp] = resetTimes[p.cdp] || []).push(now);
      }
      hist.push({ t: now, total });
      if (hist.length > 6000) hist.splice(0, hist.length - 5000);
    } catch { /* ignore */ }
  }
}

function trafficAt(cdp, t) {
  const hist = trafficHist[cdp] || [];
  if (!hist.length) return null;
  if (t <= hist[0].t) return hist[0].total;
  let lo = 0;
  let hi = hist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (hist[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = hist[lo];
  const b = hist[lo + 1];
  if (!b) return a.total;
  const frac = (t - a.t) / (b.t - a.t || 1);
  return a.total + (b.total - a.total) * frac;
}

/** 跨计数器重置的安全累计：窗口内所有正增量之和（MB） */
function trafficWindowMB(cdp, startMs, endMs) {
  const hist = trafficHist[cdp] || [];
  if (!hist.length) return null;
  let sum = 0;
  let prev = null;
  let firstSeen = null;
  for (const s of hist) {
    if (s.t < startMs) {
      prev = s;
      continue;
    }
    if (s.t > endMs) break;
    if (firstSeen == null) firstSeen = s;
    if (prev != null && s.total >= prev.total) sum += s.total - prev.total;
    prev = s;
  }
  // 若窗口起点落在首个采样之前，用首个采样作基线（会低估窗口起始段）
  if (firstSeen != null && firstSeen.t > startMs && prev != null) {
    sum += Math.max(0, firstSeen.total - prev.total);
  }
  return sum / (1024 * 1024);
}

function midWindowReset(cdp, startMs, endMs) {
  return (resetTimes[cdp] || []).some((t) => t >= startMs && t <= endMs);
}

function parseDumpTs(s) {
  // "2026-08-19T16-25-17-732Z" -> Date
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

function loadSearchDumps() {
  const out = [];
  try {
    for (const f of fs.readdirSync(LOGS)) {
      const m = SEARCH_DUMP_GLOB.exec(f);
      if (!m) continue;
      const ts = parseDumpTs(m[1]);
      if (!ts) continue;
      let batches = 0;
      let found = 0;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(LOGS, f), "utf8"));
        batches = Number(j?.stats?.apiBatches) || 0;
        found = Array.isArray(j?.influencerRecords) ? j.influencerRecords.length : 0;
      } catch { /* ignore */ }
      out.push({ ts, batches, found, file: f });
    }
  } catch { /* ignore */ }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function countEnrichCalls(cdp, startMs, endMs) {
  let text;
  try { text = fs.readFileSync(ENRICH_LOG, "utf8"); } catch { return { userDetail: 0, itemListPages: 0, fails: 0 }; }
  if (text !== enrichTailCache) {
    enrichTailCache = text;
  }
  const lines = text.split(/\r?\n/);
  let userDetail = 0;
  let itemListPages = 0;
  let fails = 0;
  const portRe = new RegExp(`endpoint=http://127\\.0\\.0\\.1:${cdp}#`);
  for (const ln of lines) {
    if (ln.length < 24) continue;
    const ts = Date.parse(ln.slice(0, 24));
    if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
    if (ln.includes(`item_list pages=`)) {
      const pages = ln.match(/pages=(\d+)/);
      if (portRe.test(ln)) itemListPages += pages ? Number(pages[1]) : 0;
    } else if (ln.includes(" user/detail ") && portRe.test(ln)) {
      userDetail += 1;
    } else if (ln.includes("item_list FAIL") || ln.includes("user/detail FAIL")) {
      fails += 1;
    }
  }
  return { userDetail, itemListPages, fails };
}

function portForWorker(workerId) {
  const m = String(workerId || "").match(/-(\d{4})-tiktok$/);
  const cdp = m ? Number(m[1]) : null;
  const info = PORTS.find((p) => p.cdp === cdp);
  return info || null;
}

function fmtMB(b) {
  return (b / (1024 * 1024)).toFixed(2);
}

async function processNewTasks() {
  const since = Math.floor((startedAt - 5000) / 1000);
  const rows = await querySafe(
    `SELECT id, keyword, status, worker_id, error_message,
            UNIX_TIMESTAMP(started_at) AS started_s,
            UNIX_TIMESTAMP(finished_at) AS finished_s,
            progress_search_found_count,
            progress_country_checked_count,
            progress_country_passed_count,
            progress_skip_country_unknown_count,
            progress_skip_country_mismatch_count,
            progress_enriched_count
     FROM tiktok_influencer_search_task
     WHERE worker_ip='36.255.223.151' AND status IN ('succeeded','failed')
       AND UNIX_TIMESTAMP(finished_at) > ?
     ORDER BY finished_at ASC`,
    [since]
  );
  if (!rows) return;
  for (const t of rows) {
    const id = Number(t.id);
    if (reported.has(id)) continue;
    const port = portForWorker(t.worker_id);
    const startMs = Number(t.started_s || 0) * 1000;
    const endMs = Number(t.finished_s || 0) * 1000;
    const res = await querySafe(
      `SELECT keyword, search_count, enrich_success_count, fail_count, fail_reason, elapsed_ms
       FROM tiktok_keyword_run_result WHERE task_id=?`,
      [id]
    );
    const r = res?.[0] || {};
    // search api calls from dump files: prefer keyword match, fallback to time window
    let searchBatches = 0;
    let searchDumps = 0;
    const kw = String(t.keyword || "").trim();
    const kwMatches = loadSearchDumps().filter(
      (d) => d.kw && d.kw.trim() === kw && d.ts >= startMs - 30000 && d.ts <= endMs + 60000
    );
    if (kwMatches.length > 0) {
      searchBatches = kwMatches.reduce((s, d) => s + d.batches, 0);
      searchDumps = kwMatches.length;
    } else {
      for (const d of loadSearchDumps()) {
        if (d.ts >= startMs && d.ts <= endMs + 5000) {
          searchBatches += d.batches;
          searchDumps += 1;
        }
      }
    }
    const enrich = port ? countEnrichCalls(port.cdp, startMs, endMs) : { userDetail: 0, itemListPages: 0, fails: 0 };
    let trafficMB = null;
    let trafficNote = "";
    if (port && startMs && endMs) {
      trafficMB = trafficWindowMB(port.cdp, startMs, endMs);
      const hist = trafficHist[port.cdp] || [];
      if (hist.length && startMs < hist[0].t) trafficNote = "task_start_before_monitor";
      if (midWindowReset(port.cdp, startMs, endMs)) {
        trafficNote += (trafficNote ? "," : "") + "mid_task_ip_rotate";
      }
      trafficMB = trafficMB == null ? null : Number(trafficMB.toFixed(2));
    }
    const durationS = endMs && startMs ? Math.round((endMs - startMs) / 1000) : (Number(r.elapsed_ms) || 0) / 1000;
    const msg =
      `TASK|id=${id}|port=${port?.cdp || "?"}|keyword=${String(t.keyword || "").slice(0, 60)}|` +
      `status=${t.status}|duration_s=${durationS}|` +
      `found=${r.search_count ?? t.progress_search_found_count ?? 0}|` +
      `enrich_ok=${r.enrich_success_count ?? 0}|fail=${r.fail_count ?? 0}|reason=${(r.fail_reason || t.error_message || "").slice(0, 80)}|` +
      `api_est_search=${searchBatches}(dumps=${searchDumps})|` +
      `country_checked=${t.progress_country_checked_count ?? 0}(pass=${t.progress_country_passed_count ?? 0},unknown=${t.progress_skip_country_unknown_count ?? 0},mismatch=${t.progress_skip_country_mismatch_count ?? 0})|` +
      `enrich_user_detail=${enrich.userDetail}|enrich_item_list_pages=${enrich.itemListPages}|enrich_fail_lines=${enrich.fails}|` +
      `traffic_MB=${trafficMB ?? "n/a"}|${trafficNote}`;
    log(msg);
    reported.add(id);
  }
}

// ---- main loop ----
log(`REPORTER_START on151 duration=2h`);
let lastSummaryAt = Date.now();
let pollTraffic = true;
while (Date.now() - startedAt < DURATION_MS) {
  const cycleStart = Date.now();
  if (pollTraffic) {
    await sampleTraffic();
    pollTraffic = false;
  }
  await processNewTasks();
  if (Date.now() - lastSummaryAt >= 10 * 60 * 1000) {
    lastSummaryAt = Date.now();
    const parts = [];
    for (const p of PORTS) {
      const hist = trafficHist[p.cdp] || [];
      let sum = 0;
      for (let i = 1; i < hist.length; i++) {
        if (hist[i].total >= hist[i - 1].total) sum += hist[i].total - hist[i - 1].total;
      }
      const mb = hist.length ? fmtMB(sum) : "n/a";
      parts.push(`${p.cdp}=${mb}MB`);
    }
    log(`SUMMARY_10M ${parts.join(" ")}`);
  }
  const elapsed = Date.now() - cycleStart;
  const wait = elapsed < TRAFFIC_INTERVAL_MS ? TRAFFIC_INTERVAL_MS - elapsed : 0;
  const remain = DURATION_MS - (Date.now() - startedAt);
  if (remain <= 0) break;
  await sleep(Math.min(wait, remain));
  pollTraffic = true;
}
log(`REPORTER_DONE`);
await tiktokPool.end();
process.exit(0);
