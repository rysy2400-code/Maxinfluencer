/**
 * 临时策略：随机发信 / IMAP 轮询仅考虑以下邮箱（仍从 op_contacts 读 SMTP/IMAP 与授权码）。
 * 若某邮箱未在 op_contacts 中配置完整 SMTP/IMAP，则不会参与随机或轮询。
 * （曾包含 system@binfluencer.online；未配 op_contacts+IMAP 时已从白名单移除，避免与实库不一致。）
 */
export const TEMP_OUTBOUND_EMAIL_POOL = [
  "annie@binfluencer.online",
  "annie@cinfluencer.pw",
  "annie@pinfluencer.website",
  "maxin@pinfluencer.store",
  "mike@ainfluencer.uno",
  "mike@xinfluencer.website",
];

const poolSet = new Set(
  TEMP_OUTBOUND_EMAIL_POOL.map((e) => e.trim().toLowerCase())
);

export function normalizePoolEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function isEmailInTemporaryOutboundPool(email) {
  return poolSet.has(normalizePoolEmail(email));
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

export function accountMatchesTemporaryOutboundPool(account) {
  const e = getOpContactEmail(account);
  return e ? isEmailInTemporaryOutboundPool(e) : false;
}
