/**
 * 视频/推文样本的补充指标：中位播放 + 点赞率 / 评论率。
 *
 * 口径（与产品确认一致）：
 *  - 样本 = 播放量 > 0 的视频/推文（播放为 0/缺失的一律剔除，均值分母同步变小）。
 *  - medianViews：样本播放量中位数；空样本返回 null。
 *  - likeRate / commentRate：Σ点赞 ÷ Σ播放、Σ评论 ÷ Σ播放，返回 0~1 的小数
 *    （前端 ×100 显示成百分比）；Σ播放 = 0 或缺样本时返回 null。
 *
 * 调用方必须传入「已按上述口径过滤好的样本」，保证均播/中位/比率三者的样本与分母一致。
 */

/** 数字中位数（空数组 → null，偶数个取中间两个的均值，结果取整） */
export function medianNumberOf(nums) {
  const arr = (Array.isArray(nums) ? nums : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = arr.length >> 1;
  const median =
    arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  return Math.round(median);
}

/** 计数展示格式（与各平台 formatNumber 一致：1.2K / 3.4M） */
export function formatCountDisplay(num) {
  const n = Number(num);
  if (num == null || num === "" || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Array} list 样本列表（应与均播同一批）
 * @param {{
 *   viewsOf?: (item: any) => any,
 *   likesOf?: (item: any) => any,
 *   commentsOf?: (item: any) => any
 * }} [getters] 取值函数，缺省按 { views:{count}, likes:{count}, comments:{count} } 取
 * @returns {{ medianViews: number|null, likeRate: number|null, commentRate: number|null,
 *   totalViews: number, totalLikes: number, totalComments: number }}
 */
export function computeViewMedianAndRates(list, getters = {}) {
  const arr = Array.isArray(list) ? list : [];
  const viewsOf = getters.viewsOf || ((item) => item?.views?.count);
  const likesOf = getters.likesOf || ((item) => item?.likes?.count);
  const commentsOf = getters.commentsOf || ((item) => item?.comments?.count);

  const views = arr.map((item) => toCount(viewsOf(item)));
  const totalViews = views.reduce((sum, n) => sum + n, 0);
  const totalLikes = arr.reduce((sum, item) => sum + toCount(likesOf(item)), 0);
  const totalComments = arr.reduce(
    (sum, item) => sum + toCount(commentsOf(item)),
    0
  );

  return {
    medianViews: medianNumberOf(views),
    likeRate: totalViews > 0 ? totalLikes / totalViews : null,
    commentRate: totalViews > 0 ? totalComments / totalViews : null,
    totalViews,
    totalLikes,
    totalComments,
  };
}
