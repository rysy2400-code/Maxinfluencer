/**
 * 将 tiktok_campaign 记录格式化为执行阶段工作笔记「1、Campaign信息」展示字段。
 */

import { parseCampaignPlatforms } from "../influencer/resolve-campaign-platforms.js";
import { formatInfluencerPricingLabel } from "./influencer-pricing.js";

function formatPlatform(platform) {
  if (platform == null || platform === "") return null;
  const normalized = parseCampaignPlatforms(platform);
  return normalized.length > 0 ? normalized.join("、") : null;
}

function formatRegion(region) {
  if (region == null || region === "") return null;
  if (Array.isArray(region)) {
    const parts = region.filter(Boolean).map(String);
    return parts.length > 0 ? parts.join("、") : null;
  }
  return String(region);
}

function formatBudget(budget) {
  if (budget == null || budget === "" || Number.isNaN(Number(budget))) return null;
  const n = Number(budget);
  return `$${n.toLocaleString("en-US")} USD`;
}

function formatCommission(commission) {
  if (commission == null || commission === "" || Number.isNaN(Number(commission))) {
    return null;
  }
  return `${Number(commission)}%`;
}

function pickText(...candidates) {
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return null;
}

/** @param {object|null|undefined} campaign */
export function buildCampaignWorkNotesSummary(campaign) {
  if (!campaign) return null;

  const pi = campaign.productInfo || {};
  const ci = campaign.campaignInfo || {};
  const ip = campaign.influencerProfile || {};

  return {
    brand: pickText(pi.brandName, pi.brand) || "未知",
    product: pickText(pi.productName, pi.product) || "未知",
    platform: formatPlatform(ci.platform),
    region: formatRegion(ci.region),
    publishTimeRange: pickText(ci.publishTimeRange),
    totalBudget: formatBudget(ci.budget),
    commission: formatCommission(ci.commission),
    pricingStrategy: formatInfluencerPricingLabel(ci.influencerPricing),
    followerRange: pickText(ip.followerRange),
    viewRange: pickText(ip.viewRange),
    accountType: pickText(ip.accountType),
  };
}
