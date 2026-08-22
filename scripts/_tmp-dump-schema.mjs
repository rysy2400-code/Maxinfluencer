#!/usr/bin/env node
/**
 * On 151: dump key table schemas for per-task reporting.
 */
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

for (const t of ["tiktok_keyword_run_result", "tiktok_influencer_search_task"]) {
  const cols = await queryTikTok(`SHOW COLUMNS FROM ${t}`);
  console.log(`===== ${t} =====`);
  for (const c of cols) console.log(`${c.Field}|${c.Type}|${c.Null}|${c.Default}`);
}
await tiktokPool.end();
process.exit(0);
