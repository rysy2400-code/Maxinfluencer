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
import {
  SHIPPING_MENTION_ACTIONS,
  containsForbiddenAddressConfirm,
  containsForbiddenShippingConfirm,
  resolveAskShippingConfirmation,
} from "../lib/execution/followup-shipping-guard.js";

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

  // 寄样地址确认判定：仅 approveQuote（未寄样）允许确认地址
  assert(
    resolveAskShippingConfirmation({
      action: "approveQuote",
      hasShippingInfo: true,
      sampleSentAt: null,
    }) === true,
    "approveQuote 有地址未寄样 → 需要确认地址"
  );
  assert(
    resolveAskShippingConfirmation({
      action: "approveQuote",
      hasShippingInfo: true,
      sampleSentAt: "2026-08-09T11:08:45.771Z",
    }) === false,
    "approveQuote 已寄样 → 不再确认地址"
  );
  assert(
    resolveAskShippingConfirmation({
      action: "approveQuote",
      hasShippingInfo: false,
      sampleSentAt: null,
    }) === false,
    "approveQuote 无地址 → 不需要展示已有地址"
  );
  assert(
    resolveAskShippingConfirmation({
      action: "confirmShip",
      hasShippingInfo: true,
      sampleSentAt: "2026-08-09T11:08:45.771Z",
    }) === false,
    "confirmShip → 只通知已寄出，不再确认地址"
  );
  for (const action of [
    "confirmShip",
    "approveDraft",
    "approveScript",
    "rejectDraft",
    "confirmSystemQuote",
    "askSystemQuoteAtPrice",
    "rejectQuote",
    "submitQuote",
  ]) {
    assert(
      resolveAskShippingConfirmation({
        action,
        hasShippingInfo: true,
        sampleSentAt: null,
      }) === false,
      `${action} → 禁止确认寄样地址`
    );
  }

  // 兜底放行名单：confirmShip 可合法提及“样品已寄出”，但不得确认地址
  assert(
    SHIPPING_MENTION_ACTIONS.has("confirmShip") &&
      SHIPPING_MENTION_ACTIONS.has("approveQuote"),
    "confirmShip/approveQuote 允许提及寄样"
  );
  assert(
    SHIPPING_MENTION_ACTIONS.has("approveDraft") === false,
    "approveDraft 不允许提及寄样"
  );

  // 发送前兜底：识别误含的“确认地址 / 样品即将寄出”表述
  assert(
    containsForbiddenShippingConfirm(
      "can you just confirm this address is good to use?"
    ) === true,
    "识别「confirm this address」"
  );
  assert(
    containsForbiddenShippingConfirm(
      "the Echo Mini sample shipment is about to go out"
    ) === true,
    "识别「shipment about to go out」"
  );
  assert(
    containsForbiddenShippingConfirm(
      "Great news — your draft is approved. You're clear to publish!"
    ) === false,
    "正常发布邮件不误判"
  );
  assert(
    containsForbiddenAddressConfirm(
      "your Echo Mini sample is officially on its way"
    ) === false,
    "confirmShip 的「样品在路上」不被地址确认规则误判"
  );
  assert(
    containsForbiddenAddressConfirm(
      "could you confirm this address is good to use?"
    ) === true,
    "确认地址仍会被地址确认规则拦截"
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
  assert("sampleSentAt" in payload, "payload.sampleSentAt 存在");
  assert("shippingConfirmedAt" in payload, "payload.shippingConfirmedAt 存在");
  assert(
    payload.askShippingConfirmation ===
      resolveAskShippingConfirmation({
        action: "approveQuote",
        hasShippingInfo: payload.hasShippingInfo === true,
        sampleSentAt: payload.sampleSentAt || null,
      }),
    "payload.askShippingConfirmation 与纯函数判定一致"
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
