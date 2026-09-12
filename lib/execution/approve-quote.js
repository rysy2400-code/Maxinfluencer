/**
 * 同意报价：扣款 + 推进 stage + 写入跟进队列（UI / Agent 共用）
 */
import { getCampaignCoreById, getExecutionRow } from "../db/campaign-dao.js";
import { approveQuoteWithCharge } from "../billing/approve-quote-charge.js";
import { enqueueAdvertiserExecutionFollowup } from "./enqueue-advertiser-followup.js";
import { validateAndNormalizeContentBrief } from "./content-brief.js";
import { enqueueContractEmail } from "../contract/enqueue-contract-email.js";

/** 品牌点「确认同意」后是否自动生成并发送合同邮件（可用 CONTRACT_AUTO_SEND=0 关闭） */
function isContractAutoSendEnabled() {
  const v = String(process.env.CONTRACT_AUTO_SEND ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

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

    // 品牌点「确认同意」后自动生成并发送正式合同（系统建议价需红人先确认，故跳过）
    if (isContractAutoSendEnabled() && executionRow?.quote_origin !== "commerce_profile_estimate") {
      try {
        await enqueueContractEmail({
          campaignId,
          influencerHandle: executionRow?.tiktok_username || influencerId,
          platformInfluencerId: executionRow?.influencer_id || null,
        });
      } catch (contractErr) {
        console.warn(
          "[executeApproveQuote] 合同邮件入队失败（不影响扣款与 stage）:",
          contractErr?.message || contractErr
        );
      }
    }
  } catch (enqueueErr) {
    console.warn(
      "[executeApproveQuote] 写入 Influencer Agent 跟进队列失败（不影响扣款与 stage）:",
      enqueueErr?.message || enqueueErr
    );
  }

  return chargeResult;
}
