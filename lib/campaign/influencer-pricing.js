/**
 * Campaign 单位红人报价策略：默认值、归一化、校验与首封 flat fee 计算。
 */

export const PRICING_MODE_COMMISSION_ONLY = "commission_only";
export const PRICING_MODE_ECPM_WITH_CAP = "ecpm_with_cap";

export const DEFAULT_ECPM_USD = 3;
export const DEFAULT_MAX_FLAT_FEE_USD = 1000;

/** @returns {{ mode: string, ecpmUsd: number, maxFlatFeeUsd: number }} */
export function getDefaultInfluencerPricing() {
  return {
    mode: PRICING_MODE_ECPM_WITH_CAP,
    ecpmUsd: DEFAULT_ECPM_USD,
    maxFlatFeeUsd: DEFAULT_MAX_FLAT_FEE_USD,
  };
}

export function roundToNearest10(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x / 10) * 10;
}

function parsePositiveNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeMode(raw) {
  const s = raw == null ? "" : String(raw).trim().toLowerCase();
  if (
    s === PRICING_MODE_COMMISSION_ONLY ||
    s === "commission" ||
    s === "commission_only" ||
    s === "only_commission" ||
    s === "无固定费用" ||
    s === "仅佣金" ||
    s === "纯佣金" ||
    s === "纯cps"
  ) {
    return PRICING_MODE_COMMISSION_ONLY;
  }
  if (
    s === PRICING_MODE_ECPM_WITH_CAP ||
    s === "ecpm" ||
    s === "ecpm_with_cap" ||
    s === "flat_and_commission"
  ) {
    return PRICING_MODE_ECPM_WITH_CAP;
  }
  return null;
}

/**
 * 合并并归一化报价策略；缺省为 eCPM=$3、上限 $1000。
 * @param {object|null|undefined} raw
 * @param {object|null} [campaignInfo] - 可选，用于读取嵌套或旧字段
 */
export function normalizeInfluencerPricing(raw, campaignInfo = null) {
  const base = getDefaultInfluencerPricing();
  const fromCi = campaignInfo?.influencerPricing;
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : fromCi && typeof fromCi === "object"
        ? fromCi
        : {};

  const mode =
    normalizeMode(src.mode) ??
    normalizeMode(src.pricingMode) ??
    normalizeMode(campaignInfo?.pricingMode) ??
    base.mode;

  const ecpmUsd =
    parsePositiveNumber(src.ecpmUsd) ??
    parsePositiveNumber(src.pricingEcpmUsd) ??
    parsePositiveNumber(campaignInfo?.pricingEcpmUsd) ??
    base.ecpmUsd;

  const maxFlatFeeUsd =
    parsePositiveNumber(src.maxFlatFeeUsd) ??
    parsePositiveNumber(src.pricingMaxFlatFeeUsd) ??
    parsePositiveNumber(campaignInfo?.pricingMaxFlatFeeUsd) ??
    base.maxFlatFeeUsd;

  return {
    mode,
    ecpmUsd: mode === PRICING_MODE_ECPM_WITH_CAP ? ecpmUsd : base.ecpmUsd,
    maxFlatFeeUsd:
      mode === PRICING_MODE_ECPM_WITH_CAP ? maxFlatFeeUsd : base.maxFlatFeeUsd,
  };
}

/**
 * @param {number|null|undefined} avgViews
 * @param {object|null|undefined} pricing
 */
export function computeQuotedFlatFeeUsd(avgViews, pricing) {
  const p = normalizeInfluencerPricing(pricing);
  if (p.mode === PRICING_MODE_COMMISSION_ONLY) return null;
  if (avgViews == null) return null;
  const v = Number(avgViews);
  if (!Number.isFinite(v) || v < 0) return null;
  const raw = (v / 1000) * p.ecpmUsd;
  const rounded = roundToNearest10(raw);
  if (rounded == null) return null;
  return Math.min(rounded, p.maxFlatFeeUsd);
}

/** @param {object|null|undefined} pricing */
export function formatInfluencerPricingLabel(pricing) {
  const p = normalizeInfluencerPricing(pricing);
  if (p.mode === PRICING_MODE_COMMISSION_ONLY) {
    return "无固定费用，仅佣金";
  }
  return `按 eCPM=$${p.ecpmUsd} 给红人报价，最高不超过 $${p.maxFlatFeeUsd.toLocaleString("en-US")}`;
}

/**
 * @param {object|null|undefined} pricing
 * @param {number|null|undefined} commission - 百分比 0–100
 * @returns {{ isValid: boolean, errorMessage?: string }}
 */
export function validateInfluencerPricing(pricing, commission) {
  const p = normalizeInfluencerPricing(pricing);
  const comm =
    commission !== null && commission !== undefined && commission !== ""
      ? Number(commission)
      : null;

  if (p.mode === PRICING_MODE_ECPM_WITH_CAP) {
    if (!Number.isFinite(p.ecpmUsd) || p.ecpmUsd <= 0) {
      return {
        isValid: false,
        errorMessage: "eCPM 必须是大于 0 的数字（美元）。",
      };
    }
    if (!Number.isFinite(p.maxFlatFeeUsd) || p.maxFlatFeeUsd <= 0) {
      return {
        isValid: false,
        errorMessage: "单人固定费上限必须是大于 0 的数字（美元）。",
      };
    }
  }

  if (p.mode === PRICING_MODE_COMMISSION_ONLY) {
    if (comm == null || !Number.isFinite(comm) || comm <= 0) {
      const commHint =
        comm === 0 ? "佣金为 0%" : "佣金未设置";
      return {
        isValid: false,
        errorMessage:
          `当前设置为「无固定费用」且${commHint}，红人邀约将无法提供报酬说明。请二选一调整：\n` +
          `1）设置佣金比例（如 10%、15%）；或\n` +
          `2）改为「按 eCPM 给红人报价」并确认 eCPM 与单人上限（默认 eCPM=$3、最高 $1000）。`,
      };
    }
  }

  return { isValid: true };
}

/** @param {object|null|undefined} campaignInfo */
export function isCampaignInfoComplete(campaignInfo) {
  if (!campaignInfo) return false;
  const required = [
    "platform",
    "region",
    "publishTimeRange",
    "budget",
    "commission",
  ];
  for (const field of required) {
    const val = campaignInfo[field];
    if (
      val === null ||
      val === undefined ||
      (Array.isArray(val) && val.length === 0)
    ) {
      return false;
    }
  }
  const pricing = normalizeInfluencerPricing(campaignInfo.influencerPricing);
  return validateInfluencerPricing(pricing, campaignInfo.commission).isValid;
}

/**
 * 合并 LLM 提取的报价策略与已有值。
 * @param {object|null|undefined} extracted
 * @param {object|null|undefined} existing
 */
export function mergeInfluencerPricingExtracted(extracted, existing) {
  const prev = normalizeInfluencerPricing(existing?.influencerPricing, existing);
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
    return prev;
  }
  const mode = normalizeMode(extracted.mode) ?? prev.mode;
  const ecpmUsd =
    extracted.ecpmUsd !== null && extracted.ecpmUsd !== undefined
      ? parsePositiveNumber(extracted.ecpmUsd) ?? prev.ecpmUsd
      : prev.ecpmUsd;
  const maxFlatFeeUsd =
    extracted.maxFlatFeeUsd !== null && extracted.maxFlatFeeUsd !== undefined
      ? parsePositiveNumber(extracted.maxFlatFeeUsd) ?? prev.maxFlatFeeUsd
      : prev.maxFlatFeeUsd;

  return normalizeInfluencerPricing({ mode, ecpmUsd, maxFlatFeeUsd });
}

/** modify_campaign changes 是否包含报价策略相关字段 */
export function changesIncludeInfluencerPricing(ch) {
  if (!ch || typeof ch !== "object") return false;
  return (
    ch.influencerPricing != null ||
    ch.pricingMode != null ||
    ch.pricingEcpmUsd != null ||
    ch.pricingMaxFlatFeeUsd != null
  );
}

/**
 * 将 modify_campaign changes 合并进 campaign_info.influencerPricing
 * @param {object} nextCampaignInfo
 * @param {object} ch
 */
export function applyInfluencerPricingChanges(nextCampaignInfo, ch) {
  const prev = normalizeInfluencerPricing(nextCampaignInfo.influencerPricing);
  let patch = { ...prev };

  if (ch.influencerPricing && typeof ch.influencerPricing === "object") {
    const ip = ch.influencerPricing;
    if (ip.mode != null) patch.mode = normalizeMode(ip.mode) ?? patch.mode;
    if (ip.ecpmUsd != null) {
      const n = parsePositiveNumber(ip.ecpmUsd);
      if (n != null) patch.ecpmUsd = n;
    }
    if (ip.maxFlatFeeUsd != null) {
      const n = parsePositiveNumber(ip.maxFlatFeeUsd);
      if (n != null) patch.maxFlatFeeUsd = n;
    }
  }
  if (ch.pricingMode != null) {
    patch.mode = normalizeMode(ch.pricingMode) ?? patch.mode;
  }
  if (ch.pricingEcpmUsd != null) {
    const n = parsePositiveNumber(ch.pricingEcpmUsd);
    if (n != null) patch.ecpmUsd = n;
  }
  if (ch.pricingMaxFlatFeeUsd != null) {
    const n = parsePositiveNumber(ch.pricingMaxFlatFeeUsd);
    if (n != null) patch.maxFlatFeeUsd = n;
  }

  nextCampaignInfo.influencerPricing = normalizeInfluencerPricing(patch);
  return nextCampaignInfo.influencerPricing;
}
