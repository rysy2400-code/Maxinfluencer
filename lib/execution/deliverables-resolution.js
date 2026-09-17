/**
 * 红人级「最新交付结果」解析。
 *
 * 口径与「最新报价」完全一致：交付结果存放在 tiktok_campaign_execution.quote_negotiation
 * 条目的 deliverables 字段上，取其最近一条带 deliverables 的记录。
 * 该模块不依赖数据库，供卡片展示、审批快照与合同生成共用。
 */
import { parseCampaignPlatforms } from "../influencer/resolve-campaign-platforms.js";
import { parseQuoteNegotiation } from "./quote-resolution.js";

/** 已知数值型交付项；未知内容统一进 note 由人工阅读 */
const NUMERIC_FIELDS = [
  "videoCount",
  "bioLinkDays",
  "adCodeDays",
  "usageRightsDays",
];

/**
 * 发布渠道（交付结果的 platforms）独立于 Campaign 投放平台：
 * 投放平台只有 TikTok / Instagram / YouTube / X，但红人实际发布渠道还可能是 Facebook，
 * 因此这里用独立的别名表，不污染 campaign 投放平台解析。
 */
const CHANNEL_ALIASES = Object.freeze({
  tiktok: "TikTok",
  tt: "TikTok",
  tk: "TikTok",
  instagram: "Instagram",
  ins: "Instagram",
  ig: "Instagram",
  youtube: "YouTube",
  yt: "YouTube",
  ytb: "YouTube",
  facebook: "Facebook",
  fb: "Facebook",
  meta: "Facebook",
  x: "X",
  twitter: "X",
  tw: "X",
});

const CHANNEL_SCAN_TOKENS = Object.freeze([
  ["youtube", "YouTube"],
  ["ytb", "YouTube"],
  ["instagram", "Instagram"],
  ["tiktok", "TikTok"],
  ["facebook", "Facebook"],
]);

/** 把任意平台表述归一化成发布渠道规范名（含 Facebook） */
export function normalizePublishingPlatforms(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) {
    const out = [];
    for (const item of raw) {
      for (const p of normalizePublishingPlatforms(item)) {
        if (!out.includes(p)) out.push(p);
      }
    }
    return out;
  }
  const text = String(raw).trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const exact = CHANNEL_ALIASES[lower];
  if (exact) return [exact];

  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  for (const part of lower.split(/[、,，和+&/|\s]+/).filter(Boolean)) {
    const alias = CHANNEL_ALIASES[part];
    if (alias) {
      push(alias);
      continue;
    }
    const fromCampaign = parseCampaignPlatforms(part);
    if (fromCampaign.length) {
      fromCampaign.forEach(push);
      continue;
    }
    for (const [token, label] of CHANNEL_SCAN_TOKENS) {
      if (part.includes(token)) push(label);
    }
  }
  return out;
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toPositiveNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * 归一化交付结果对象。空对象/空数组/纯空字符串返回 null（表示「未记录」）。
 * @param {unknown} raw
 * @returns {{
 *   platforms: string[],
 *   videoCount: number|null,
 *   bioLinkDays: number|null,
 *   adCodeDays: number|null,
 *   usageRightsDays: number|null,
 *   note: string|null,
 *   confirmedAt: string|null,
 *   source: string|null,
 * }|null}
 */
export function normalizeDeliverables(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    const parsed = parseMaybeJson(text);
    if (!parsed || typeof parsed !== "object") {
      // 兼容 LLM 只给了自然语言的情况：不解析成结构，交给 note 展示
      return {
        platforms: [],
        videoCount: null,
        bioLinkDays: null,
        adCodeDays: null,
        usageRightsDays: null,
        note: text.slice(0, 2000),
        confirmedAt: null,
        source: null,
      };
    }
    obj = parsed;
  }
  if (Array.isArray(obj) || typeof obj !== "object") return null;

  const platforms = normalizePublishingPlatforms(
    obj.platforms ?? obj.platform ?? obj.channels ?? null
  );
  const out = {
    platforms,
    videoCount: toPositiveNumberOrNull(obj.videoCount ?? obj.videos ?? obj.count),
    bioLinkDays: toPositiveNumberOrNull(obj.bioLinkDays ?? obj.bioLink),
    adCodeDays: toPositiveNumberOrNull(obj.adCodeDays ?? obj.adCode),
    usageRightsDays: toPositiveNumberOrNull(
      obj.usageRightsDays ?? obj.usageRights ?? obj.materialRightsDays
    ),
    note:
      typeof obj.note === "string" && obj.note.trim()
        ? obj.note.trim().slice(0, 2000)
        : null,
  };
  if (typeof obj.confirmedAt === "string" && obj.confirmedAt.trim()) {
    out.confirmedAt = obj.confirmedAt.trim();
  }
  if (typeof obj.source === "string" && obj.source.trim()) {
    out.source = obj.source.trim().slice(0, 64);
  }

  const hasValue =
    out.platforms.length > 0 ||
    NUMERIC_FIELDS.some((k) => out[k] != null) ||
    Boolean(out.note);
  return hasValue ? out : null;
}

/**
 * 取最近一条带 deliverables 的谈判记录。
 * 广告主条目同样可以带 deliverables（例如品牌主动放宽平台范围），
 * 因此这里不按 role 过滤——与「最新报价」只看红人报价的规则不同，交付结果以最后一次沟通为准。
 * @param {{ quoteNegotiation?: unknown }} params
 * @returns {(ReturnType<typeof normalizeDeliverables> & { entry: object|null })|null}
 */
export function resolveLatestDeliverables({ quoteNegotiation } = {}) {
  const history = parseQuoteNegotiation(quoteNegotiation);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const normalized = normalizeDeliverables(entry?.deliverables);
    if (!normalized) continue;
    return {
      ...normalized,
      confirmedAt:
        normalized.confirmedAt ||
        (typeof entry?.at === "string" && entry.at.trim() ? entry.at.trim() : null),
      source:
        normalized.source ||
        (typeof entry?.source === "string" && entry.source.trim()
          ? entry.source.trim()
          : null),
      entry,
    };
  }
  return null;
}

/** @param {{ quote_negotiation?: unknown, quoteNegotiation?: unknown }} row */
export function resolveLatestDeliverablesFromRow(row) {
  return resolveLatestDeliverables({
    quoteNegotiation: row?.quote_negotiation ?? row?.quoteNegotiation,
  });
}

/** 平台展示：TikTok / Instagram / YouTube / Facebook */
export function formatPlatformsLabel(platforms) {
  const list = Array.isArray(platforms) ? platforms.filter(Boolean) : [];
  return list.length ? list.join(" / ") : "";
}

/**
 * 卡片/日志用的中文摘要：如「4 平台（TikTok / Instagram / YouTube / Facebook）· 1 条视频 · bio link 7 天 · ad-code 30 天 · 素材授权 90 天」
 * @param {ReturnType<typeof normalizeDeliverables>} deliverables
 * @returns {string}
 */
export function formatDeliverablesSummary(deliverables) {
  const d = normalizeDeliverables(deliverables);
  if (!d) return "";
  const parts = [];
  if (d.platforms.length) {
    parts.push(`${d.platforms.length} 平台（${formatPlatformsLabel(d.platforms)}）`);
  }
  if (d.videoCount != null) parts.push(`${d.videoCount} 条视频`);
  if (d.bioLinkDays != null) parts.push(`bio link ${d.bioLinkDays} 天`);
  if (d.adCodeDays != null) parts.push(`ad-code ${d.adCodeDays} 天`);
  if (d.usageRightsDays != null) {
    parts.push(`素材授权 ${d.usageRightsDays} 天`);
  }
  if (d.note) parts.push(d.note);
  return parts.join(" · ");
}

function joinEn(parts) {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function numberWordEn(n) {
  const map = {
    1: "one",
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
  };
  return map[Number(n)] || String(n);
}

/**
 * 合同 Deliverables 条款的确定性英文正文（平台与交付项由结构化数据直接生成，
 * 不再交给 LLM 决定，避免平台/交付项被改写或遗漏）。
 * @param {ReturnType<typeof normalizeDeliverables>} deliverables
 * @param {{ productName?: string|null }} [opts]
 * @returns {string}
 */
export function renderDeliverablesClauseEn(deliverables, { productName = null } = {}) {
  const d = normalizeDeliverables(deliverables);
  if (!d) return "";
  const count =
    d.videoCount != null
      ? `${numberWordEn(d.videoCount)} dedicated video${Number(d.videoCount) === 1 ? "" : "s"}`
      : "dedicated video content";
  const featuring =
    productName && String(productName).trim()
      ? `${count} featuring ${String(productName).trim()}`
      : count;
  const platformClause = d.platforms.length
    ? `distributed across the Creator's ${joinEn(d.platforms)} channels`
    : "";
  const conditions = [];
  if (d.bioLinkDays != null) {
    conditions.push(`the bio link kept in place for ${d.bioLinkDays} days`);
  }
  if (d.adCodeDays != null) {
    conditions.push(`the ad code active for ${d.adCodeDays} days`);
  }
  if (d.usageRightsDays != null) {
    conditions.push(
      `${d.usageRightsDays} days of usage rights to the delivered material`
    );
  }
  const head = platformClause ? `${featuring}, ${platformClause}` : featuring;
  const body = conditions.length
    ? `${head}, together with ${joinEn(conditions)}`
    : head;
  if (!body) return "";
  const capitalize = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  const sentences = [`${capitalize(body)}.`];
  // 合同为英文：中文 note 只用于卡片/内部阅读，不写进英文条款
  const noteIsEnglish = d.note && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(d.note);
  if (noteIsEnglish) {
    const note = String(d.note).trim().replace(/[.\s]+$/, "");
    if (note) sentences.push(`${capitalize(note)}.`);
  }
  return sentences.join(" ");
}
