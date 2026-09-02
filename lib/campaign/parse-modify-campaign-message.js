/**
 * @deprecated 执行阶段 modify_campaign 已改为 LLM 结构化 changes + normalizeModifyCampaignChanges。
 * 本模块仅保留供历史测试；生产路径请勿再用于从用户自然语言解析 changes。
 */

import {
  PRICING_MODE_ASK_CREATOR_QUOTE,
  PRICING_MODE_COMMISSION_ONLY,
  PRICING_MODE_ECPM_WITH_CAP,
} from "./influencer-pricing.js";
import { parseMoneyNumberToken } from "./normalize-modify-campaign-changes.js";

export { parseMoneyNumberToken };

/** 金额数字（支持千位逗号，如 1,000 / 15,450.50） */
const MONEY_NUMBER = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";

/**
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
export function parsePricingChangesFromUserMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const mentionsPricing =
    /单位红人报价策略|报价策略|红人报价|固定费|无固定|只要佣金|纯佣金|纯cps|纯产品置换|产品置换|置换|ecpm|e\s*cpm/i.test(
      raw
    );
  if (!mentionsPricing) return null;

  const changes = {};

  if (
    /不主动报价|不报价|询问红人报价|询问红人价格|询问红人合作价格|询问博主报价|询问博主价格|让红人报价|让博主报价|让红人提供报价|让博主提供报价|请红人报价|请博主报价|请红人提供报价|请博主提供报价|由红人报价|红人提供报价|红人自己报价|ask\s*creator\s*quote|ask\s*influencer\s*quote|询价|不要按\s*ecpm|别按\s*ecpm|不按\s*ecpm|不用\s*ecpm|不要用\s*ecpm/i.test(
      raw
    )
  ) {
    changes.pricingMode = PRICING_MODE_ASK_CREATOR_QUOTE;
  }

  if (/无固定|只要佣金|纯佣金|纯cps|纯产品置换|产品置换|置换|commission\s*only|仅佣金/i.test(raw)) {
    changes.pricingMode = PRICING_MODE_COMMISSION_ONLY;
  }

  const ecpmMatch = raw.match(
    new RegExp(`ecpm\\s*[=为：:]?\\s*[$¥]?\\s*(${MONEY_NUMBER})`, "i")
  );
  if (ecpmMatch) {
    const ecpm = parseMoneyNumberToken(ecpmMatch[1]);
    if (ecpm != null) {
      changes.pricingEcpmUsd = ecpm;
      if (!changes.pricingMode) changes.pricingMode = PRICING_MODE_ECPM_WITH_CAP;
    }
  }

  const capMatch =
    raw.match(new RegExp(`最高(?:不超过)?\\s*[$¥]?\\s*(${MONEY_NUMBER})`, "i")) ||
    raw.match(new RegExp(`上限\\s*[$¥]?\\s*(${MONEY_NUMBER})`, "i"));
  if (capMatch) {
    const cap = parseMoneyNumberToken(capMatch[1]);
    if (cap != null) {
      changes.pricingMaxFlatFeeUsd = cap;
      if (!changes.pricingMode) changes.pricingMode = PRICING_MODE_ECPM_WITH_CAP;
    }
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

  const commMatch = raw.match(
    new RegExp(`佣金[：:为]?\\s*(${MONEY_NUMBER})\\s*%?`, "i")
  );
  if (commMatch) {
    const commission = parseMoneyNumberToken(commMatch[1]);
    if (commission != null) changes.commission = commission;
  } else if (/纯产品置换|产品置换/.test(raw)) {
    changes.commission = 0;
  }

  const budgetMatch = raw.match(
    new RegExp(`(?:总预算|预算)[：:为]?\\s*[$¥]?\\s*(${MONEY_NUMBER})`, "i")
  );
  if (budgetMatch) {
    const budget = parseMoneyNumberToken(budgetMatch[1]);
    if (budget != null) changes.budget = budget;
  }

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
