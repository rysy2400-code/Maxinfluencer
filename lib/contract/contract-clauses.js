/**
 * 合同条款文本的唯一来源。
 * PDF 渲染与「邮件正文生成」都从这里取文本，保证两者永远同源、不会出现两套说法。
 *
 * 固定条款可被协商结果覆盖（sectionOverrides，直接改固定条款本身）；
 * 不冲突的新增内容放 Additional Terms。
 */

export const DEFAULT_PAYMENT_METHODS_TEXT =
  "Zelle, Venmo, PayPal, USDT, or another method agreed by the Parties";

export const DEFAULT_FEE_SUFFIX =
  'for the Deliverables (the "Fee"). The Fee is exclusive of any applicable taxes and exclusive of any platform service fees.';

/**
 * 固定费 + 佣金条款文本（纯佣金 / 纯产品置换合作不能写成「flat fee of 0.00」）。
 * @param {number|null} feeAmount 已谈定的固定费（0 = 明确无固定费，null = 未谈定）
 * @param {number|null} commissionPercent 已谈定的佣金百分比（0 = 无佣金）
 */
export function buildFeeClause({ feeAmount = null, commissionPercent = null, currency = "USD" } = {}) {
  const fee = Number(feeAmount);
  const hasFee = Number.isFinite(fee) && fee > 0;
  const commission = Number(commissionPercent);
  const hasCommission = Number.isFinite(commission) && commission > 0;
  const commissionText = `a commission of ${commission}% on Qualifying Sales generated through the Creator's promotional link`;

  if (hasFee && hasCommission) {
    return `Agency shall pay Creator a one-time flat fee of ${money(
      fee,
      currency
    )} ${DEFAULT_FEE_SUFFIX} In addition, Creator shall receive ${commissionText}.`;
  }
  if (hasFee) {
    return `Agency shall pay Creator a one-time flat fee of ${money(
      fee,
      currency
    )} ${DEFAULT_FEE_SUFFIX}`;
  }
  if (hasCommission) {
    return `This is a commission-only collaboration: no fixed fee is payable for the Deliverables. Creator shall receive ${commissionText}. Any commission is exclusive of any applicable taxes and exclusive of any platform service fees.`;
  }
  return `This is a product-only collaboration: the Product(s) provided to Creator are the sole consideration for the Deliverables. No fixed fee and no commission are payable for the Deliverables.`;
}

export const DEFAULT_PAYMENT_TIMING_TEXT =
  "3.2 Payment Timing. The Fee shall be paid within two (2) weeks after the Deliverables go live (i.e., after the video is published).";

export const DEFAULT_ACCEPTANCE_TEXT =
  "3.3 Acceptance. The brand will review the published content. Acceptance shall be deemed to occur when (a) the brand confirms acceptance, or (b) no objection is raised within fourteen (14) days after the video goes live.";

export const DEFAULT_GENERAL_TEXT =
  "This Agreement sets out the entire agreement between the Parties with respect to the Campaign and supersedes any prior discussions on the same subject. Creator may confirm acceptance of this Agreement by email reply to Agency; a signed copy is not required. Any amendment shall be agreed by the Parties in writing.";

export function money(amount, currency) {
  const n = Number(amount);
  const value = Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "0.00";
  return `${String(currency || "USD").toUpperCase()} ${value}`;
}

function normalizeSectionOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

function normalizeAdditionalTerms(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === "string" ? t : t?.text))
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
}

/**
 * @param {{
 *   deliverablesText?: string|string[]|null,
 *   feeAmount?: number|null,
 *   commissionPercent?: number|null,
 *   currency?: string|null,
 *   paymentMethods?: string[]|null,
 *   sectionOverrides?: Record<string,string>|null,
 *   additionalTerms?: Array<string|{text:string}>|null,
 * }} opts
 */
export function buildContractClauses({
  deliverablesText = null,
  feeAmount = null,
  commissionPercent = null,
  currency = "USD",
  paymentMethods = null,
  sectionOverrides = null,
  additionalTerms = null,
} = {}) {
  const overrides = normalizeSectionOverrides(sectionOverrides);
  const overrideText = (key, fallback) =>
    typeof overrides[key] === "string" && overrides[key].trim() ? overrides[key].trim() : fallback;

  const methods =
    Array.isArray(paymentMethods) && paymentMethods.length
      ? paymentMethods.join(", ")
      : DEFAULT_PAYMENT_METHODS_TEXT;

  const deliverableSource = Array.isArray(deliverablesText)
    ? deliverablesText.map((t) => String(t ?? "").trim()).filter(Boolean).join("\n\n")
    : String(deliverablesText ?? "").trim();

  const terms = normalizeAdditionalTerms(additionalTerms);

  return {
    deliverables: overrideText("deliverables", deliverableSource),
    fee: overrideText(
      "fee",
      buildFeeClause({ feeAmount, commissionPercent, currency })
    ),
    paymentMethod: overrideText(
      "paymentMethod",
      `3.1 Payment Method. Creator shall provide Agency with a payout method (${methods}). Any transaction, transfer, or processing fees charged by the payment provider shall be borne by Creator.`
    ),
    paymentTiming: overrideText("paymentTiming", DEFAULT_PAYMENT_TIMING_TEXT),
    acceptance: overrideText("acceptance", DEFAULT_ACCEPTANCE_TEXT),
    general: overrideText("general", DEFAULT_GENERAL_TEXT),
    additionalTerms: terms,
    sectionOverrideKeys: Object.keys(overrides),
  };
}
