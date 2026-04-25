import { queryTikTok } from "./lib/db/mysql-tiktok.js";

const productLink = process.argv[2];
const marker = process.argv[3] || `validate-link-${Date.now()}`;
if (!productLink) {
  console.error("MISSING_PRODUCT_LINK");
  process.exit(2);
}

let campaign = null;
let rows = await queryTikTok(
  `SELECT id, product_info, created_at
   FROM tiktok_campaign
   WHERE JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.productLink')) = ?
   ORDER BY created_at DESC
   LIMIT 1`,
  [productLink]
);
if (rows?.length) campaign = rows[0];

if (!campaign) {
  rows = await queryTikTok(
    `SELECT id, product_info, created_at
     FROM tiktok_campaign
     WHERE JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.productLink')) LIKE ?
     ORDER BY created_at DESC
     LIMIT 1`,
    ["%B0F995LVQV%"]
  );
  if (rows?.length) campaign = rows[0];
}

if (!campaign) {
  console.log("CAMPAIGN_NOT_FOUND");
  process.exit(3);
}

const payload = {
  trigger: "manual_validation_by_product_link",
  targetBatchSize: 1,
  validationMarker: marker,
  createdAt: new Date().toISOString(),
  productLink,
};

const ins = await queryTikTok(
  "INSERT INTO tiktok_influencer_search_task (campaign_id, priority, payload, status) VALUES (?, ?, ?, 'pending')",
  [campaign.id, 999, JSON.stringify(payload)]
);

console.log(JSON.stringify({
  result: "TASK_CREATED",
  campaignId: campaign.id,
  taskId: ins.insertId,
  marker,
}, null, 2));
