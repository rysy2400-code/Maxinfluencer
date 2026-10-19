/**
 * 红人邀约发信 / IMAP 轮询动态池：
 * - 凡 op_contacts 中 SMTP/IMAP 配置完整且不在排除列表的邮箱均参与
 * - 排除 billing 专用发件邮箱
 */

import { isRetiredSenderDomain } from "./retired-sender-domains.js";

/** @type {readonly string[]} */
export const EXCLUDED_OUTREACH_EMAILS = [
  "bin1@binfluencer.xyz", // billing 发票专用（替代 maxin@binfluencer.online）
  "maxin@binfluencer.online", // 原 billing 发票专用；域名已 client hold 退役
  // xinfluencer.cyou 域名邮件 DNS 未就绪（imap/smtp ENOTFOUND）
  "annie@xinfluencer.cyou",
  "james@xinfluencer.cyou",
  "maxin@xinfluencer.cyou",
  "mike@xinfluencer.cyou",
  "pika@xinfluencer.cyou",
];

/**
 * 仅排除「新红人首封冷启动选号」的邮箱。
 *
 * 与 EXCLUDED_OUTREACH_EMAILS 的区别：
 * - EXCLUDED_OUTREACH_EMAILS 同时影响「冷启动选号」和「IMAP 轮询」；
 * - 本名单只影响冷启动选号，这些邮箱仍会被 IMAP 轮询、也仍可用于红人回信后的对话。
 *
 * bin@binfluencer.xyz 是长期品牌信箱：按策略只用于红人已回复后的沟通，
 * 绝不用于发第一封冷邀约。
 */
export const COLD_OUTREACH_EXCLUDED_EMAILS = [
  "bin@binfluencer.xyz",
];

const coldExcludedSet = new Set(
  COLD_OUTREACH_EXCLUDED_EMAILS.map((e) => e.trim().toLowerCase())
);

/** 是否禁止用于「首封冷启动选号」（不影响轮询与线程回复） */
export function isExcludedFromColdOutreach(email) {
  const normalized = normalizePoolEmail(email);
  return coldExcludedSet.has(normalized);
}

/** 1 分钟 cron 下每轮 IMAP 轮询账号数（约 5 轮覆盖 ~274 邮箱） */
export const IMAP_POLL_BATCH_SIZE = 55;

const excludedSet = new Set(
  EXCLUDED_OUTREACH_EMAILS.map((e) => e.trim().toLowerCase())
);

export function normalizePoolEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function isExcludedFromOutreachPool(email) {
  const normalized = normalizePoolEmail(email);
  if (excludedSet.has(normalized)) return true;
  // 已退役/不可达的发件域（binfluencer.autos 等）不再进入动态池
  const domain = normalized.includes("@")
    ? normalized.slice(normalized.lastIndexOf("@") + 1)
    : "";
  return isRetiredSenderDomain(domain);
}

/**
 * @param {object} account - op_contacts 行
 * @returns {string|null} 主邮箱字段
 */
export function getOpContactEmail(account) {
  if (!account) return null;
  return (
    account.email ||
    account.email_address ||
    account.username ||
    account.account ||
    null
  );
}

export function accountHasSmtpConfig(account) {
  const email = getOpContactEmail(account);
  const smtpHost = account?.smtp;
  const smtpPort = Number(account?.smtp_port || 0);
  const password = account?.auth_code;
  return Boolean(email && smtpHost && smtpPort && password);
}

export function accountHasImapConfig(account) {
  const email = getOpContactEmail(account);
  const imapHost = account?.imap;
  const imapPort = Number(account?.imap_port || 0);
  const password = account?.auth_code;
  return Boolean(email && imapHost && imapPort && password);
}

/** 是否在红人邀约/IMAP 动态池内（SMTP 可用且未排除） */
export function accountMatchesTemporaryOutboundPool(account) {
  const email = getOpContactEmail(account);
  if (!email) return false;
  return accountHasSmtpConfig(account) && !isExcludedFromOutreachPool(email);
}

/** 邮箱是否在红人邀约动态池内（不含 SMTP 校验，仅排除列表） */
export function isEmailInTemporaryOutboundPool(email) {
  return !isExcludedFromOutreachPool(email);
}

/**
 * 按邮箱排序后取当前分钟对应批次（配合 1min cron，多轮覆盖全部账号）。
 *
 * @param {object[]} accounts
 * @param {{ batchSize?: number, now?: number }} [opts]
 */
export function selectImapPollBatch(accounts, opts = {}) {
  const batchSize = Math.max(1, opts.batchSize ?? IMAP_POLL_BATCH_SIZE);
  const now = opts.now ?? Date.now();

  const sorted = [...accounts].sort((a, b) => {
    const ea = normalizePoolEmail(getOpContactEmail(a));
    const eb = normalizePoolEmail(getOpContactEmail(b));
    return ea.localeCompare(eb);
  });

  if (!sorted.length) {
    return { batch: [], batchIndex: 0, numBatches: 0, totalAccounts: 0 };
  }

  const numBatches = Math.ceil(sorted.length / batchSize);
  const batchIndex = Math.floor(now / 60000) % numBatches;
  const start = batchIndex * batchSize;

  return {
    batch: sorted.slice(start, start + batchSize),
    batchIndex,
    numBatches,
    totalAccounts: sorted.length,
  };
}
