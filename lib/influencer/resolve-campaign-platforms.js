/**
 * Campaign 投放平台解析与心跳派单轮转。
 * 支持缩写与组合表述，如 ytb、tk、ins、「ytb和tk」「ytb、tk和ins」。
 */

const PLATFORM_ALIASES = Object.freeze({
  tiktok: "TikTok",
  tt: "TikTok",
  tk: "TikTok",
  instagram: "Instagram",
  ins: "Instagram",
  ig: "Instagram",
  youtube: "YouTube",
  yt: "YouTube",
  ytb: "YouTube",
});

/** 组合字符串分隔符：顿号、逗号、和、加号、斜杠等 */
const PLATFORM_SPLIT_RE = /[、,，和+\|&/\s]+/;

/** 无法按分隔符切开时，从连续文本中扫描的 token（长匹配优先） */
const PLATFORM_SCAN_TOKENS = Object.freeze([
  ["youtube", "YouTube"],
  ["instagram", "Instagram"],
  ["tiktok", "TikTok"],
  ["ytb", "YouTube"],
  ["ins", "Instagram"],
  ["yt", "YouTube"],
  ["ig", "Instagram"],
  ["tk", "TikTok"],
  ["tt", "TikTok"],
]);

/**
 * @param {unknown} raw - 单平台或组合表述
 * @returns {string[]} 如 ['YouTube'] 或 ['YouTube','TikTok','Instagram']
 */
export function parseCampaignPlatforms(raw) {
  if (raw == null || raw === "") return [];

  if (Array.isArray(raw)) {
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      for (const p of parseCampaignPlatforms(item)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
    return out;
  }

  const text = String(raw).trim();
  if (!text) return [];

  const lower = text.toLowerCase();
  const exact = PLATFORM_ALIASES[lower];
  if (exact) return [exact];

  const parts = lower.split(PLATFORM_SPLIT_RE).filter(Boolean);
  if (parts.length > 1) {
    const out = [];
    const seen = new Set();
    for (const part of parts) {
      for (const p of parseCampaignPlatforms(part)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
    return out;
  }

  const scanned = [];
  const seen = new Set();
  let remaining = lower;
  for (const [token, display] of PLATFORM_SCAN_TOKENS) {
    if (!remaining.includes(token)) continue;
    if (!seen.has(display)) {
      seen.add(display);
      scanned.push(display);
    }
    remaining = remaining.split(token).join(" ");
  }
  if (scanned.length > 0) return scanned;

  const singlePart = parts[0] || lower;
  const fromPart = PLATFORM_ALIASES[singlePart];
  return fromPart ? [fromPart] : [];
}

/**
 * @param {unknown} campaignInfo
 * @returns {string[]} 如 ['TikTok'] 或 ['TikTok','Instagram','YouTube']
 */
export function resolveCampaignPlatforms(campaignInfo = {}) {
  const raw =
    campaignInfo?.platform ??
    campaignInfo?.platforms ??
    campaignInfo?.Platform ??
    null;

  const parsed = parseCampaignPlatforms(raw);
  return parsed.length ? parsed : ["TikTok"];
}

/**
 * 写入 DB 前规范化 campaignInfo.platform（canonical 全称）。
 * @param {object|null|undefined} campaignInfo
 * @returns {object|null|undefined}
 */
export function normalizeCampaignInfoPlatforms(campaignInfo) {
  if (campaignInfo == null || typeof campaignInfo !== "object") {
    return campaignInfo;
  }
  if (campaignInfo.platform == null || campaignInfo.platform === "") {
    return campaignInfo;
  }
  const parsed = parseCampaignPlatforms(campaignInfo.platform);
  if (parsed.length === 0) return campaignInfo;
  return {
    ...campaignInfo,
    platform: parsed.length === 1 ? parsed[0] : parsed,
  };
}

/** tiktok_campaign.platform 标量列：取主投放平台的 payload slug */
export function primaryPlatformSlugFromCampaignInfo(campaignInfo) {
  const platforms = resolveCampaignPlatforms(campaignInfo);
  return platformPayloadSlug(platforms[0] || "TikTok");
}

/** @param {string} displayName TikTok | Instagram | YouTube */
export function platformPayloadSlug(displayName) {
  const n = String(displayName || "").trim().toLowerCase();
  if (/instagram/.test(n)) return "instagram";
  if (/youtube/.test(n)) return "youtube";
  return "tiktok";
}

/** @param {string} slug tiktok | instagram | youtube */
export function platformFromPayloadSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (s === "instagram" || s === "ins" || s === "ig") return "Instagram";
  if (s === "youtube" || s === "yt" || s === "ytb") return "YouTube";
  if (s === "tiktok" || s === "tt" || s === "tk") return "TikTok";
  return "TikTok";
}

export function isInstagramPlatform(platformOrSlug) {
  const s = String(platformOrSlug || "").trim().toLowerCase();
  return s === "instagram" || s === "ins" || s === "ig";
}

export function isYouTubePlatform(platformOrSlug) {
  const s = String(platformOrSlug || "").trim().toLowerCase();
  return s === "youtube" || s === "yt" || s === "ytb";
}

/** 工作笔记关键词摘要：任务级平台 + 「红人库」 */
export function workNoteInfluencerLibraryLabel(platformSlugOrDisplay) {
  const raw = String(platformSlugOrDisplay ?? "").trim();
  if (!raw) return "红人库";
  return `${platformFromPayloadSlug(raw)}红人库`;
}

/**
 * 双/三平台 campaign：按最近一次任务的 payload.platform 轮转。
 * @param {string} campaignId
 * @param {string[]} displayPlatforms
 * @param {typeof import('../db/mysql-tiktok.js').queryTikTok} queryFn
 */
export async function pickNextDispatchPlatform(
  campaignId,
  displayPlatforms,
  queryFn
) {
  const platforms = displayPlatforms?.length
    ? displayPlatforms
    : ["TikTok"];
  const slugs = platforms.map(platformPayloadSlug);
  if (slugs.length === 1) return slugs[0];

  let lastSlug = null;
  try {
    const rows = await queryFn(
      `
      SELECT payload
      FROM tiktok_influencer_search_task
      WHERE campaign_id = ?
        AND status IN ('pending', 'processing', 'succeeded')
      ORDER BY id DESC
      LIMIT 1
    `,
      [campaignId]
    );
    const payload = rows?.[0]?.payload;
    if (payload && typeof payload === "object") {
      lastSlug = payload.platform || null;
    } else if (typeof payload === "string") {
      try {
        lastSlug = JSON.parse(payload)?.platform || null;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  if (!lastSlug || !slugs.includes(lastSlug)) {
    return slugs[0];
  }
  const idx = slugs.indexOf(lastSlug);
  return slugs[(idx + 1) % slugs.length];
}
