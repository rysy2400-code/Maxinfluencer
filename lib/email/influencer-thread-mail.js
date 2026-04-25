/**
 * Bin → 红人 邮件统一线程策略：
 * - 发件人：历史最早一封 bin/email 的 from_email → op_contacts；无历史则随机，此后固定。
 * - 标题：规范化 canonical（Binfluencer x …），非首封使用 Re: <canonical>，不抄「最近 subject」。
 * - In-Reply-To：优先 preferredInReplyToMessageId（如当前处理的红人来信）；否则用对话中最近一条带 message_id 的记录。
 * - References：根 Message-ID + 父 Message-ID（若不同）。
 */

import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  getOutboundAccountByEmail,
  pickRandomOutboundAccount,
} from "./enterprise-mail-client.js";

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
  const influencerId = opts.influencerId;
  const inf = opts.influencer || null;
  const preferredInReplyTo = opts.preferredInReplyToMessageId || null;

  const canonicalBase = buildCanonicalThreadSubject({
    displayName: inf?.displayName,
    username: inf?.username,
  });

  const earliest = await fetchEarliestBinEmailRow(influencerId);
  const latest = await fetchLatestMessageWithId(influencerId);

  let fromAccount = null;
  if (earliest?.from_email) {
    fromAccount = await getOutboundAccountByEmail(earliest.from_email);
  }
  const usedRandomSender = !fromAccount;
  if (!fromAccount) {
    fromAccount = await pickRandomOutboundAccount();
  }
  if (!fromAccount) {
    throw new Error(
      "[InfluencerThreadMail] 没有可用企业邮箱账号（op_contacts 为空或不可用）"
    );
  }

  const hasPriorConversation = !!(earliest || latest);
  let subjectForSend = canonicalBase;
  if (hasPriorConversation) {
    subjectForSend = /^Re:\s*/i.test(canonicalBase)
      ? canonicalBase
      : `Re: ${canonicalBase}`;
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

  return {
    fromAccount,
    canonicalBase,
    subjectForSend,
    inReplyTo,
    references,
    rootMessageId: rootRaw || null,
    parentMessageId: parentRaw || null,
    usedRandomSender,
  };
}
