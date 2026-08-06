import { queryTikTok } from "../lib/db/mysql-tiktok.js";

console.log("[email-ops] 批量回填首邀事实");
await queryTikTok(
  `INSERT INTO email_outreach_delivery_fact (
     campaign_id, influencer_id, outreach_message_id, sender_email,
     sender_domain, recipient_email, sent_at
   )
   SELECT campaign_id, influencer_id,
     LOWER(REPLACE(REPLACE(TRIM(message_id), '<', ''), '>', '')),
     LOWER(TRIM(from_email)),
     LOWER(SUBSTRING_INDEX(TRIM(from_email), '@', -1)),
     NULLIF(LOWER(TRIM(to_email)), ''),
     COALESCE(sent_at, event_time, created_at)
   FROM (
     SELECT m.*, ROW_NUMBER() OVER (
       PARTITION BY campaign_id, influencer_id
       ORDER BY COALESCE(sent_at, event_time, created_at), id
     ) AS outreach_rn
     FROM tiktok_influencer_conversation_messages m
     WHERE direction = 'bin' AND channel = 'email' AND source_type = 'seed_outreach'
       AND campaign_id IS NOT NULL AND TRIM(campaign_id) <> ''
       AND influencer_id IS NOT NULL AND TRIM(influencer_id) <> ''
       AND message_id IS NOT NULL AND TRIM(message_id) <> ''
       AND from_email IS NOT NULL AND TRIM(from_email) LIKE '%@%'
   ) first_outreach
   WHERE outreach_rn = 1
   ON DUPLICATE KEY UPDATE
     outreach_message_id = VALUES(outreach_message_id),
     sender_email = VALUES(sender_email), sender_domain = VALUES(sender_domain),
     recipient_email = COALESCE(VALUES(recipient_email), email_outreach_delivery_fact.recipient_email),
     sent_at = VALUES(sent_at)`
);

console.log("[email-ops] 批量建立入站审计（历史数据量较大）");
await queryTikTok(
  `UPDATE email_inbound_attribution_audit
   SET attribution_status = 'unattributed', outreach_fact_id = NULL, match_method = NULL`
);
await queryTikTok(
  `INSERT INTO email_inbound_attribution_audit (
     inbound_message_id, recipient_email, sender_email, received_at,
     inbound_type, attribution_status, outreach_fact_id, match_method
   )
   SELECT
     LOWER(REPLACE(REPLACE(TRIM(m.message_id), '<', ''), '>', '')),
     NULLIF(LOWER(TRIM(m.to_email)), ''), NULLIF(LOWER(TRIM(m.from_email)), ''),
     COALESCE(m.sent_at, m.event_time, m.created_at),
     CASE WHEN
       CONCAT_WS('\n', m.from_email, m.subject, m.body_text, e.raw_headers)
       REGEXP 'mailer-daemon|mail-daemon|postmaster|delivery[._-]?status|delivery status notification|delivery failure|undeliverable|undelivered|mail delivery failed|returned mail|failure notice|diagnostic-code:|final-recipient:|recipient address rejected|message could not be delivered|邮件投递失败|退信'
       THEN 'bounce' ELSE 'reply' END,
     'unattributed', NULL, NULL
   FROM tiktok_influencer_conversation_messages m
   LEFT JOIN tiktok_influencer_email_events e ON e.id = m.source_event_id
   WHERE m.direction = 'influencer' AND m.channel = 'email'
     AND m.event_type = 'email_inbound' AND m.message_id IS NOT NULL
     AND TRIM(m.message_id) <> ''
   ON DUPLICATE KEY UPDATE
     recipient_email = VALUES(recipient_email), sender_email = VALUES(sender_email),
     received_at = VALUES(received_at), inbound_type = VALUES(inbound_type),
     attribution_status = 'unattributed', outreach_fact_id = NULL, match_method = NULL`
);

console.log("[email-ops] 按 In-Reply-To 精确归因");
await queryTikTok(
  `UPDATE email_inbound_attribution_audit a
   INNER JOIN tiktok_influencer_conversation_messages m
     ON LOWER(REPLACE(REPLACE(TRIM(m.message_id), '<', ''), '>', '')) = a.inbound_message_id
   INNER JOIN tiktok_influencer_email_events e ON e.id = m.source_event_id
   INNER JOIN email_outreach_delivery_fact f
     ON f.outreach_message_id = LOWER(REPLACE(REPLACE(TRIM(e.in_reply_to), '<', ''), '>', ''))
   SET a.attribution_status = 'matched', a.outreach_fact_id = f.id,
       a.match_method = 'in_reply_to'
   WHERE e.in_reply_to IS NOT NULL AND TRIM(e.in_reply_to) <> ''
     AND f.sent_at <= a.received_at`
);

console.log("[email-ops] 回填每封首邀的首次回复与退信");
await queryTikTok(
  `UPDATE email_outreach_delivery_fact
   SET first_reply_message_id = NULL, first_reply_at = NULL,
       bounce_message_id = NULL, bounce_at = NULL,
       match_method = NULL, match_confidence = NULL`
);
await queryTikTok(
  `UPDATE email_outreach_delivery_fact f
   INNER JOIN (
     SELECT outreach_fact_id, MIN(received_at) AS first_at
     FROM email_inbound_attribution_audit
     WHERE attribution_status = 'matched' AND inbound_type = 'reply'
     GROUP BY outreach_fact_id
   ) x ON x.outreach_fact_id = f.id
   INNER JOIN email_inbound_attribution_audit a
     ON a.outreach_fact_id = f.id AND a.received_at = x.first_at AND a.inbound_type = 'reply'
   SET f.first_reply_at = x.first_at,
       f.first_reply_message_id = a.inbound_message_id,
       f.match_method = 'in_reply_to', f.match_confidence = 'exact'`
);
await queryTikTok(
  `UPDATE email_outreach_delivery_fact f
   INNER JOIN (
     SELECT outreach_fact_id, MIN(received_at) AS first_at
     FROM email_inbound_attribution_audit
     WHERE attribution_status = 'matched' AND inbound_type = 'bounce'
     GROUP BY outreach_fact_id
   ) x ON x.outreach_fact_id = f.id
   INNER JOIN email_inbound_attribution_audit a
     ON a.outreach_fact_id = f.id AND a.received_at = x.first_at AND a.inbound_type = 'bounce'
   SET f.bounce_at = x.first_at, f.bounce_message_id = a.inbound_message_id,
       f.match_method = 'in_reply_to', f.match_confidence = 'exact'`
);

const [facts] = await queryTikTok("SELECT COUNT(*) AS count FROM email_outreach_delivery_fact");
const audit = await queryTikTok(
  `SELECT attribution_status, inbound_type, COUNT(*) AS count
   FROM email_inbound_attribution_audit GROUP BY attribution_status, inbound_type`
);
console.log(JSON.stringify({ outreachFacts: Number(facts.count), audit }, null, 2));
process.exit(0);
