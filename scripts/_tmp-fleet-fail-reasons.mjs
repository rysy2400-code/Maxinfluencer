import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const since = process.argv[2] || "2026-08-21 13:00:00";
const rows = await queryTikTok(
  `SELECT assigned_worker_ip AS ip, fail_count, enrich_success_count,
          fail_reason, keyword
   FROM tiktok_keyword_run_result
   WHERE assigned_worker_ip IN ('36.255.223.151','152.32.192.65','152.32.187.244','152.32.174.208','36.255.223.141')
     AND updated_at > ?
   ORDER BY updated_at DESC LIMIT 40`,
  [since]
);
for (const r of rows || []) {
  const msg = String(r.fail_reason || "").slice(0, 110).replace(/\s+/g, " ");
  console.log(`R|${r.ip}|fail=${r.fail_count}|enrich=${r.enrich_success_count}|${r.keyword ? String(r.keyword).slice(0, 30) : "-"}|${msg}`);
}
await tiktokPool.end();
process.exit(0);
