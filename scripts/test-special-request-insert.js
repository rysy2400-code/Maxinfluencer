/**
 * 测试脚本：插入一条 ask_influencer_special_request 事件，用于测试特殊请求流程。
 * 使用 test_rysy_1 + 第一个可用的 campaign。
 *
 * 使用方式：node scripts/test-special-request-insert.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TEST_INFLUENCER_ID = "test_rysy_1";

async function main() {
  const campaigns = await queryTikTok(
    `SELECT id FROM tiktok_campaign ORDER BY created_at DESC LIMIT 1`,
    []
  );
  const campaignId = campaigns?.[0]?.id || null;

  if (!campaignId) {
    console.error("[TestSpecialRequest] 未找到 campaign，请先运行 seed 脚本。");
    process.exit(1);
  }

  const inf = await queryTikTok(
    `SELECT influencer_id FROM tiktok_influencer WHERE influencer_id = ? LIMIT 1`,
    [TEST_INFLUENCER_ID]
  );
  if (!inf?.length) {
    console.error("[TestSpecialRequest] 未找到测试红人 test_rysy_1，请先运行 node scripts/seed-test-influencer-rysy-email.js");
    process.exit(1);
  }

  const payload = {
    campaignId,
    influencerId: TEST_INFLUENCER_ID,
    specialRequestId: "SR-TEST-0001",
    specialRequestStatus: "pending_creator",
    requestDirection: "brand_to_creator",
    brandMessage:
      "品牌方希望看看红人是否愿意 300 刀 2 条视频 + 200 刀再 1 条，并把发布时间从 3 月 15 日改到 3 月 20 日。",
  };

  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_agent_event (
      influencer_id,
      campaign_id,
      event_type,
      payload,
      status
    ) VALUES (?, ?, 'ask_influencer_special_request', ?, 'pending')
  `,
    [TEST_INFLUENCER_ID, campaignId, JSON.stringify(payload)]
  );

  console.log("[TestSpecialRequest] 已插入 ask_influencer_special_request 事件");
  console.log("  campaignId:", campaignId);
  console.log("  influencerId:", TEST_INFLUENCER_ID);
  console.log("  specialRequestId:", payload.specialRequestId);
  console.log("\n请运行: node scripts/process-influencer-agent-events.js");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
