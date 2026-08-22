#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const rows = await queryTikTok(
  `SELECT id, name, status, session_id, region,
          JSON_UNQUOTE(JSON_EXTRACT(target_countries,'$')) AS countries
   FROM tiktok_campaign
   WHERE name LIKE '%meetwhale%' OR name LIKE '%Echo Mini%'
   ORDER BY updated_at DESC LIMIT 10`
);
console.log("CAMPAIGNS", JSON.stringify(rows, null, 1));
await tiktokPool.end();
process.exit(0);
