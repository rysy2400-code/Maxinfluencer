// 对存量 influencer_id 为 NULL 的邮件事件重跑多级归属：
//   - 退信 → skipped（不入队列）
//   - 归属成功 → 回填 influencer_id，status=pending 进入正常 LLM 处理，对话消息同步归属
//   - 归属失败 → 入待确认队列，status=skipped
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  buildAttributionMaps,
  enqueueUnattributedEmail,
  isBounceEmail,
  resolveInfluencerIdForInboundEmailMaps,
} from "../lib/influencer/inbound-email-attribution.js";

console.log("加载红人邮箱/名称映射…");
const maps = await buildAttributionMaps();
console.log(`映射就绪：邮箱 ${maps.emailMap.size} 条，名称 ${maps.nameMap.size} 条`);

const rows = await queryTikTok(
  `SELECT id, message_id, from_email, to_email, subject, in_reply_to, body_text, status, error_message, created_at
   FROM tiktok_influencer_email_events
   WHERE influencer_id IS NULL
     AND status <> 'failed'
   ORDER BY created_at ASC`
);
console.log("NULL 事件总数:", rows.length);

let bounce = 0;
let matched = 0;
let queued = 0;
let skippedNoChange = 0;

for (const r of rows) {
  const bounceEmail = isBounceEmail(r.from_email, r.subject);
  if (bounceEmail) {
    bounce += 1;
    if (r.status !== "skipped" || r.error_message !== "bounce_email") {
      await queryTikTok(
        `UPDATE tiktok_influencer_email_events
         SET status = 'skipped', error_message = 'bounce_email', updated_at = NOW()
         WHERE id = ?`,
        [r.id]
      );
    }
    continue;
  }

  const resolved = await resolveInfluencerIdForInboundEmailMaps(
    {
      fromEmail: r.from_email,
      inReplyTo: r.in_reply_to,
      subject: r.subject,
    },
    maps
  );

  if (resolved?.influencerId) {
    matched += 1;
    await queryTikTok(
      `UPDATE tiktok_influencer_email_events
       SET influencer_id = ?, status = 'pending', error_message = NULL, updated_at = NOW()
       WHERE id = ?`,
      [resolved.influencerId, r.id]
    );
    if (r.message_id) {
      await queryTikTok(
        `UPDATE tiktok_influencer_conversation_messages cm
         JOIN (
           SELECT MIN(id) AS mid
           FROM tiktok_influencer_conversation_messages
           WHERE message_id = ? AND influencer_id IS NULL
         ) keep ON keep.mid = cm.id
         SET cm.influencer_id = ?`,
        [r.message_id, resolved.influencerId]
      );
    }
  } else {
    const queuedNow = await enqueueUnattributedEmail({
      eventId: r.id,
      fromEmail: r.from_email,
      toEmail: r.to_email,
      subject: r.subject,
      inReplyTo: r.in_reply_to,
      bodyExcerpt: r.body_text,
      reason: "unresolved_at_backfill",
    });
    if (queuedNow) queued += 1;
    if (r.status !== "skipped" || r.error_message !== "unattributed_email") {
      await queryTikTok(
        `UPDATE tiktok_influencer_email_events
         SET status = 'skipped', error_message = 'unattributed_email', updated_at = NOW()
         WHERE id = ?`,
        [r.id]
      );
    } else {
      skippedNoChange += 1;
    }
  }
}

console.log(
  `退信跳过: ${bounce} | 归属成功回填: ${matched} | 入队: ${queued} | 已跳过无变化: ${skippedNoChange}`
);
process.exit(0);
