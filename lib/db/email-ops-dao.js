import { queryTikTok } from "./mysql-tiktok.js";
import {
  accountHasImapConfig,
  accountHasSmtpConfig,
  accountMatchesTemporaryOutboundPool,
  getOpContactEmail,
  normalizePoolEmail,
} from "../email/temporary-outbound-pool.js";

function mysqlTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function cutoff(hours, now) {
  return mysqlTime(new Date(now.getTime() - hours * 60 * 60 * 1000));
}

function metric(sent, replied) {
  const denominator = Number(sent || 0);
  const numerator = Number(replied || 0);
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function domainOf(email) {
  return String(email || "").split("@")[1] || "未知域名";
}

export async function getEmailOpsSnapshot({ now = new Date() } = {}) {
  const cutoffs = {
    h24: cutoff(24, now),
    h48: cutoff(48, now),
    h72: cutoff(72, now),
    d30: cutoff(24 * 30, now),
  };
  const [contacts, stats, inboundStats] = await Promise.all([
    queryTikTok("SELECT * FROM op_contacts"),
    queryTikTok(
      `SELECT sender_email,
         COUNT(*) AS total_sent,
         SUM(first_reply_at IS NOT NULL AND bounce_at IS NULL) AS total_replied,
         SUM(sent_at >= ?) AS sent_24h,
         SUM(sent_at >= ? AND first_reply_at IS NOT NULL AND bounce_at IS NULL) AS replied_24h,
         SUM(sent_at >= ?) AS sent_48h,
         SUM(sent_at >= ? AND first_reply_at IS NOT NULL AND bounce_at IS NULL) AS replied_48h,
         SUM(sent_at >= ?) AS sent_72h,
         SUM(sent_at >= ? AND first_reply_at IS NOT NULL AND bounce_at IS NULL) AS replied_72h,
         SUM(sent_at >= ?) AS sent_30d,
         SUM(sent_at >= ? AND first_reply_at IS NOT NULL AND bounce_at IS NULL) AS replied_30d,
         SUM(bounce_at IS NOT NULL) AS total_bounced,
         MAX(sent_at) AS last_sent_at,
         MAX(first_reply_at) AS last_reply_at
       FROM email_outreach_delivery_fact GROUP BY sender_email`,
      [cutoffs.h24, cutoffs.h24, cutoffs.h48, cutoffs.h48,
        cutoffs.h72, cutoffs.h72, cutoffs.d30, cutoffs.d30]
    ),
    queryTikTok(
      `SELECT recipient_email,
         SUM(attribution_status = 'unattributed' AND inbound_type = 'reply') AS unattributed_total,
         SUM(attribution_status = 'unattributed' AND inbound_type = 'reply' AND received_at >= ?) AS unattributed_30d,
         MAX(received_at) AS last_inbound_at
       FROM email_inbound_attribution_audit GROUP BY recipient_email`,
      [cutoffs.d30]
    ),
  ]);

  const statsByEmail = new Map((stats || []).map((row) => [normalizePoolEmail(row.sender_email), row]));
  const inboundByEmail = new Map((inboundStats || []).map((row) => [normalizePoolEmail(row.recipient_email), row]));
  const mailboxes = (contacts || []).map((account) => {
    const email = normalizePoolEmail(getOpContactEmail(account));
    const row = statsByEmail.get(email) || {};
    const inbound = inboundByEmail.get(email) || {};
    const total = metric(row.total_sent, row.total_replied);
    return {
      email,
      domain: domainOf(email),
      inOutreachPool: accountMatchesTemporaryOutboundPool(account),
      smtpConfigured: accountHasSmtpConfig(account),
      imapConfigured: accountHasImapConfig(account),
      metrics: {
        hours24: metric(row.sent_24h, row.replied_24h),
        hours48: metric(row.sent_48h, row.replied_48h),
        hours72: metric(row.sent_72h, row.replied_72h),
        days30: metric(row.sent_30d, row.replied_30d),
        historical: total,
        bounce: metric(row.total_sent, row.total_bounced),
      },
      unattributedReplies: Number(inbound.unattributed_total || 0),
      unattributedReplies30d: Number(inbound.unattributed_30d || 0),
      lastSentAt: row.last_sent_at || null,
      lastReplyAt: row.last_reply_at || null,
      lastInboundAt: inbound.last_inbound_at || null,
    };
  });

  const grouped = new Map();
  for (const mailbox of mailboxes) {
    if (!grouped.has(mailbox.domain)) grouped.set(mailbox.domain, []);
    grouped.get(mailbox.domain).push(mailbox);
  }
  const domains = [...grouped.entries()].map(([domain, items]) => ({
    domain,
    mailboxes: items.sort((a, b) => a.email.localeCompare(b.email)),
  })).sort((a, b) => a.domain.localeCompare(b.domain));

  return { snapshotAt: now.toISOString(), timezone: "UTC", domains, mailboxCount: mailboxes.length };
}
