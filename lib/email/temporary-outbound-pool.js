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
  // xinfluencer.cyou 已整域排除（见 EXCLUDED_OUTREACH_DOMAINS），此处不再逐个列邮箱
];

/**
 * 从红人邀约和 IMAP 动态池整体排除的发件域。
 *
 * 2026-11-26 全量核查结论（注册局 RDAP + DoH DNS + SMTP 连通性）：
 * 池内 40 个域名只有 binfluencer.xyz / binfluencerteam.site 真正可用（MX 与 SMTP 587 均通），
 * 其余 38 个域名的 SMTP 主机均无法解析（getaddrinfo ENOTFOUND），继续选号只会持续失败。
 *
 * 分两类（均不可用，整体排除）：
 *
 * A. 已过期（注册局 pending delete / redemption，无法恢复）：
 *    - minfluencer.*（过期 2026-10-20）
 *    - pinfluencer.*（过期 2026-10-24）
 *    - xinfluencer.cyou / .fun / .online（过期 2026-10-07）
 *
 * B. 未过期但被注册商 clientHold（域名面板已过期未续费，注册局 auto renew period
 *    自动续期但暂停解析，DNS 全部 NXDOMAIN；恢复途径只有补缴续费，已决定不续费）：
 *    - ainfluencer.*（面板到期 2026-10-30）
 *    - cinfluencer.*（面板到期 2026-10-24 ~ 2026-10-31）
 *
 * 注：若日后为 B 类补缴续费并恢复解析，需先把对应域名从本名单移除，才会重新进入选号池。
 */
export const EXCLUDED_OUTREACH_DOMAINS = [
  // A. 已过期
  "xinfluencer.fun",
  "xinfluencer.online",
  "xinfluencer.cyou",
  "minfluencer.online",
  "minfluencer.pw",
  "minfluencer.shop",
  "minfluencer.site",
  "minfluencer.space",
  "minfluencer.top",
  "minfluencer.uno",
  "minfluencer.website",
  "pinfluencer.fun",
  "pinfluencer.pw",
  "pinfluencer.shop",
  "pinfluencer.site",
  "pinfluencer.space",
  "pinfluencer.store",
  "pinfluencer.tech",
  "pinfluencer.top",
  "pinfluencer.uno",
  "pinfluencer.website",
  // B. 未过期但 clientHold（注册商挂起，DNS 不可解析）
  "ainfluencer.fun",
  "ainfluencer.pw",
  "ainfluencer.shop",
  "ainfluencer.site",
  "ainfluencer.space",
  "ainfluencer.store",
  "ainfluencer.top",
  "ainfluencer.uno",
  "ainfluencer.website",
  "cinfluencer.fun",
  "cinfluencer.online",
  "cinfluencer.pw",
  "cinfluencer.shop",
  "cinfluencer.site",
  "cinfluencer.space",
  "cinfluencer.top",
  "cinfluencer.website",
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

/**
 * 1 分钟 cron 下每轮 IMAP 轮询账号数。
 * 2026-11-26 排除死域后有效 IMAP 池约 129 个（binfluencer.xyz + binfluencerteam.site），
 * 55/批 => 3 轮约 3 分钟覆盖全部账号。
 */
export const IMAP_POLL_BATCH_SIZE = 55;

const excludedSet = new Set(
  EXCLUDED_OUTREACH_EMAILS.map((e) => e.trim().toLowerCase())
);
const excludedDomainSet = new Set(
  EXCLUDED_OUTREACH_DOMAINS.map((d) => d.trim().toLowerCase())
);

export function normalizePoolEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function isExcludedFromOutreachPool(email) {
  const normalized = normalizePoolEmail(email);
  if (excludedSet.has(normalized)) return true;
  const domain = normalized.includes("@")
    ? normalized.slice(normalized.lastIndexOf("@") + 1)
    : "";
  if (excludedDomainSet.has(domain)) return true;
  // 已退役/不可达的发件域（binfluencer.autos 等）不再进入动态池
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
