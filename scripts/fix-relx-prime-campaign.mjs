/**
 * 修复「法国 RELX prime」campaign（CAMP-1786935898068-SNXGL7C8K）：
 * 1. 产品链接 → https://relxnow.fr/（仅更新链接字段，保留已确认的 RELX / RELX Prime 等其他产品信息）
 * 2. 红人画像 accountType → 「无特殊要求，你觉得合适的一律通过」
 * 3. 追加一条聊天消息，说明链接已更正
 *
 * 走真实 modify_campaign 链路（含归一化查重），用法：
 *   node scripts/fix-relx-prime-campaign.mjs
 */
import { executeCampaignExecutionTool } from "../lib/tools/campaign-execution/campaign-execution-tools.js";
import { appendBinMessageToSession } from "../lib/db/campaign-session-dao.js";
import { getCampaignById } from "../lib/db/campaign-dao.js";

const CAMPAIGN_ID = "CAMP-1786935898068-SNXGL7C8K";
const SESSION_ID = "667bb9aa-2546-4f7a-88a8-704fd8a47964";
const NEW_LINK = "https://relxnow.fr/";
const NEW_ACCOUNT_TYPE = "无特殊要求，你觉得合适的一律通过";

const campaign = await getCampaignById(CAMPAIGN_ID);
if (!campaign) {
  console.error("campaign not found:", CAMPAIGN_ID);
  process.exit(1);
}

console.log("[FixRelxPrime] 当前 productLink:", campaign.productInfo?.productLink);

const linkResult = await executeCampaignExecutionTool("modify_campaign", {
  campaignId: CAMPAIGN_ID,
  scope: "whole",
  changes: { productLink: NEW_LINK },
});
if (!linkResult.success) {
  console.error("[FixRelxPrime] 修改产品链接失败:", linkResult.message);
  process.exit(1);
}
console.log("[FixRelxPrime] 产品链接已改为", NEW_LINK);

const profileResult = await executeCampaignExecutionTool("modify_campaign", {
  campaignId: CAMPAIGN_ID,
  scope: "whole",
  changes: {
    screeningConditions: { accountType: NEW_ACCOUNT_TYPE },
  },
});
if (!profileResult.success) {
  console.error("[FixRelxPrime] 修改红人画像失败:", profileResult.message);
  process.exit(1);
}
console.log("[FixRelxPrime] 红人画像 accountType 已更新");

const refreshed = await getCampaignById(CAMPAIGN_ID);
console.log("[FixRelxPrime] 最终 productLink:", refreshed?.productInfo?.productLink);
console.log(
  "[FixRelxPrime] 最终 accountType:",
  refreshed?.influencerProfile?.accountType
);

const msg = await appendBinMessageToSession(
  SESSION_ID,
  "已更正产品链接为 https://relxnow.fr/（仅更新链接，其他产品信息保留）；红人画像已调整为「无特殊要求，你觉得合适的一律通过」。"
);
console.log("[FixRelxPrime] 会话消息追加:", msg.success ? "成功" : msg.message);

process.exit(0);
