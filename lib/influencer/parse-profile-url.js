/**
 * 从社媒主页链接解析 handle 与平台
 */

const PLATFORM_PATTERNS = [
  {
    slug: "tiktok",
    platform: "TikTok",
    re: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/i,
  },
  {
    slug: "instagram",
    platform: "Instagram",
    re: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/i,
  },
  {
    slug: "youtube",
    platform: "YouTube",
    // handle 允许任意非 /?# 字符，随后做百分号解码，兼容日韩俄文等多语言 handle
    re: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@|channel\/|c\/)([^/?#]+)/i,
  },
  {
    slug: "x",
    platform: "X",
    re: /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([a-zA-Z0-9_]+)/i,
  },
];

/**
 * @param {string} rawUrl
 * @returns {{ profileUrl: string, username: string, platformSlug: string, platform: string } | null}
 */
export function parseProfileUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return null;
  let url = trimmed;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url.replace(/^\/+/, "")}`;
  }
  for (const p of PLATFORM_PATTERNS) {
    const m = url.match(p.re);
    if (!m?.[1]) continue;
    let handle = String(m[1]).trim();
    try {
      handle = decodeURIComponent(handle);
    } catch {
      /* 保留原始值 */
    }
    handle = handle.replace(/^@+/, "").trim();
    if (!handle || handle.toLowerCase() === "www") continue;
    const normalized =
      p.slug === "youtube"
        ? url.split(/[?#]/)[0]
        : p.slug === "x"
          ? `https://x.com/${handle}`
          : `https://www.${p.slug === "tiktok" ? "tiktok.com" : p.slug === "instagram" ? "instagram.com" : "youtube.com"}/${p.slug === "tiktok" ? `@${handle}` : p.slug === "instagram" ? handle : `@${handle}`}`;
    return {
      profileUrl: normalized,
      username: handle,
      platformSlug: p.slug,
      platform: p.platform,
    };
  }
  return null;
}

export function normalizePlatformSlugInput(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "tk" || s === "tiktok" || s === "tt") return "tiktok";
  if (s === "ins" || s === "instagram" || s === "ig") return "instagram";
  if (s === "yt" || s === "ytb" || s === "youtube") return "youtube";
  if (s === "x" || s === "twitter" || s === "tw") return "x";
  return null;
}

export function platformLabelFromSlug(slug) {
  const s = normalizePlatformSlugInput(slug) || String(slug || "").toLowerCase();
  if (s === "instagram") return "Instagram";
  if (s === "youtube") return "YouTube";
  if (s === "tiktok") return "TikTok";
  return null;
}

/**
 * @param {string} username
 * @param {string} platformSlugOrRaw
 * @returns {string | null}
 */
export function buildProfileUrl(username, platformSlugOrRaw) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const slug = normalizePlatformSlugInput(platformSlugOrRaw);
  if (!handle || !slug) return null;
  if (slug === "tiktok") return `https://www.tiktok.com/@${handle}`;
  if (slug === "instagram") return `https://www.instagram.com/${handle}`;
  if (slug === "youtube") return `https://www.youtube.com/@${handle}`;
  return null;
}

/**
 * @param {string} rawUrl
 * @returns {{ profileUrl: string, username: string, platformSlug: string, platform: string } | null}
 */
export function canonicalizeProfileUrl(rawUrl) {
  const parsed = parseProfileUrl(rawUrl);
  if (!parsed) return null;
  const rebuilt = buildProfileUrl(parsed.username, parsed.platformSlug);
  if (!rebuilt) return parsed;
  return { ...parsed, profileUrl: rebuilt };
}
