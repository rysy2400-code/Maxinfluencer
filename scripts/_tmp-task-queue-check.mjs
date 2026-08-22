import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const pending = await queryTikTok(
  `SELECT status, COUNT(*) AS c FROM tiktok_influencer_search_task
   WHERE status IN ('pending','processing') GROUP BY status`
);
console.log("QUEUE " + JSON.stringify(pending));

const recent = await queryTikTok(
  `SELECT status, COUNT(*) AS c FROM tiktok_influencer_search_task
   WHERE updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE) GROUP BY status`
);
console.log("RECENT30 " + JSON.stringify(recent));

await tiktokPool.end();
process.exit(0);
