/**
 * 将 tiktok_campaign 记录格式化为执行阶段工作笔记「1、Campaign信息」展示字段。
 */

import { parseCampaignPlatforms } from "../influencer/resolve-campaign-platforms.js";
import { formatInfluencerPricingLabel } from "./influencer-pricing.js";
import { formatDeliverablesLabel } from "./deliverables.js";

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
    productLink: pickText(pi.productLink),
    brand: pickText(pi.brandName, pi.brand) || "未知",
    product: pickText(pi.productName, pi.product) || "未知",
    platform: formatPlatform(ci.platform),
    region: formatRegion(ci.region),
    publishTimeRange: pickText(ci.publishTimeRange),
    totalBudget: formatBudget(ci.budget),
    commission: formatCommission(ci.commission),
    pricingStrategy: formatInfluencerPricingLabel(ci.influencerPricing),
    deliverables: formatDeliverablesLabel(ci.deliverables),
    followerRange: pickText(ip.followerRange),
    viewRange: pickText(ip.viewRange),
    accountType: pickText(ip.accountType),
  };
}

function displayOrUnset(value) {
  if (value == null) return "未设置";
  const s = String(value).trim();
  return s || "未设置";
}

/**
 * 执行阶段 Agent 用配置快照（与工作笔记同源，中文键值）。
 * @param {{
 *   campaign: object,
 *   reportConfig?: object|null,
 *   statusLabel?: string|null,
 * }} input
 * @returns {string}
 */
export function buildCampaignAgentSnapshotHint({ campaign, reportConfig, statusLabel }) {
  const summary = buildCampaignWorkNotesSummary(campaign);
  if (!summary) return "";

  const rc = reportConfig || {};
  const intervalHours =
    typeof rc.intervalHours === "number" && Number.isFinite(rc.intervalHours)
      ? rc.intervalHours
      : 24;
  const reportTime = rc.reportTime || "09:00";
  const keywordStrategy =
    typeof campaign.keywordStrategy === "string" && campaign.keywordStrategy.trim()
      ? campaign.keywordStrategy.trim()
      : null;

  const lines = [
    "【当前 Campaign 配置快照（与工作笔记一致，以数据库为准）】",
    `产品链接：${displayOrUnset(summary.productLink)}`,
    `品牌：${summary.brand}`,
    `产品：${summary.product}`,
    `投放平台：${displayOrUnset(summary.platform)}`,
    `投放地区：${displayOrUnset(summary.region)}`,
    `发布时间段：${displayOrUnset(summary.publishTimeRange)}`,
    `总预算：${displayOrUnset(summary.totalBudget)}`,
    `佣金：${displayOrUnset(summary.commission)}`,
    `单位红人报价策略：${displayOrUnset(summary.pricingStrategy)}`,
    `交付结果：${displayOrUnset(summary.deliverables)}`,
    `红人粉丝量要求：${displayOrUnset(summary.followerRange)}`,
    `红人播放量要求：${displayOrUnset(summary.viewRange)}`,
    `红人帐号类型要求：${displayOrUnset(summary.accountType)}`,
    "—— 执行要求 ——",
    `Campaign 状态：${displayOrUnset(statusLabel)}`,
    `执行节奏：每天联系 ${campaign.influencersPerDay ?? "未设置"} 位红人`,
    `汇报：每 ${intervalHours} 小时，时间 ${reportTime}`,
    `关键词策略：${displayOrUnset(keywordStrategy)}`,
  ];

  return lines.join("\n");
}
