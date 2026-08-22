import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
const t = await queryTikTok(
  `SELECT id, status, total_rows, progress_enriched_count, progress_analyzed_count,
          progress_recommended_count, progress_country_checked_count,
          progress_country_passed_count, last_progress_at, updated_at,
          result_summary, error_message
   FROM tiktok_influencer_import_task WHERE id=95`
);
console.log(JSON.stringify(t, null, 1));
await tiktokPool.end();
