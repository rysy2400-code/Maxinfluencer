import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const imports = await queryTikTok(
  `SELECT id, campaign_id, status, worker_ip, total_rows,
          progress_enriched_count, last_progress_at, updated_at
   FROM tiktok_influencer_import_task
   WHERE status='processing' ORDER BY id DESC LIMIT 10`
);
console.log("IMPORTS " + JSON.stringify(imports));

const searches = await queryTikTok(
  `SELECT id, status, worker_ip, progress_search_found_count,
          last_progress_at, updated_at
   FROM tiktok_influencer_search_task
   WHERE status='processing' ORDER BY id DESC LIMIT 12`
);
console.log("SEARCHES " + JSON.stringify(searches));

await tiktokPool.end();
process.exit(0);
