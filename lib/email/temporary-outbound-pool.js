/**
 * 红人邀约发信 / IMAP 轮询动态池：
 * - 凡 op_contacts 中 SMTP/IMAP 配置完整且不在排除列表的邮箱均参与
 * - 排除 billing 专用发件邮箱
 */

/** @type {readonly string[]} */
export const EXCLUDED_OUTREACH_EMAILS = [
  "maxin@binfluencer.online", // billing 发票专用
  // xinfluencer.cyou 域名邮件 DNS 未就绪（imap/smtp ENOTFOUND）
  "annie@xinfluencer.cyou",
  "james@xinfluencer.cyou",
  "maxin@xinfluencer.cyou",
  "mike@xinfluencer.cyou",
  "pika@xinfluencer.cyou",
];

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
  return excludedSet.has(normalizePoolEmail(email));
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
