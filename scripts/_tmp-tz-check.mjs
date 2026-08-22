#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const tz = await queryTikTok("SELECT NOW() AS now_utc, @@session.time_zone AS sess_tz, @@global.time_zone AS glob_tz, UTC_TIMESTAMP() AS utc_now");
console.log("TZ", JSON.stringify(tz));

const last30 = await queryTikTok(
  `SELECT assigned_worker, COUNT(*) AS c,
          MAX(updated_at) AS max_upd, MIN(updated_at) AS min_upd
   FROM tiktok_keyword_run_result
   WHERE assigned_worker_ip='36.255.223.151' AND updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
   GROUP BY assigned_worker`
);
console.log("LAST30", JSON.stringify(last30));

const pending = await queryTikTok(
  `SELECT COUNT(*) AS c FROM tiktok_influencer_search_task
   WHERE status='pending' AND (platform='tiktok' OR platform IS NULL)`
);
console.log("PENDING", JSON.stringify(pending));

const lastTasks = await queryTikTok(
  `SELECT id, keyword, status, worker_id, started_at, finished_at
   FROM tiktok_influencer_search_task
   WHERE worker_ip='36.255.223.151' AND finished_at IS NOT NULL
   ORDER BY finished_at DESC LIMIT 12`
);
console.log("LASTTASKS", JSON.stringify(lastTasks));

await tiktokPool.end();
process.exit(0);
