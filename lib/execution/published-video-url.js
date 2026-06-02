/**
 * 解析已发布视频链接，识别平台与资源 ID。
 */

/** @typedef {'tiktok'|'instagram'|'youtube'|'unknown'} PublishedVideoPlatform */

/**
 * @param {string|null|undefined} raw
 * @returns {{ url: string, platform: PublishedVideoPlatform, videoId: string|null, shortcode: string|null, username: string|null }}
 */
export function parsePublishedVideoUrl(raw) {
  const url = String(raw || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      url: "",
      platform: "unknown",
      videoId: null,
      shortcode: null,
      username: null,
    };
  }

  let platform = /** @type {PublishedVideoPlatform} */ ("unknown");
  let videoId = null;
  let shortcode = null;
  let username = null;

  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    if (host.includes("tiktok.com")) {
      platform = "tiktok";
      const vm = u.pathname.match(/\/video\/(\d+)/);
      if (vm) videoId = vm[1];
      const um = u.pathname.match(/\/@([^/]+)/);
      if (um) username = um[1];
    } else if (host.includes("instagram.com")) {
      platform = "instagram";
      const rm = u.pathname.match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
      if (rm) shortcode = rm[1];
    } else if (host === "youtu.be") {
      platform = "youtube";
      videoId = u.pathname.replace(/^\//, "").split("/")[0] || null;
    } else if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
      platform = "youtube";
      videoId = u.searchParams.get("v");
      if (!videoId) {
        const sm = u.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/);
        if (sm) videoId = sm[1];
      }
    }
  } catch {
    platform = "unknown";
  }

  return { url, platform, videoId, shortcode, username };
}

/**
 * 从 execution 行解析可用于刷新的视频链接（video_link 列优先，其次 last_event.videoLink）。
 */
export function resolveExecutionPublishedVideoLink(row) {
  if (!row) return null;
  const col = row.video_link != null ? String(row.video_link).trim() : "";
  if (col) return col;

  const last =
    row.lastEvent && typeof row.lastEvent === "object"
      ? row.lastEvent
      : parseJsonSafe(row.last_event);
  const fromEvent = last?.videoLink != null ? String(last.videoLink).trim() : "";
  return fromEvent || null;
}

function parseJsonSafe(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/**
 * 从 snapshot / campaign 推断平台（链接无法识别时兜底）。
 */
export function inferPlatformFromSnapshot(snapshot, parsedPlatform) {
  if (parsedPlatform && parsedPlatform !== "unknown") return parsedPlatform;
  const p = String(snapshot?.platform || snapshot?.Platform || "")
    .trim()
    .toLowerCase();
  if (p.includes("instagram") || p === "ins") return "instagram";
  if (p.includes("youtube") || p === "ytb" || p === "yt") return "youtube";
  if (p.includes("tiktok") || p === "tk") return "tiktok";
  return parsedPlatform || "unknown";
}
