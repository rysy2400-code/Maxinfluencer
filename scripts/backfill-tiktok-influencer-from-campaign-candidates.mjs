/**
 * 从 tiktok_campaign_influencer_candidates 回填 tiktok_influencer（与候选/执行 influencer_id 对齐）。
 *
 * 用法：
 *   node scripts/backfill-tiktok-influencer-from-campaign-candidates.mjs CAMP-xxx
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { backfillTiktokInfluencerFromCampaignCandidates } from "../lib/db/campaign-candidates-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const campaignId = process.argv[2];
if (!campaignId) {
  console.error("用法: node scripts/backfill-tiktok-influencer-from-campaign-candidates.mjs <campaignId>");
  process.exit(1);
}

const r = await backfillTiktokInfluencerFromCampaignCandidates(campaignId);
console.log(JSON.stringify(r, null, 2));
