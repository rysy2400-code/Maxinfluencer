import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const taskRows = await queryTikTok(
  `SELECT payload, total_rows FROM tiktok_influencer_import_task WHERE id=96`
);
const payload = taskRows?.[0]?.payload;
const parsed = typeof payload === "string" ? JSON.parse(payload) : payload || {};
const names = new Set(
  (parsed.rows || [])
    .map((r) => String(r.username || "").replace(/^@/, "").trim().toLowerCase())
    .filter(Boolean)
);

const logPath = "C:\\maxinfluencer\\logs\\tiktok-enrich.log";
const lines = fs.existsSync(logPath)
  ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean)
  : [];
const cutoff = process.argv[2] || "2026-08-21T13:40:00";
const perUser = new Map();
for (const line of lines) {
  const ts = String(line.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/) || "").replace(/^.*\s/, "");
  if (!ts || ts < cutoff) continue;
  const m = line.match(/@([A-Za-z0-9_.]+)/);
  if (!m) continue;
  const u = m[1].toLowerCase();
  if (!names.has(u)) continue;
  const e = perUser.get(u) || { detail: 0, detailOk: 0, itemOk: 0, itemEmpty: 0, itemFail: 0 };
  if (line.includes("user/detail") && line.includes("ok=true")) {
    e.detail += 1; e.detailOk += 1;
  } else if (line.includes("user/detail")) {
    e.detail += 1;
  }
  if (line.includes("item_list")) {
    if (/items=[1-9]/.test(line)) e.itemOk += 1;
    else if (/items=0/.test(line)) e.itemEmpty += 1;
    else e.itemFail += 1;
  }
  perUser.set(u, e);
}
let usersSeen = 0, usersWithItems = 0, usersEmpty = 0, totalItemOk = 0;
for (const [u, e] of perUser) {
  usersSeen += 1;
  if (e.itemOk > 0) { usersWithItems += 1; totalItemOk += 1; }
  else if (e.itemEmpty > 0 || e.itemFail > 0) usersEmpty += 1;
}
console.log(
  `TASK95 since=${cutoff} payload=${names.size} enrichUsers=${usersSeen} withItems=${usersWithItems} ` +
  `emptyOnly=${usersEmpty} itemOkCalls=${totalItemOk}`
);
await tiktokPool.end();
process.exit(0);
