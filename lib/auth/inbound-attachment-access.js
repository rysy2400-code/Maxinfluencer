import { queryTikTok } from "../db/mysql-tiktok.js";

const SESSION_TABLE = "tiktok_campaign_sessions";

/**
 * 红人收件箱管理员，或拥有该红人相关 campaign 的广告主，可访问收件附件。
 * @param {number} attachmentId
 * @param {{ inboxAdmin?: object|null, advertiserAuth?: object|null }} auth
 */
export async function canAccessInboundAttachment(attachmentId, { inboxAdmin, advertiserAuth } = {}) {
  const id = Number(attachmentId);
  if (!id || Number.isNaN(id)) return false;
  if (inboxAdmin) return true;
  if (!advertiserAuth?.advertiserUserId) return false;
  if (advertiserAuth.isAdmin) return true;

  const rows = await queryTikTok(
    `
    SELECT a.id
    FROM tiktok_influencer_email_event_attachments a
    INNER JOIN tiktok_influencer_email_events e ON e.id = a.event_id
    INNER JOIN tiktok_campaign_execution ex ON (
      ex.influencer_id = e.influencer_id
      OR ex.tiktok_username = (
        SELECT i.username
        FROM tiktok_influencer i
        WHERE i.influencer_id = e.influencer_id
        LIMIT 1
      )
    )
    INNER JOIN tiktok_campaign c ON c.id = ex.campaign_id
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id
    WHERE a.id = ? AND s.advertiser_user_id = ?
    LIMIT 1
  `,
    [id, advertiserAuth.advertiserUserId]
  );
  return !!(rows && rows[0]);
}
