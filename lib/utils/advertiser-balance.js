/** 公司账户余额默认币种（tiktok_advertiser.balance_currency 为空时使用） */
export const DEFAULT_BALANCE_CURRENCY = "USD";

/**
 * @param {unknown} amount
 * @param {unknown} currency
 * @returns {{ amount: number, currency: string }}
 */
export function normalizeAdvertiserBalance(amount, currency) {
  const num = amount == null || amount === "" ? 0 : Number(amount);
  const safeAmount = Number.isFinite(num) ? num : 0;
  const cur =
    typeof currency === "string" && currency.trim()
      ? currency.trim().toUpperCase()
      : DEFAULT_BALANCE_CURRENCY;
  return { amount: safeAmount, currency: cur };
}

/**
 * @param {unknown} amount
 * @param {unknown} currency
 * @returns {string}
 */
export function formatAdvertiserBalance(amount, currency) {
  const { amount: safeAmount, currency: cur } = normalizeAdvertiserBalance(amount, currency);
  if (cur === "POINT" || cur === "CREDIT") {
    return `${Math.round(safeAmount).toLocaleString("zh-CN")} 积分`;
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return `$${safeAmount.toFixed(2)}`;
  }
}
