import { queryTikTok } from "./lib/db/mysql-tiktok.js";

const link = process.argv[2];
if (!link) {
  console.log("MISSING_LINK");
  process.exit(2);
}

const rows = await queryTikTok(
  `SELECT id, session_id, status, created_at,
          JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.productLink')) AS productLink,
          JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.brandName')) AS brandName,
          JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.productName')) AS productName
   FROM tiktok_campaign
   WHERE JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.productLink')) = ?
   ORDER BY created_at DESC
   LIMIT 20`,
  [link]
);

console.log(JSON.stringify(rows, null, 2));
