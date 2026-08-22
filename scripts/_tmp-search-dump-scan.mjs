#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const LOGS = "C:\\maxinfluencer\\logs";
const RE = /^search-tiktok-lite-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;
const cutoff = Date.now() - 40 * 60 * 1000;
const out = [];
for (const f of fs.readdirSync(LOGS)) {
  const m = RE.exec(f);
  if (!m) continue;
  const ts = Date.parse(m[1].replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z"));
  if (!Number.isFinite(ts) || ts < cutoff) continue;
  let kw = "";
  let batches = 0;
  let found = 0;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(LOGS, f), "utf8"));
    kw = j?.keyword || "";
    batches = Number(j?.stats?.apiBatches) || 0;
    found = Number(j?.stats?.influencerCount) || 0;
  } catch {}
  out.push({ ts, file: f, kw, batches, found });
}
out.sort((a, b) => a.ts - b.ts);
for (const o of out) console.log(`${new Date(o.ts).toISOString()} kw=${o.kw} batches=${o.batches} found=${o.found}`);
process.exit(0);
