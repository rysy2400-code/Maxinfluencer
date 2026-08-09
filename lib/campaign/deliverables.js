/**
 * Campaign 交付结果（Deliverables）：默认值、归一化与 modify_campaign 支持。
 * 独立于内容脚本（contentScript）；历史 campaign 无字段时展示「未设置」，不自动回填默认。
 */

import { parseCampaignPlatforms } from "../influencer/resolve-campaign-platforms.js";

export const DEFAULT_DELIVERABLES = `1条专属视频
发布前需分享草稿供确认
个人简介链接（保留14天）
广告投放代码（有效期3个月）
原始素材授权（有效期3个月）`;

/** 默认交付结果的英文表述（首封邀约邮件） */
export const DEFAULT_DELIVERABLES_EN =
  "1 dedicated video, draft for approval before posting, bio link in profile kept for 14 days, ad placement code valid for 3 months, and raw footage authorization valid for 3 months";

const PLATFORM_DISPLAY_ORDER = ["YouTube", "TikTok", "Instagram", "X"];
const INVALID_OBJECT_STRING = "[object Object]";

function isInvalidDeliverablesString(s) {
  const t = String(s ?? "").trim();
  return !t || t === INVALID_OBJECT_STRING;
}

function normalizePlatformLabel(key) {
  const parsed = parseCampaignPlatforms(key);
  if (parsed.length === 1) return parsed[0];
  const s = String(key ?? "").trim();
  return s || "未知平台";
}

/** 平台内条目：换行/分号统一为中文分号 */
function collapseDeliverablesBody(text) {
  return String(text ?? "")
    .trim()
    .replace(/[;；]\s*/g, "；")
    .replace(/\n+/g, "；")
    .replace(/；+/g, "；")
    .replace(/^；|；$/g, "");
}

function formatPlatformDeliverablesLine(platform, text) {
  const body = collapseDeliverablesBody(text);
  if (!body) return "";
  return `${normalizePlatformLabel(platform)}：${body}`;
}

function serializeDeliverablesArray(arr) {
  const lines = [];
  for (const item of arr) {
    if (item == null) continue;
    if (typeof item === "string") {
      const body = collapseDeliverablesBody(item);
      if (body) lines.push(body);
      continue;
    }
    if (typeof item === "object" && !Array.isArray(item)) {
      const o = /** @type {Record<string, unknown>} */ (item);
      const platform =
        o.platform ?? o.name ?? o.label ?? o.key ?? null;
      const text =
        o.text ??
        o.content ??
        o.deliverables ??
        o.value ??
        o.description ??
        null;
      if (platform != null && text != null) {
        const line = formatPlatformDeliverablesLine(platform, text);
        if (line) lines.push(line);
      } else {
        const nested = normalizeDeliverablesText(item);
        if (nested) lines.push(nested);
      }
    }
  }
  return lines.join("\n");
}

function serializeDeliverablesObject(obj) {
  const entries = Object.entries(obj).filter(
    ([, v]) => v != null && String(v).trim() !== ""
  );
  if (entries.length === 0) return "";

  const sorted = entries.sort(([a], [b]) => {
    const la = normalizePlatformLabel(a);
    const lb = normalizePlatformLabel(b);
    const ia = PLATFORM_DISPLAY_ORDER.indexOf(la);
    const ib = PLATFORM_DISPLAY_ORDER.indexOf(lb);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return la.localeCompare(lb, "zh-CN");
  });

  const lines = [];
  for (const [key, value] of sorted) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      const nested = serializeDeliverablesObject(
        /** @type {Record<string, unknown>} */ (value)
      );
      if (nested) lines.push(nested);
      continue;
    }
    const line = formatPlatformDeliverablesLine(key, value);
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * 落库用 canonical 纯文本；多平台时按「平台：条目；条目」分行存储。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDeliverablesText(raw) {
  if (raw == null) return "";

  if (typeof raw === "string") {
    if (isInvalidDeliverablesString(raw)) return "";
    return raw.trim();
  }

  if (Array.isArray(raw)) {
    return serializeDeliverablesArray(raw).trim();
  }

  if (typeof raw === "object") {
    return serializeDeliverablesObject(
      /** @type {Record<string, unknown>} */ (raw)
    ).trim();
  }

  const s = String(raw).trim();
  return isInvalidDeliverablesString(s) ? "" : s;
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
 * 多平台交付结果保留按平台换行（配合前端 pre-wrap）。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function formatDeliverablesLabel(raw) {
  const normalized = normalizeDeliverablesText(raw);
  if (!normalized) return null;
  return normalized;
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
  const fromExtracted = normalizeDeliverablesText(extracted);
  if (fromExtracted) return fromExtracted;
  const fromExisting = normalizeDeliverablesText(existing?.deliverables);
  if (fromExisting) return fromExisting;
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
