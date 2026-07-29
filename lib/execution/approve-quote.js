/**
 * 同意报价：扣款 + 推进 stage + 写入跟进队列（UI / Agent 共用）
 */
import { getCampaignCoreById, getExecutionRow } from "../db/campaign-dao.js";
import { approveQuoteWithCharge } from "../billing/approve-quote-charge.js";
import { enqueueAdvertiserExecutionFollowup } from "./enqueue-advertiser-followup.js";
import { validateAndNormalizeContentBrief } from "./content-brief.js";

/**
 * @param {{
 *   campaignId: string,
 *   influencerId: string,
 *   advertiserId: number,
 *   advertiserUserId?: number | null,
 *   payload?: object,
 * }} opts
 */
export async function executeApproveQuote(opts) {
  const campaignId = String(opts.campaignId || "").trim();
  const influencerId = String(opts.influencerId || "").trim();
  const briefResult = validateAndNormalizeContentBrief(
    opts.payload || {},
    opts.payload?.source || "advertiser_portal"
  );
  if (!briefResult.ok) {
    return { success: false, message: briefResult.message };
  }
  const contentBrief = briefResult.contentBrief;

  const chargeResult = await approveQuoteWithCharge({
    campaignId,
    influencerId,
    advertiserId: opts.advertiserId,
    advertiserUserId: opts.advertiserUserId,
    contentBrief,
  });

  if (!chargeResult.success) {
    return chargeResult;
  }

  const campaign = await getCampaignCoreById(campaignId);
  try {
    const executionRow = await getExecutionRow(campaignId, influencerId);
    await enqueueAdvertiserExecutionFollowup({
      campaignId,
      influencerId,
      action:
        executionRow?.quote_origin === "commerce_profile_estimate"
          ? "confirmSystemQuote"
          : "approveQuote",
      campaign,
      executionRow,
      payload: { ...(opts.payload || {}), contentBrief },
    });
  } catch (enqueueErr) {
    console.warn(
      "[executeApproveQuote] 写入 Influencer Agent 跟进队列失败（不影响扣款与 stage）:",
      enqueueErr?.message || enqueueErr
    );
  }

  return chargeResult;
}
