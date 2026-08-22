import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
try {
  const r = await queryTikTok(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tiktok_keyword_run_result'`
  );
  console.log((r || []).map((c) => c.COLUMN_NAME).join(","));
} catch (e) {
  console.log("ERR " + e.message);
}
await tiktokPool.end();
process.exit(0);
