import { queryTikTok } from "./lib/db/mysql-tiktok.js";
const marker = process.argv[2];
const rows = await queryTikTok(
  `SELECT id, status, worker_id, started_at, finished_at, LEFT(error_message, 200) AS error_message
   FROM tiktok_influencer_search_task
   WHERE payload LIKE ?
   ORDER BY id DESC
   LIMIT 5`,
  [`%${marker}%`]
);
console.log(JSON.stringify(rows, null, 2));
