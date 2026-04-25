/**
 * 种子脚本：为测试流程创建带 Gmail 的红人，使用 tiktok_campaign 表中已有的 3 条 campaign，
 * 为每条 campaign 创建执行行并发送英文邀约邮件到 rysy2400@gmail.com。
 *
 * 使用方式：
 *   node scripts/seed-test-influencer-rysy-email.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { upsertInfluencer, getInfluencerById } from "../lib/db/influencer-dao.js";
import { enqueueFirstOutreach } from "../lib/agents/influencer-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TEST_INFLUENCER_ID = "test_rysy_1";
const TEST_INFLUENCER_USERNAME = "rysy_test_creator";
const TEST_INFLUENCER_EMAIL = "rysy2400@gmail.com";

async function ensureTestInfluencer() {
  await upsertInfluencer({
    influencerId: TEST_INFLUENCER_ID,
    platform: "tiktok",
    region: "US",
    username: TEST_INFLUENCER_USERNAME,
    displayName: "Rysy Test",
    avatarUrl: null,
    profileUrl: `https://www.tiktok.com/@${TEST_INFLUENCER_USERNAME}`,
    followerCount: 0,
    avgViews: 0,
    influencerEmail: TEST_INFLUENCER_EMAIL,
    source: "manual_seed",
    sourceRef: null,
    sourcePayload: null,
    lastFetchedAt: new Date(),
  });

  const inf = await getInfluencerById(TEST_INFLUENCER_ID);
  console.log("[SeedTest] 已确保测试红人存在：", {
    influencerId: inf?.influencerId,
    influencerEmail: inf?.influencerEmail,
  });
}

async function getExistingCampaigns(limit = 3) {
  const n = Math.min(10, Math.max(1, Number(limit) || 3));
  const rows = await queryTikTok(
    `SELECT id FROM tiktok_campaign ORDER BY created_at DESC LIMIT ${n}`,
    []
  );
  return rows || [];
}

async function ensureExecutionRow(campaignId) {
  const inf = await getInfluencerById(TEST_INFLUENCER_ID);
  const snapshot = inf
    ? {
        influencerId: inf.influencerId,
        username: inf.username,
        displayName: inf.displayName,
        profileUrl: inf.profileUrl,
        influencerEmail: inf.influencerEmail || null,
      }
    : null;

  await queryTikTok(
    `
    INSERT INTO tiktok_campaign_execution (
      campaign_id, influencer_id, influencer_snapshot, stage, last_event, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'pending_quote', NULL, NOW(), NOW()
    )
    ON DUPLICATE KEY UPDATE
      influencer_snapshot = VALUES(influencer_snapshot),
      updated_at = NOW()
  `,
    [
      campaignId,
      TEST_INFLUENCER_ID,
      snapshot ? JSON.stringify(snapshot) : null,
    ]
  );

  return snapshot;
}

async function main() {
  await ensureTestInfluencer();

  const campaigns = await getExistingCampaigns(3);
  if (!campaigns.length) {
    console.error("[SeedTest] tiktok_campaign 表中没有 campaign，请先发布至少一个 campaign。");
    process.exit(1);
  }

  console.log("[SeedTest] 为以下 campaign 创建首轮邀约事件：", campaigns.map((c) => c.id));

  for (const c of campaigns) {
    const campaignId = c.id;
    const snapshot = await ensureExecutionRow(campaignId);

    console.log("[SeedTest] 写入首轮邀约事件：", { campaignId, influencerId: TEST_INFLUENCER_ID });
    await enqueueFirstOutreach({
      campaignId,
      influencerId: TEST_INFLUENCER_ID,
      snapshot,
    });
  }

  console.log(
    "[SeedTest] 已为 rysy2400@gmail.com 创建 " +
      campaigns.length +
      " 条首轮邀约事件（基于真实 campaign 的英文内容），请运行 InfluencerAgent 事件 Worker 实际发信并检查收件箱。"
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[SeedTest] 脚本运行出错：", err);
    process.exit(1);
  });

