/** 发票类型常量 */
export const INVOICE_TYPE_RECHARGE = "recharge";
export const INVOICE_TYPE_MONTHLY_CONSUMPTION = "monthly_consumption";
export const INVOICE_TYPE_INFLUENCER_CAMPAIGN = "influencer_campaign";

/** 发票类型 → 前端展示名 */
export const INVOICE_TYPE_LABELS = {
  [INVOICE_TYPE_RECHARGE]: "充值发票",
  [INVOICE_TYPE_MONTHLY_CONSUMPTION]: "消费发票（按月）",
  [INVOICE_TYPE_INFLUENCER_CAMPAIGN]: "消费发票（按红人）",
};

/** 发票编号前缀 */
export const INVOICE_TYPE_PREFIX = {
  [INVOICE_TYPE_RECHARGE]: "R",
  [INVOICE_TYPE_MONTHLY_CONSUMPTION]: "M",
  [INVOICE_TYPE_INFLUENCER_CAMPAIGN]: "C",
};

/** @param {unknown} type */
export function invoiceTypeLabel(type) {
  const key = String(type || "");
  return INVOICE_TYPE_LABELS[key] || key || "—";
}
