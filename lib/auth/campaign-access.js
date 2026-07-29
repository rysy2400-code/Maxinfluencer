import { getCampaignCoreById } from "../db/campaign-dao.js";
import { assertUserCanAccessSession } from "./session-access.js";

/**
 * 校验登录用户是否有权操作指定 campaign（经 session 归属）
 * @param {string} campaignId
 * @param {{ advertiserUserId: number, isAdmin: boolean }} authUser
 */
export async function assertUserCanAccessCampaign(campaignId, authUser) {
  if (!campaignId || !authUser) {
    return { ok: false, status: 401, campaign: null };
  }
  const campaign = await getCampaignCoreById(campaignId);
  if (!campaign) {
    return { ok: false, status: 404, campaign: null };
  }
  const sessionId =
    typeof campaign.sessionId === "string" ? campaign.sessionId.trim() : "";
  if (!sessionId) {
    return { ok: false, status: 403, campaign };
  }
  const access = await assertUserCanAccessSession(sessionId, authUser);
  if (!access.ok) {
    return { ok: false, status: access.status, campaign };
  }
  return { ok: true, status: 200, campaign };
}
