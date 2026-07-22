/**
 * 报价时间线的业务解析：广告主还价不是红人的有效报价。
 * 该模块保持无数据库依赖，供 UI、预检和正式扣款共用。
 */
export function parseQuoteNegotiation(value) {
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === "object") : [];
  } catch {
    return [];
  }
}

/** 返回最近一条红人报价；广告主 counter 不会改变有效报价。 */
export function resolveLatestInfluencerQuote({ quoteNegotiation, fallbackAmount, fallbackCurrency } = {}) {
  const history = parseQuoteNegotiation(quoteNegotiation);
  const influencerQuotes = history.filter(
    (entry) => entry.role === "influencer" && entry.amount != null && Number.isFinite(Number(entry.amount))
  );
  const latest = influencerQuotes[influencerQuotes.length - 1] || null;
  if (latest) {
    return {
      amount: Number(latest.amount),
      currency: String(latest.currency || fallbackCurrency || "USD").toUpperCase(),
      entry: latest,
    };
  }
  const fallback = fallbackAmount != null && Number.isFinite(Number(fallbackAmount))
    ? Number(fallbackAmount)
    : null;
  return fallback == null
    ? null
    : { amount: fallback, currency: String(fallbackCurrency || "USD").toUpperCase(), entry: null };
}

export function resolveLatestInfluencerQuoteFromRow(row) {
  return resolveLatestInfluencerQuote({
    quoteNegotiation: row?.quote_negotiation ?? row?.quoteNegotiation,
    fallbackAmount: row?.flat_fee ?? row?.flatFeeUsd,
    fallbackCurrency: row?.currency,
  });
}
