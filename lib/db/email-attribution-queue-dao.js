// 未归属邮件待确认队列 DAO
import { queryTikTok } from "./mysql-tiktok.js";

export async function listPendingAttributionQueue({ limit = 50 } = {}) {
  const n = Math.min(100, Math.max(1, Number(limit) || 50));
  const rows = await queryTikTok(
    `SELECT q.id, q.email_event_id, q.from_email, q.to_email, q.subject, q.in_reply_to,
            q.body_excerpt, q.reason, q.status, q.created_at,
            e.received_at, e.body_text
     FROM tiktok_influencer_email_attribution_queue q
     LEFT JOIN tiktok_influencer_email_events e ON e.id = q.email_event_id
     WHERE q.status = 'pending'
     ORDER BY q.created_at ASC
     LIMIT ?`,
    [n]
  );
  return rows;
}

export async function countPendingAttributionQueue() {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM tiktok_influencer_email_attribution_queue WHERE status = 'pending'`
  );
  return Number(rows?.[0]?.n || 0);
}

/**
 * 认领：更新队列状态，并把对应事件与对话消息归到规范 influencer_id（进入正常 LLM 处理）。
 */
export async function claimAttributionQueueItem(id, influencerId) {
  const qRows = await queryTikTok(
    `SELECT id, email_event_id FROM tiktok_influencer_email_attribution_queue
     WHERE id = ? AND status = 'pending' LIMIT 1`,
    [id]
  );
  const q = qRows && qRows[0];
  if (!q) return { ok: false, error: "队列项不存在或已处理" };

  await queryTikTok(
    `UPDATE tiktok_influencer_email_attribution_queue
     SET status = 'claimed', claimed_influencer_id = ?, claimed_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [influencerId, id]
  );

  // 事件进入正常处理（归属成功 → pending）
  await queryTikTok(
    `UPDATE tiktok_influencer_email_events
     SET influencer_id = ?, status = 'pending', error_message = NULL, updated_at = NOW()
     WHERE id = ?`,
    [influencerId, q.email_event_id]
  );

  // 对话消息同步归属（含历史上 NULL 重复行）
  const evRows = await queryTikTok(
    `SELECT message_id FROM tiktok_influencer_email_events WHERE id = ? LIMIT 1`,
    [q.email_event_id]
  );
  const messageId = evRows && evRows[0] ? evRows[0].message_id : null;
  if (messageId) {
    await queryTikTok(
      `UPDATE tiktok_influencer_conversation_messages cm
       JOIN (
         SELECT MIN(id) AS mid
         FROM tiktok_influencer_conversation_messages
         WHERE message_id = ? AND influencer_id IS NULL
       ) keep ON keep.mid = cm.id
       SET cm.influencer_id = ?`,
      [messageId, influencerId]
    );
  }
  return { ok: true };
}

export async function ignoreAttributionQueueItem(id) {
  await queryTikTok(
    `UPDATE tiktok_influencer_email_attribution_queue
     SET status = 'ignored', updated_at = NOW()
     WHERE id = ? AND status = 'pending'`,
    [id]
  );
  return { ok: true };
}
