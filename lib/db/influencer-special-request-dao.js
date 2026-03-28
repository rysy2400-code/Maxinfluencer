/**
 * 红人特殊请求与反馈 DAO
 */
import { queryTikTok } from "./mysql-tiktok.js";

export async function createSpecialRequest(data) {
  const sql = `
    INSERT INTO influencer_special_requests (request_id, campaign_id, influencer_id, request_type, request_detail, deadline, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `;
  await queryTikTok(sql, [
    data.requestId,
    data.campaignId,
    data.influencerId,
    data.requestType,
    data.requestDetail,
    data.deadline || null,
  ]);
  return data.requestId;
}

export async function getSpecialRequestByRequestId(requestId) {
  const sql = `SELECT * FROM influencer_special_requests WHERE request_id = ?`;
  const rows = await queryTikTok(sql, [requestId]);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    requestId: r.request_id,
    campaignId: r.campaign_id,
    influencerId: r.influencer_id,
    requestType: r.request_type,
    requestDetail: r.request_detail,
    deadline: r.deadline,
    status: r.status,
    influencerReply: r.influencer_reply,
    syncedToAdvertiser: !!r.synced_to_advertiser,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function updateSpecialRequestFeedback(requestId, feedback) {
  const sql = `
    UPDATE influencer_special_requests
    SET status = ?, influencer_reply = ?, synced_to_advertiser = ?, updated_at = NOW()
    WHERE request_id = ?
  `;
  await queryTikTok(sql, [
    feedback.status || "replied",
    feedback.influencerReply ?? null,
    feedback.syncedToAdvertiser ? 1 : 0,
    requestId,
  ]);
}
