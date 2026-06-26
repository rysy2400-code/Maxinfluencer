/**
 * Campaign 交付结果（Deliverables）：默认值、归一化与 modify_campaign 支持。
 * 独立于内容脚本（contentScript）；历史 campaign 无字段时展示「未设置」，不自动回填默认。
 */

export const DEFAULT_DELIVERABLES = `1条专属视频
发布前需分享草稿供确认
个人简介链接（保留14天）
广告投放代码（有效期3个月）
原始素材授权（有效期3个月）`;

/** 默认交付结果的英文表述（首封邀约邮件） */
export const DEFAULT_DELIVERABLES_EN =
  "1 dedicated video, draft for approval before posting, bio link in profile kept for 14 days, ad placement code valid for 3 months, and raw footage authorization valid for 3 months";

function normalizeDeliverablesText(raw) {
  if (raw == null) return "";
  return String(raw).trim();
}

function hasDeliverables(raw) {
  return normalizeDeliverablesText(raw).length > 0;
}

function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, "");
}

function isDefaultDeliverablesText(raw) {
  const text = normalizeDeliverablesText(raw);
  if (!text) return false;
  if (text === DEFAULT_DELIVERABLES) return true;
  return collapseWhitespace(text) === collapseWhitespace(DEFAULT_DELIVERABLES);
}

/** @returns {string} */
export function getDefaultDeliverables() {
  return DEFAULT_DELIVERABLES;
}

/**
 * 工作笔记 / 确认清单展示；无值时返回 null（前端显示「未设置」）。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function formatDeliverablesLabel(raw) {
  if (!hasDeliverables(raw)) return null;
  return normalizeDeliverablesText(raw).replace(/\n+/g, "；");
}

/**
 * 首封邀约邮件用的英文交付说明；无配置时返回 null。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function formatDeliverablesForOutreach(raw) {
  if (!hasDeliverables(raw)) return null;
  if (isDefaultDeliverablesText(raw)) return DEFAULT_DELIVERABLES_EN;
  return normalizeDeliverablesText(raw);
}

/**
 * Campaign 信息收集阶段合并 LLM 提取值；用户未提及时使用默认（与报价策略一致）。
 * @param {unknown} extracted
 * @param {object|null|undefined} existing
 * @returns {string}
 */
export function mergeDeliverablesExtracted(extracted, existing) {
  if (extracted != null && String(extracted).trim()) {
    return normalizeDeliverablesText(extracted);
  }
  if (hasDeliverables(existing?.deliverables)) {
    return normalizeDeliverablesText(existing.deliverables);
  }
  return getDefaultDeliverables();
}

/** @param {object|null|undefined} ch */
export function changesIncludeDeliverables(ch) {
  if (!ch || typeof ch !== "object") return false;
  return ch.deliverables != null;
}

/**
 * @param {object} nextCampaignInfo
 * @param {unknown} deliverables
 */
export function applyDeliverablesChange(nextCampaignInfo, deliverables) {
  nextCampaignInfo.deliverables = normalizeDeliverablesText(deliverables);
}
