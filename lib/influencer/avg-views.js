/**
 * 从红人快照 / 执行进度 item 读取数值型平均播放量。
 * 与 tiktok_campaign_execution.influencer_snapshot.views 结构一致：
 * number | { avg, display? } | { count, display? }，以及顶层 avg_views / avgViews。
 */
export function avgViewsFromSnapshot(s) {
  if (s == null || typeof s !== "object") return null;

  for (const key of ["avg_views", "avgViews"]) {
    const n = s[key];
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }

  const v = s.views;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v != null && typeof v === "object" && !Array.isArray(v)) {
    if (typeof v.avg === "number" && Number.isFinite(v.avg)) return v.avg;
    if (typeof v.count === "number" && Number.isFinite(v.count)) return v.count;
  }

  return null;
}

/** eCPM = 最新报价 / (平均播放量 / 1000) */
export function formatEcpmFromFlatAndViews(flatAmt, viewsNum, currencyCode) {
  if (
    flatAmt == null ||
    !Number.isFinite(Number(flatAmt)) ||
    viewsNum == null ||
    viewsNum <= 0
  ) {
    return "—";
  }
  const v = Number(flatAmt) / (viewsNum / 1000);
  return `${v.toFixed(2)} ${currencyCode || "USD"} / 千次播放`;
}
