// 入站邮件多级归属：
//   ① 发件邮箱精确匹配 tiktok_influencer.influencer_email
//   ② in_reply_to 反查我们发出的首封邀约（delivery_fact / conversation email_outbound）→ 收件邮箱精确匹配
//   ③ 主题 “Binfluencer x <名字>” 精确匹配 username / display_name
// 归属失败（且非退信）→ 进入 tiktok_influencer_email_attribution_queue 待人工确认
import { queryTikTok } from "../db/mysql-tiktok.js";

const BOUNCE_FROM_RE = /^(?:MAILER-DAEMON|mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT_RE =
  /failure notice|delivery status notification|undelivered mail|投递失败|回执|退信/i;
const SUBJECT_NAME_CACHE = new Map();
const EMAIL_EXACT_CACHE = new Map();

export function cleanMessageId(value) {
  return String(value || "")
    .trim()
    .replace(/^<|>$/g, "");
}

export function isBounceEmail(fromEmail, subject) {
  const from = String(fromEmail || "");
  const subj = String(subject || "");
  return BOUNCE_FROM_RE.test(from) || BOUNCE_SUBJECT_RE.test(subj);
}

/** ① 发件邮箱精确匹配 */
export async function resolveInfluencerIdByEmailExact(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  if (EMAIL_EXACT_CACHE.has(e)) return EMAIL_EXACT_CACHE.get(e);
  const rows = await queryTikTok(
    `SELECT influencer_id FROM tiktok_influencer
     WHERE influencer_email = ? LIMIT 1`,
    [e]
  );
  const influencerId = rows && rows[0] ? rows[0].influencer_id : null;
  EMAIL_EXACT_CACHE.set(e, influencerId);
  return influencerId;
}

/** ② in_reply_to 反查首封邀约：优先 delivery_fact，其次 conversation email_outbound */
export async function resolveInfluencerIdByInReplyTo(inReplyTo) {
  const irt = cleanMessageId(inReplyTo);
  if (!irt) return null;

  // delivery_fact 直接带 influencer_id
  const factRows = await queryTikTok(
    `SELECT influencer_id FROM email_outreach_delivery_fact
     WHERE outreach_message_id = ? LIMIT 1`,
    [irt]
  );
  if (factRows && factRows[0]?.influencer_id) return factRows[0].influencer_id;

  // conversation 出站记录 → 收件邮箱 → 精确匹配
  const outRows = await queryTikTok(
    `SELECT to_email FROM tiktok_influencer_conversation_messages
     WHERE direction = 'bin' AND message_id = ? LIMIT 1`,
    [irt]
  );
  if (outRows && outRows[0]?.to_email) {
    return resolveInfluencerIdByEmailExact(outRows[0].to_email);
  }
  return null;
}

/** ③ 主题 “Binfluencer x <名字>” 精确匹配 */
export async function resolveInfluencerIdBySubject(subject) {
  const m = String(subject || "").match(/Binfluencer x (.+?) \|/i);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || /^creator$/i.test(name)) return null;
  if (SUBJECT_NAME_CACHE.has(name)) return SUBJECT_NAME_CACHE.get(name);
  const rows = await queryTikTok(
    `SELECT influencer_id FROM tiktok_influencer
     WHERE username = ? OR display_name = ?
     LIMIT 1`,
    [name, name]
  );
  const influencerId = rows && rows[0] ? rows[0].influencer_id : null;
  SUBJECT_NAME_CACHE.set(name, influencerId);
  return influencerId;
}

/**
 * 入站邮件完整归属链，返回 { influencerId, method } 或 null。
 * @param {{ fromEmail?: string, inReplyTo?: string, subject?: string }} opts
 */
export async function resolveInfluencerIdForInboundEmail({
  fromEmail,
  inReplyTo,
  subject,
}) {
  let influencerId = await resolveInfluencerIdByEmailExact(fromEmail);
  if (influencerId) return { influencerId, method: "email_exact" };

  influencerId = await resolveInfluencerIdByInReplyTo(inReplyTo);
  if (influencerId) return { influencerId, method: "in_reply_to" };

  influencerId = await resolveInfluencerIdBySubject(subject);
  if (influencerId) return { influencerId, method: "subject_name" };

  return null;
}

/**
 * 批量场景一次性加载内存映射（避免逐条全表扫描）
 * @returns {Promise<{ emailMap: Map<string,string>, nameMap: Map<string,string> }>}
 */
export async function buildAttributionMaps() {
  const emailRows = await queryTikTok(
    `SELECT influencer_id, influencer_email FROM tiktok_influencer
     WHERE influencer_email IS NOT NULL AND TRIM(influencer_email) <> ''`
  );
  const emailMap = new Map();
  for (const r of emailRows) {
    emailMap.set(String(r.influencer_email).trim().toLowerCase(), r.influencer_id);
  }

  const nameRows = await queryTikTok(
    `SELECT influencer_id, username, display_name FROM tiktok_influencer
     WHERE username IS NOT NULL OR display_name IS NOT NULL`
  );
  const nameMap = new Map();
  for (const r of nameRows) {
    if (r.username) nameMap.set(String(r.username).trim(), r.influencer_id);
    if (r.display_name) nameMap.set(String(r.display_name).trim(), r.influencer_id);
  }
  return { emailMap, nameMap };
}

/** 带内存映射的归属链（第 2 层仍走索引查询） */
export async function resolveInfluencerIdForInboundEmailMaps(
  { fromEmail, inReplyTo, subject },
  maps
) {
  const e = String(fromEmail || "").trim().toLowerCase();
  if (e && maps?.emailMap?.has(e)) {
    return { influencerId: maps.emailMap.get(e), method: "email_exact" };
  }

  const influencerId = await resolveInfluencerIdByInReplyTo(inReplyTo);
  if (influencerId) return { influencerId, method: "in_reply_to" };

  const m = String(subject || "").match(/Binfluencer x (.+?) \|/i);
  if (m && maps?.nameMap) {
    const name = m[1].trim();
    if (name && !/^creator$/i.test(name) && maps.nameMap.has(name)) {
      return { influencerId: maps.nameMap.get(name), method: "subject_name" };
    }
  }
  return null;
}

/** 归属失败入队（幂等，按 email_event_id 唯一） */
export async function enqueueUnattributedEmail({
  eventId,
  fromEmail,
  toEmail,
  subject,
  inReplyTo,
  bodyExcerpt,
  reason = "unresolved",
}) {
  if (!eventId) return false;
  await queryTikTok(
    `INSERT IGNORE INTO tiktok_influencer_email_attribution_queue (
       email_event_id, from_email, to_email, subject, in_reply_to, body_excerpt, reason, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      eventId,
      String(fromEmail || "").slice(0, 255),
      String(toEmail || "").slice(0, 255),
      String(subject || "").slice(0, 512),
      cleanMessageId(inReplyTo) || null,
      String(bodyExcerpt || "").slice(0, 600),
      reason,
    ]
  );
  return true;
}
