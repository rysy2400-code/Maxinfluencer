#!/usr/bin/env node
/**
 * 151 上执行：全舰队 tiktok 搜索任务消费统计（按 worker_ip）
 * 用法: node --experimental-default-type=module scripts/_tmp-fleet-stats.mjs "2026-08-21 07:15:00"
 */
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
const since = process.argv[2] || "2026-08-21 00:00:00";

const rows = await queryTikTok(
  `SELECT assigned_worker_ip AS worker_ip,
          COUNT(*) AS total,
          SUM(enrich_success_count>0) AS with_enrich,
          SUM(fail_count>0) AS failed
   FROM tiktok_keyword_run_result
   WHERE assigned_worker_ip IN ('36.255.223.151','152.32.192.65','152.32.187.244','152.32.174.208','36.255.223.141')
     AND updated_at > ?
   GROUP BY worker_ip ORDER BY worker_ip`,
  [since]
);
for (const r of rows || []) {
  console.log(`STAT|${r.worker_ip}|${r.total}|${r.with_enrich}|${r.failed}`);
}
const inflight = await queryTikTok(
  `SELECT worker_ip, COUNT(*) AS c FROM tiktok_influencer_search_task
   WHERE status='processing' AND worker_ip IN ('36.255.223.151','152.32.192.65','152.32.187.244','152.32.174.208','36.255.223.141')
   GROUP BY worker_ip`
);
for (const r of inflight || []) {
  console.log(`INFLIGHT|${r.worker_ip}|${r.c}`);
}
await tiktokPool.end();
process.exit(0);
