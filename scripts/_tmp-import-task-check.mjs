#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const dist = await queryTikTok(
  `SELECT status, COUNT(*) AS c,
          SUM(payload LIKE '%"platform":"tiktok"%' OR payload LIKE '%tiktok%') AS tiktok_like
   FROM tiktok_influencer_import_task GROUP BY status`
);
console.log("DIST", JSON.stringify(dist));

const recent = await queryTikTok(
  `SELECT id, campaign_id, import_batch_id, status, worker_id, worker_ip,
          created_at, updated_at
   FROM tiktok_influencer_import_task
   ORDER BY id DESC LIMIT 12`
);
for (const r of recent) console.log("ROW", JSON.stringify(r));

const pending = await queryTikTok(
  `SELECT id, campaign_id, import_batch_id, created_at,
          LEFT(payload, 300) AS payload_head
   FROM tiktok_influencer_import_task
   WHERE status='pending'
   ORDER BY priority DESC, id ASC LIMIT 8`
);
console.log("PENDING_ROWS", JSON.stringify(pending));

await tiktokPool.end();
process.exit(0);
