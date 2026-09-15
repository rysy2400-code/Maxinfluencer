/**
 * 从红人来信正文 / LLM 输出中提取「已发布视频」多平台链接。
 *
 * 只认帖子/视频形态的链接（不认主页链接、Google Drive 草稿链接），
 * 供 process-influencer-email-events.js 兜底补齐 LLM 漏掉的平台。
 */

export const PUBLISHED_LINK_PATTERNS = [
  {
    platform: "youtube",
    re: /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s<>"')\]]*v=[\w-]+|shorts\/[\w-]+|live\/[\w-]+)|youtu\.be\/[\w-]+)[^\s<>"')\]]*/gi,
  },
  {
    platform: "instagram",
    re: /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[\w-]+[^\s<>"')\]]*/gi,
  },
  {
    platform: "tiktok",
    re: /https?:\/\/(?:www\.)?(?:vt\.tiktok\.com\/[A-Za-z0-9]+|tiktok\.com\/t\/[A-Za-z0-9]+|tiktok\.com\/@[^/\s<>"')\]]+\/video\/\d+)[^\s<>"')\]]*/gi,
  },
  {
    platform: "x",
    re: /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s<>"')\]]+\/status\/\d+[^\s<>"')\]]*/gi,
  },
];

export function cleanExtractedUrl(url) {
  return String(url || "")
    .trim()
    .replace(/[.,;:!?、。）】》"']+$/g, "");
}

function urlKey(url) {
  return String(url || "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 从邮件正文提取全部「已发布视频」链接（多平台，按出现顺序去重） */
export function extractPublishedLinksFromEmailBody(bodyText) {
  const text = String(bodyText || "");
  if (!text.trim()) return [];
  const found = [];
  const seen = new Set();
  for (const { platform, re } of PUBLISHED_LINK_PATTERNS) {
    const matches = text.match(re) || [];
    for (const raw of matches) {
      const url = cleanExtractedUrl(raw);
      if (!url) continue;
      const key = urlKey(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      found.push({ platform, url });
    }
  }
  return found;
}

/** 归一化 LLM 返回的 publishedLinks（数组，最多 8 条） */
export function normalizePublishedLinksInput(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 8)) {
    if (!item) continue;
    const url =
      typeof item === "string"
        ? item.trim()
        : typeof item.url === "string"
          ? item.url.trim()
          : typeof item.link === "string"
            ? item.link.trim()
            : "";
    if (!url) continue;
    const platformRaw =
      item && typeof item === "object" && typeof item.platform === "string"
        ? item.platform.trim().toLowerCase()
        : "";
    const platform = /youtu/.test(platformRaw)
      ? "youtube"
      : /insta|reel|\big\b|\bins\b/.test(platformRaw)
        ? "instagram"
        : /tiktok|douyin/.test(platformRaw)
          ? "tiktok"
          : platformRaw === "x" || /twitter/.test(platformRaw)
            ? "x"
            : null;
    const promoCode =
      item &&
      typeof item === "object" &&
      typeof item.promoCode === "string" &&
      item.promoCode.trim()
        ? item.promoCode.trim().slice(0, 255)
        : null;
    out.push({ platform, url: url.slice(0, 1024), promoCode });
  }
  return out;
}

/** 合并多来源链接列表（按去参 URL 去重，同名链接补齐 platform / promoCode） */
export function mergePublishedLinkLists(...lists) {
  const index = new Map();
  const out = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.url) continue;
      const key = urlKey(item.url);
      if (!key) continue;
      const prevIdx = index.get(key);
      if (prevIdx != null) {
        const prev = out[prevIdx];
        out[prevIdx] = {
          ...prev,
          platform: prev.platform || item.platform || null,
          promoCode: prev.promoCode || item.promoCode || null,
        };
        continue;
      }
      index.set(key, out.length);
      out.push({
        platform: item.platform || null,
        url: item.url,
        promoCode: item.promoCode || null,
      });
    }
  }
  return out;
}
