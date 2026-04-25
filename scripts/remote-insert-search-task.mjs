import { queryTikTok } from "./lib/db/mysql-tiktok.js";

const marker = process.argv[2] || `manual-${Date.now()}`;
const rows = await queryTikTok("SELECT id FROM tiktok_campaign ORDER BY created_at DESC LIMIT 1");
const cid = rows?.[0]?.id;
if (!cid) {
  console.log("NO_CAMPAIGN");
  process.exit(2);
}
const payload = {
  trigger: "manual_validation",
  targetBatchSize: 1,
  validationMarker: marker,
  createdAt: new Date().toISOString(),
};
const result = await queryTikTok(
  "INSERT INTO tiktok_influencer_search_task (campaign_id, priority, payload, status) VALUES (?, ?, ?, 'pending')",
  [cid, 999, JSON.stringify(payload)]
);
console.log(`INSERTED ${cid} ${result.insertId} ${marker}`);
