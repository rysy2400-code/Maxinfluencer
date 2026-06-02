export function formatMetricDisplay(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

/**
 * @param {{ views?: number|null, likes?: number|null, comments?: number|null }} counts
 */
export function normalizeMetricsPayload(counts) {
  const views = toNonNegInt(counts.views);
  const likes = toNonNegInt(counts.likes);
  const comments = toNonNegInt(counts.comments);
  return {
    views,
    likes,
    comments,
    viewsDisplay: formatMetricDisplay(views),
    likesDisplay: formatMetricDisplay(likes),
    commentsDisplay: formatMetricDisplay(comments),
  };
}

function toNonNegInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** 从 YouTube 展示文本解析播放量，如 "1,234,567 views" */
export function parseYoutubeViewCountText(text) {
  if (text == null) return 0;
  if (typeof text === "number" && Number.isFinite(text)) return Math.round(text);
  const s = String(text).trim().toLowerCase();
  if (!s) return 0;
  const km = s.match(/([\d,.]+)\s*([km])\b/);
  if (km) {
    const base = Number(km[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) return 0;
    return Math.round(base * (km[2] === "m" ? 1_000_000 : 1_000));
  }
  const digits = s.replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
}
