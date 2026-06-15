/**
 * 余额相关业务文案（UI / API / Agent 共用）
 */

/** @param {unknown} amount */
export function formatUsdAmount(amount) {
  const n = amount == null || amount === "" ? 0 : Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe);
  } catch {
    return `$${safe.toFixed(2)}`;
  }
}

/** @param {unknown} required @param {unknown} current */
export function formatInsufficientBalanceMessage(required, current) {
  return `余额不足：需 ${formatUsdAmount(required)}，当前 ${formatUsdAmount(current)}。请联系 Maxin AI 销售`;
}

export const NON_USD_QUOTE_MESSAGE =
  "该报价币种非 USD，无法同意，请联系 Maxin AI 销售";

export const INVALID_QUOTE_MESSAGE = "当前报价无效，无法同意";

export const WRONG_STAGE_MESSAGE = "当前状态不可同意报价";
