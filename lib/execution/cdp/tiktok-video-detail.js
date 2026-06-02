/**
 * TikTok 单条视频详情解析（从 CDP 拦截 JSON 提取 stats）。
 * 自 extract-user-profile-cdp.js 抽离，供 metrics worker 复用。
 */

function formatNumber(num) {
  const n = Number(num) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function extractVideoDetailFromAPI(apiData, username) {
  if (!apiData?.itemInfo?.itemStruct) return null;

  const item = apiData.itemInfo.itemStruct;
  const video = {
    videoId: item.id || null,
    videoUrl: item.id
      ? `https://www.tiktok.com/@${username}/video/${item.id}`
      : null,
    views: null,
    likes: null,
    comments: null,
  };

  if (item.stats) {
    if (item.stats.playCount != null) {
      video.views = {
        count: parseInt(item.stats.playCount, 10) || 0,
        display: formatNumber(item.stats.playCount),
      };
    }
    if (item.stats.diggCount != null) {
      video.likes = {
        count: parseInt(item.stats.diggCount, 10) || 0,
        display: formatNumber(item.stats.diggCount),
      };
    }
    if (item.stats.commentCount != null) {
      video.comments = {
        count: parseInt(item.stats.commentCount, 10) || 0,
        display: formatNumber(item.stats.commentCount),
      };
    }
  }

  return video;
}
