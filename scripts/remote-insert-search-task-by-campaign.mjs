import { queryTikTok } from "./lib/db/mysql-tiktok.js";

const campaignId = process.argv[2];
const marker = process.argv[3] || `manual-${Date.now()}`;

if (!campaignId) {
  console.log("MISSING_CAMPAIGN_ID");
  process.exit(2);
}

const payload = {
  trigger: "manual_validation",
  targetBatchSize: 1,
  validationMarker: marker,
  createdAt: new Date().toISOString(),
  userMessage: "Find scientific illustration AI related creators"
};

const result = await queryTikTok(
  "INSERT INTO tiktok_influencer_search_task (campaign_id, priority, payload, status) VALUES (?, ?, ?, 'pending')",
  [campaignId, 999, JSON.stringify(payload)]
);

console.log(`INSERTED ${campaignId} ${result.insertId} ${marker}`);
