/**
 * Phase 2 队列写入测试（需 DB）
 * 运行：node scripts/test-advertiser-followup-enqueue.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getCampaignById, getExecutionRow } from "../lib/db/campaign-dao.js";
import { enqueueAdvertiserExecutionFollowup } from "../lib/execution/enqueue-advertiser-followup.js";
import { resolveBriefKey } from "../lib/agents/advertiser-execution-followup-email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  console.log("=== advertiser followup enqueue 测试 ===\n");

  // 静态 brief 映射
  assert(
    resolveBriefKey("approveQuote", false, false) === "approveQuote_no_sample",
    "应用 approveQuote brief"
  );
  assert(
    resolveBriefKey("approveQuote", true, false) ===
      "approveQuote_need_sample_no_address",
    "电商无地址 brief"
  );
  assert(
    resolveBriefKey("approveQuote", true, true) ===
      "approveQuote_need_sample_has_address",
    "电商有地址 brief"
  );

  const rows = await queryTikTok(
    `SELECT campaign_id, tiktok_username FROM tiktok_campaign_execution ORDER BY updated_at DESC LIMIT 1`,
    []
  );
  if (!rows?.length) {
    console.log("跳过 DB 写入测试：无 execution 行");
    console.log("\n静态测试通过");
    return;
  }

  const campaignId = rows[0].campaign_id;
  const influencerId = rows[0].tiktok_username;
  const campaign = await getCampaignById(campaignId);
  const executionRow = await getExecutionRow(campaignId, influencerId);

  const eventId = await enqueueAdvertiserExecutionFollowup({
    campaignId,
    influencerId,
    action: "approveQuote",
    campaign,
    executionRow,
    payload: { source: "test_script" },
  });

  if (!eventId) {
    throw new Error("enqueue 未返回 event id");
  }

  const ev = await queryTikTok(
    `SELECT event_type, status, payload FROM tiktok_influencer_agent_event WHERE id = ?`,
    [eventId]
  );
  const rawPayload = ev[0].payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? rawPayload
      : JSON.parse(rawPayload);
  assert(ev[0].event_type === "advertiser_execution_followup", "event_type");
  assert(ev[0].status === "pending", "status pending");
  assert(payload.action === "approveQuote", "payload.action");
  assert(payload.campaignId === campaignId, "payload.campaignId");
  assert(
    payload.campaignContext?.brandName === campaign?.productInfo?.brandName,
    "payload.campaignContext.brandName"
  );
  assert(
    payload.campaignContext?.productName === campaign?.productInfo?.productName,
    "payload.campaignContext.productName"
  );

  await queryTikTok(`DELETE FROM tiktok_influencer_agent_event WHERE id = ?`, [
    eventId,
  ]);
  console.log("DB 写入/清理测试通过 ✓");
  console.log("\n全部测试通过");
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
  console.log("OK:", msg);
}

main()
  .then(() => process.exit(failed > 0 ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
