/**
 * 从执行阶段用户自然语言中解析 modify_campaign.changes（LLM 漏填时的规则兜底）。
 */

import { PRICING_MODE_COMMISSION_ONLY, PRICING_MODE_ECPM_WITH_CAP } from "./influencer-pricing.js";

/**
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
export function parsePricingChangesFromUserMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const mentionsPricing =
    /单位红人报价策略|报价策略|红人报价|固定费|无固定|只要佣金|纯佣金|纯cps|ecpm|e\s*cpm/i.test(
      raw
    );
  if (!mentionsPricing) return null;

  const changes = {};

  if (/无固定|只要佣金|纯佣金|纯cps|commission\s*only|仅佣金/i.test(raw)) {
    changes.pricingMode = PRICING_MODE_COMMISSION_ONLY;
  }

  const ecpmMatch = raw.match(/ecpm\s*[=为：:]?\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (ecpmMatch) {
    changes.pricingEcpmUsd = Number(ecpmMatch[1]);
    if (!changes.pricingMode) changes.pricingMode = PRICING_MODE_ECPM_WITH_CAP;
  }

  const capMatch =
    raw.match(/最高(?:不超过)?\s*[$¥]?\s*(\d+(?:\.\d+)?)/i) ||
    raw.match(/上限\s*[$¥]?\s*(\d+(?:\.\d+)?)/i);
  if (capMatch) {
    changes.pricingMaxFlatFeeUsd = Number(capMatch[1]);
    if (!changes.pricingMode) changes.pricingMode = PRICING_MODE_ECPM_WITH_CAP;
  }

  if (/按\s*ecpm|ecpm/i.test(raw) && !changes.pricingMode) {
    changes.pricingMode = PRICING_MODE_ECPM_WITH_CAP;
  }

  if (Object.keys(changes).length === 0 && /无固定|只要佣金/.test(raw)) {
    changes.pricingMode = PRICING_MODE_COMMISSION_ONLY;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
export function parseModifyCampaignChangesFromUserMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  /** @type {Record<string, unknown>} */
  const changes = {};

  const pricing = parsePricingChangesFromUserMessage(raw);
  if (pricing) Object.assign(changes, pricing);

  const commMatch = raw.match(/佣金[：:为]?\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (commMatch) changes.commission = Number(commMatch[1]);

  const budgetMatch = raw.match(
    /(?:总预算|预算)[：:为]?\s*\$?\s*(\d+(?:\.\d+)?)/i
  );
  if (budgetMatch) changes.budget = Number(budgetMatch[1]);

  const timeMatch = raw.match(
    /(?:发布时间段|发布时间)[：:为]?\s*([^\n]+?)(?=$|，|,|；|;)/
  );
  if (timeMatch) changes.publishTimeRange = timeMatch[1].trim();

  if (/投放平台[：:为]/i.test(raw)) {
    const platforms = [];
    if (/youtube|ytb/i.test(raw)) platforms.push("YouTube");
    if (/instagram|ins/i.test(raw)) platforms.push("Instagram");
    if (/tiktok|tk/i.test(raw)) platforms.push("TikTok");
    if (platforms.length) changes.platform = platforms;
  }

  if (/投放地区[：:为]/i.test(raw)) {
    const regionMatch = raw.match(/投放地区[：:为]?\s*([^\n]+?)(?=$|，|,|；|;)/i);
    if (regionMatch) {
      const part = regionMatch[1].trim();
      changes.region = part.includes("、") ? part.split("、").map((s) => s.trim()) : part;
    }
  }

  const brandMatch = raw.match(/品牌[：:为]?\s*([^\n]+?)(?=$|，|,|；|;)/i);
  if (brandMatch) changes.brandName = brandMatch[1].trim();

  const productMatch = raw.match(/产品[：:为]?\s*([^\n]+?)(?=$|，|,|；|;)/i);
  if (productMatch) changes.productName = productMatch[1].trim();

  return Object.keys(changes).length > 0 ? changes : null;
}

/** 是否像在执行阶段修改 campaign 配置（用于强制走 modify_campaign） */
export function userMessageImpliesModifyCampaign(text) {
  return parseModifyCampaignChangesFromUserMessage(text) != null;
}
