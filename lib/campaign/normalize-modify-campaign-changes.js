/**
 * modify_campaign：对 LLM 结构化 changes 做确定性归一化（非自然语言正则解析）。
 */

import { parseCampaignPlatforms } from "../influencer/resolve-campaign-platforms.js";
import {
  normalizeRegionToZhLabels,
  isRecognizedCountryRegion,
} from "../influencer/campaign-country-codes.js";
import { PRICING_MODE_ECPM_WITH_CAP } from "./influencer-pricing.js";
import { normalizeDeliverablesText } from "./deliverables.js";

/**
 * @param {string|number|undefined|null} token
 * @returns {number|null}
 */
export function parseMoneyNumberToken(token) {
  if (token === null || token === undefined || token === "") return null;
  if (typeof token === "number" && Number.isFinite(token)) return token;
  const n = Number(String(token).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function coercePositiveNumber(v) {
  const n = parseMoneyNumberToken(v);
  return n != null && n > 0 ? n : null;
}

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function coerceNonNegativeNumber(v) {
  const n = parseMoneyNumberToken(v);
  return n != null && n >= 0 ? n : null;
}

/**
 * @param {unknown} platform
 * @returns {string|string[]|null}
 */
function normalizePlatformField(platform) {
  if (platform == null || platform === "") return null;
  const parsed = parseCampaignPlatforms(platform);
  if (parsed.length === 0) return null;
  return parsed.length === 1 ? parsed[0] : parsed;
}

/**
 * @param {unknown} region
 * @returns {string|string[]|null}
 */
function normalizeRegionField(region) {
  if (region == null || region === "") return null;
  if (Array.isArray(region)) {
    const zh = normalizeRegionToZhLabels(region.filter(Boolean));
    if (zh.length === 0) return null;
    return zh.length === 1 ? zh[0] : zh;
  }
  const s = String(region).trim();
  if (!s) return null;
  if (isRecognizedCountryRegion(s)) {
    const zh = normalizeRegionToZhLabels(s);
    return zh.length === 1 ? zh[0] : zh.length ? zh : s;
  }
  if (s.includes("、")) {
    const parts = s.split("、").map((p) => p.trim()).filter(Boolean);
    const zh = normalizeRegionToZhLabels(parts);
    return zh.length === 1 ? zh[0] : zh.length ? zh : s;
  }
  return s;
}

/**
 * @param {Record<string, unknown>} ch
 * @returns {{ changes: Record<string, unknown>|null, error: string|null }}
 */
export function normalizeModifyCampaignChanges(ch) {
  if (!ch || typeof ch !== "object" || Array.isArray(ch)) {
    return { changes: null, error: "changes 必须是对象。" };
  }

  const out = { ...ch };

  if (out.budget != null) {
    const budget = coercePositiveNumber(out.budget);
    if (budget == null) {
      return {
        changes: null,
        error: "总预算 budget 必须是大于 0 的数字（美元），请用纯数字如 15450，勿用带逗号字符串。",
      };
    }
    out.budget = budget;
  }

  if (out.commission != null) {
    const commission = coerceNonNegativeNumber(out.commission);
    if (commission == null || commission > 100) {
      return {
        changes: null,
        error: "佣金 commission 必须是 0–100 之间的数字。",
      };
    }
    out.commission = commission;
  }

  if (out.pricingEcpmUsd != null) {
    const ecpm = coercePositiveNumber(out.pricingEcpmUsd);
    if (ecpm == null) {
      return {
        changes: null,
        error: "pricingEcpmUsd 必须是大于 0 的数字。",
      };
    }
    out.pricingEcpmUsd = ecpm;
  }

  if (out.pricingMaxFlatFeeUsd != null) {
    const cap = coercePositiveNumber(out.pricingMaxFlatFeeUsd);
    if (cap == null) {
      return {
        changes: null,
        error: "pricingMaxFlatFeeUsd 必须是大于 0 的数字。",
      };
    }
    out.pricingMaxFlatFeeUsd = cap;
  }

  if (out.influencerPricing != null && typeof out.influencerPricing === "object") {
    const ip = { ...(/** @type {object} */ (out.influencerPricing)) };
    if (ip.ecpmUsd != null) {
      const ecpm = coercePositiveNumber(ip.ecpmUsd);
      if (ecpm == null) {
        return {
          changes: null,
          error: "influencerPricing.ecpmUsd 必须是大于 0 的数字。",
        };
      }
      ip.ecpmUsd = ecpm;
    }
    if (ip.maxFlatFeeUsd != null) {
      const cap = coercePositiveNumber(ip.maxFlatFeeUsd);
      if (cap == null) {
        return {
          changes: null,
          error: "influencerPricing.maxFlatFeeUsd 必须是大于 0 的数字。",
        };
      }
      ip.maxFlatFeeUsd = cap;
    }
    out.influencerPricing = ip;
  }

  if (out.platform != null) {
    const platform = normalizePlatformField(out.platform);
    if (!platform) {
      return {
        changes: null,
        error:
          '投放平台 platform 须为 "TikTok" / "Instagram" / "YouTube" / "X" 或其一数组。',
      };
    }
    out.platform = platform;
  }

  if (out.region != null) {
    const region = normalizeRegionField(out.region);
    if (!region) {
      return {
        changes: null,
        error: "投放地区 region 无效或无法识别。",
      };
    }
    out.region = region;
  }

  if (out.publishTimeRange != null) {
    out.publishTimeRange = String(out.publishTimeRange).trim() || null;
  }

  if (out.brandName != null) {
    out.brandName = String(out.brandName).trim();
  }

  if (out.productName != null) {
    out.productName = String(out.productName).trim();
  }

  if (out.productLink != null) {
    const link = String(out.productLink).trim();
    if (!link || !/^https?:\/\/\S+$/i.test(link)) {
      return {
        changes: null,
        error: "产品链接 productLink 必须是完整的 http(s) URL。",
      };
    }
    out.productLink = link;
  }

  if (out.keywordStrategy !== undefined) {
    out.keywordStrategy = String(out.keywordStrategy ?? "").trim();
  }

  if (out.deliverables != null) {
    out.deliverables = normalizeDeliverablesText(out.deliverables);
    if (!out.deliverables) {
      return {
        changes: null,
        error: "交付结果 deliverables 不能为空或格式无效（勿传空对象）。",
      };
    }
  }

  const normalizeScreeningText = (v) => {
    if (v == null) return null;
    if (typeof v === "string") {
      const s = v.trim();
      return s || null;
    }
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "object") {
      const o = /** @type {Record<string, unknown>} */ (v);
      if (o.min != null && o.max != null) return `${o.min}-${o.max}`;
      if (o.min != null) return `${o.min}以上`;
      if (o.max != null) return `${o.max}以下`;
      if (typeof o.value === "string" && o.value.trim()) return o.value.trim();
    }
    const s = String(v).trim();
    return s && s !== "[object Object]" ? s : null;
  };

  for (const key of ["followerRange", "viewRange", "accountType"]) {
    if (out[key] != null) {
      if (!out.screeningConditions || typeof out.screeningConditions !== "object") {
        out.screeningConditions = {};
      }
      const sc = /** @type {Record<string, unknown>} */ ({ ...out.screeningConditions });
      sc[key] = normalizeScreeningText(out[key]);
      out.screeningConditions = sc;
      delete out[key];
    }
  }

  if (out.screeningConditions != null && typeof out.screeningConditions === "object") {
    const sc = { ...(/** @type {Record<string, unknown>} */ (out.screeningConditions)) };
    for (const key of ["followerRange", "viewRange", "accountType"]) {
      if (sc[key] != null) sc[key] = normalizeScreeningText(sc[key]);
    }
    out.screeningConditions = sc;
  }

  if (
    out.pricingEcpmUsd != null &&
    out.pricingMaxFlatFeeUsd != null &&
    out.pricingMaxFlatFeeUsd < out.pricingEcpmUsd &&
    !out.pricingMode &&
    !(out.influencerPricing && typeof out.influencerPricing === "object")
  ) {
    out.pricingMode = PRICING_MODE_ECPM_WITH_CAP;
  }

  return { changes: out, error: null };
}
