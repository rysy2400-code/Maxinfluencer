/**
 * Campaign 投放平台解析与心跳派单轮转。
 */

const PLATFORM_ALIASES = Object.freeze({
  tiktok: "TikTok",
  tt: "TikTok",
  instagram: "Instagram",
  ins: "Instagram",
  ig: "Instagram",
  youtube: "YouTube",
  yt: "YouTube",
  ytb: "YouTube",
});

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

  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const out = [];
  const seen = new Set();

  for (const item of list) {
    const key = String(item || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    const normalized = PLATFORM_ALIASES[key] || null;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out.length ? out : ["TikTok"];
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
