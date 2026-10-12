/**
 * Bin → 红人 邮件统一线程策略：
 * - 发件人：历史最早一封 bin/email 的 from_email → op_contacts；无历史则按动态池 + 独立 20–40 分钟冷却选号，此后固定。
 * - 标题：规范化 canonical（Binfluencer x …），非首封使用 Re: <canonical>，不抄「最近 subject」。
 * - In-Reply-To：优先 preferredInReplyToMessageId（如当前处理的红人来信）；否则用对话中最近一条带 message_id 的记录。
 * - References：根 Message-ID + 父 Message-ID（若不同）。
 */

import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  getOutboundAccountByEmail,
  pickOutboundAccountForNewOutreach,
} from "./enterprise-mail-client.js";
import { normalizeCanonicalInfluencerId } from "../influencer/influencer-id-resolver.js";
import { planRetiredSenderMigration } from "./retired-sender-domains.js";

/**
 * 长期品牌信箱：红人一旦回过信，后续我方邮件一律改用这个信箱收发。
 * 它不参与首封冷启动选号（见 COLD_OUTREACH_EXCLUDED_EMAILS）。
 */
export const REPLY_HANDOFF_MAILBOX = "bin@binfluencer.xyz";

/** @param {string|null|undefined} id */
export function normalizeMessageIdForHeader(id) {
  if (id == null || String(id).trim() === "") return null;
  const s = String(id).trim();
  if (s.startsWith("<") && s.endsWith(">")) return s;
  return `<${s.replace(/^<|>$/g, "")}>`;
}

/**
 * 规范化线程标题（与首封邀约一致）
 * @param {{ displayName?: string|null, username?: string|null }} p
 */
export function buildCanonicalThreadSubject(p) {
  const name =
    (p?.displayName && String(p.displayName).trim()) ||
    (p?.username && String(p.username).replace(/^@/, "").trim()) ||
    "Creator";
  return `Binfluencer x ${name} | Social Media Collaboration`;
}

/**
 * 去掉主题里的回复/转发前缀（Re: / Fwd: / 回复: / 转发: 等，可能叠加多层）。
 * 用于续线程时还原「本线程的真正主题」，而不是重新拼一个规范主题——
 * 主题不一致会让 Gmail 等客户端把对话拆成两个会话。
 */
export function stripSubjectPrefixes(subject) {
  return String(subject || "")
    .trim()
    .replace(/^((re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, "")
    .trim();
}

async function fetchEarliestBinEmailRow(influencerId) {
  if (!influencerId) return null;
  const rows = await queryTikTok(
    `
    SELECT
      from_email,
      to_email,
      subject,
      message_id,
      COALESCE(sent_at, created_at) AS t
    FROM tiktok_influencer_conversation_messages
    WHERE
      influencer_id = ?
      AND direction = 'bin'
      AND channel = 'email'
    ORDER BY COALESCE(sent_at, created_at) ASC, id ASC
    LIMIT 1
  `,
    [influencerId]
  );
  return rows?.[0] || null;
}

/** 最近一条带 message_id 的邮件（任意方向），用于续线程 */
async function fetchLatestMessageWithId(influencerId) {
  if (!influencerId) return null;
  const rows = await queryTikTok(
    `
    SELECT
      from_email,
      to_email,
      subject,
      message_id,
      direction,
      COALESCE(sent_at, created_at) AS t
    FROM tiktok_influencer_conversation_messages
    WHERE
      influencer_id = ?
      AND channel = 'email'
      AND message_id IS NOT NULL
      AND TRIM(message_id) <> ''
    ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
    LIMIT 1
  `,
    [influencerId]
  );
  return rows?.[0] || null;
}

/** 该红人是否已经有任意入站邮件（含自动回复/退信）→ 决定线程是否交接到品牌信箱 */
async function fetchHasInboundReply(influencerId) {
  if (!influencerId) return false;
  const rows = await queryTikTok(
    `
    SELECT 1 AS hit
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = ?
      AND direction = 'influencer'
      AND channel = 'email'
    LIMIT 1
  `,
    [influencerId]
  );
  if (rows && rows.length) return true;

  // 兜底：正文为空的回信不会写进对话表（logConversationMessage 要求 bodyText 非空），
  // 但邮件事件表一定有记录。只用对话表判断会漏掉这类红人（实测 513 人受影响）。
  const events = await queryTikTok(
    `
    SELECT 1 AS hit
    FROM tiktok_influencer_email_events
    WHERE influencer_id = ?
    LIMIT 1
  `,
    [influencerId]
  );
  return Boolean(events && events.length);
}

/** 最近一条红人来信（用于取「对方客户端认定的线程主题」） */
async function fetchLatestInboundRow(influencerId) {
  if (!influencerId) return null;
  const rows = await queryTikTok(
    `
    SELECT subject
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = ?
      AND direction = 'influencer'
      AND channel = 'email'
    ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
    LIMIT 1
  `,
    [influencerId]
  );
  return rows?.[0] || null;
}

function rawMessageIdForCompare(id) {
  if (id == null) return "";
  return String(id).replace(/^<|>$/g, "").trim();
}

function buildReferencesHeader(rootRaw, parentRaw) {
  const root = normalizeMessageIdForHeader(rootRaw);
  const parent = normalizeMessageIdForHeader(parentRaw);
  if (!root && !parent) return null;
  const rr = rawMessageIdForCompare(rootRaw);
  const pr = rawMessageIdForCompare(parentRaw);
  if (root && parent && rr && pr && rr !== pr) {
    return `${root} ${parent}`;
  }
  return parent || root || null;
}

/**
 * @param {{
 *   influencerId: string,
 *   influencer: { displayName?: string|null, username?: string|null }|null,
 *   preferredInReplyToMessageId?: string|null,
 *   campaignId?: string|null,
 * }} opts
 * @returns {Promise<{
 *   fromAccount: object,
 *   canonicalBase: string,
 *   subjectForSend: string,
 *   inReplyTo: string|null,
 *   references: string|null,
 *   rootMessageId: string|null,
 *   parentMessageId: string|null,
 *   usedRandomSender: boolean,
 * }>}
 */
export async function resolveInfluencerThreadMailContext(opts) {
  // 发件账号按规范平台 ID 锁定：handle/用户名一律归一化，防止线程 key 不一致导致换发件人
  const influencerId =
    (await normalizeCanonicalInfluencerId(opts.influencerId)) || null;
  const inf = opts.influencer || null;
  const preferredInReplyTo = opts.preferredInReplyToMessageId || null;

  const canonicalBase = buildCanonicalThreadSubject({
    displayName: inf?.displayName,
    username: inf?.username,
  });

  const earliest = await fetchEarliestBinEmailRow(influencerId);
  const latest = await fetchLatestMessageWithId(influencerId);
  const hasInbound = await fetchHasInboundReply(influencerId);
  const latestInbound = hasInbound ? await fetchLatestInboundRow(influencerId) : null;

  let fromAccount = null;
  let senderMigratedFrom = null;
  let handedOffTo = null;

  // 红人已回过信 → 后续一律用长期品牌信箱，避免继续挂在冷号上；
  // 线程仍沿用第一封的 References（见下方 inReplyTo/references）。
  if (hasInbound) {
    fromAccount = await getOutboundAccountByEmail(REPLY_HANDOFF_MAILBOX);
    if (fromAccount) handedOffTo = REPLY_HANDOFF_MAILBOX;
  }

  if (!fromAccount && earliest?.from_email) {
    // 退役域发件人（binfluencer.autos 等）：线程锁定的老发件人已不可达，
    // 按迁移表换成健康域同 persona 邮箱；原地址仍保留在历史消息里。
    const senderPlan = planRetiredSenderMigration(earliest.from_email);
    if (senderPlan.changed) {
      senderMigratedFrom = senderPlan.from;
      console.warn(
        `[InfluencerThreadMail] 线程发件人迁移：${senderPlan.from} -> ${senderPlan.to}（${senderPlan.reason}）`
      );
    }
    fromAccount = await getOutboundAccountByEmail(senderPlan.to);
  }
  const usedRandomSender = !fromAccount;
  if (!fromAccount) {
    fromAccount = await pickOutboundAccountForNewOutreach();
  }
  if (!fromAccount) {
    throw new Error(
      "[InfluencerThreadMail] 没有可用企业邮箱账号（op_contacts 为空或不可用）"
    );
  }

  const hasPriorConversation = !!(earliest || latest);
  let subjectForSend = canonicalBase;
  if (hasPriorConversation) {
    // 续线程必须沿用「本线程的实际主题」：
    // 1) 红人最近一封来信的主题（= 对方客户端认定的会话主题，最可靠）
    // 2) 我方最早一封出站邮件的主题（线程起点）
    // 3) 规范主题兜底
    // 重新拼规范主题会导致主题变化 → Gmail 等客户端把对话拆成两个会话。
    const threadBase =
      stripSubjectPrefixes(latestInbound?.subject) ||
      stripSubjectPrefixes(earliest?.subject) ||
      canonicalBase;
    subjectForSend = `Re: ${threadBase}`;
  }

  const rootRaw = earliest?.message_id || null;

  let parentRaw = null;
  if (preferredInReplyTo && String(preferredInReplyTo).trim()) {
    parentRaw = preferredInReplyTo;
  } else if (latest?.message_id) {
    parentRaw = latest.message_id;
  }

  let inReplyTo = null;
  let references = null;
  if (hasPriorConversation && parentRaw) {
    inReplyTo = normalizeMessageIdForHeader(parentRaw);
    references = buildReferencesHeader(rootRaw || parentRaw, parentRaw);
  }

  const fromEmail = String(
    fromAccount?.email ||
      fromAccount?.email_address ||
      fromAccount?.username ||
      fromAccount?.account ||
      ""
  )
    .trim()
    .toLowerCase();
  // 凡是从冷号发出的邮件都带 Reply-To + Cc 到品牌信箱：
  // - Reply-To 保证红人「回复」时收件人直接是品牌信箱
  // - Cc 让品牌信箱留一份原始邀约副本（同一 Message-ID，幂等）
  const isColdSender = fromEmail !== REPLY_HANDOFF_MAILBOX;

  return {
    fromAccount,
    canonicalBase,
    subjectForSend,
    inReplyTo,
    references,
    rootMessageId: rootRaw || null,
    parentMessageId: parentRaw || null,
    usedRandomSender,
    senderMigratedFrom,
    hasInboundReply: hasInbound,
    handedOffTo,
    /** 是否由冷号发出（调用方可据此判断是否走品牌信箱兜底） */
    isColdSender,
    /**
     * 冷号发信时：用 Reply-To 把红人回信引到品牌信箱。
     *
     * 注意：这里刻意**不设 Cc**。曾经的 Cc 方案有两个问题：
     * 1) bin@ 会堆积大量「我们自己发出的冷邮件」副本，挤占轮询的最近 50 封窗口 → 可能漏掉真实回信；
     * 2) 这些副本的 From 是我方地址、主题却是规范主题，会被主题归属误判成红人回信 → 触发不该发的自动回复。
     * 线程上下文本来就完整存在 tiktok_influencer_conversation_messages 里，无需邮箱副本留档。
     */
    replyTo: isColdSender ? REPLY_HANDOFF_MAILBOX : null,
    cc: null,
  };
}
