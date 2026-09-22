/**
 * TikTok 评论抓取 + 真实互动指标。
 *
 * 数据来源：已登录 Chrome（CDP）+ TikTok Web 签名 API。
 *   - /api/user/detail/    -> secUid（部分账号在 103 的 US 出口下不可见，返回 10221）
 *   - /api/post/item_list/ -> 近期视频（含 commentCount / playCount / diggCount）
 *   - /api/comment/list/   -> 评论文案 + 点赞 + 回复数 + comment_language + 评论者 uid/sec_uid
 *
 * 注意：评论接口不含评论者国家/地区字段；user/detail 也不返回 region。
 * 受众语言/购买意向的口径见 comment-analysis.js。
 */

const COMMENT_API = "https://www.tiktok.com/api/comment/list/";
const USER_DETAIL_API = "https://www.tiktok.com/api/user/detail/";
const ITEM_LIST_API = "https://www.tiktok.com/api/post/item_list/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeUsername(u) {
  return String(u || "").replace(/^@/, "").trim();
}

// ---------------- 抓取 ----------------

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @returns {Promise<string|null>} secUid
 */
export async function resolveTiktokSecUid(page, username) {
  const { tiktokMakeRequest } = await import(
    "../tools/influencer-functions/tiktok/tiktok-api-client.js"
  );
  const handle = normalizeUsername(username);
  if (!handle) return null;
  try {
    const json = await tiktokMakeRequest(
      page,
      USER_DETAIL_API,
      { unique_id: handle, uniqueId: handle },
      { referer: `https://www.tiktok.com/@${handle}`, retries: 1 }
    );
    const user = json?.userInfo?.user || json?.user || {};
    return String(user.secUid || user.sec_uid || "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} secUid
 * @param {{ maxVideos?: number, perPage?: number, requestGapMs?: number }} [opts]
 */
export async function fetchRecentVideos(page, secUid, opts = {}) {
  const { tiktokMakeRequest } = await import(
    "../tools/influencer-functions/tiktok/tiktok-api-client.js"
  );
  const maxVideos = Math.max(1, Number(opts.maxVideos || 50));
  const perPage = Math.min(Math.max(Number(opts.perPage || 20), 1), 35);
  const gap = Number(opts.requestGapMs ?? 350);
  const pages = Math.ceil(maxVideos / perPage);
  const videos = [];
  let cursor = 0;
  let calls = 0;
  for (let i = 0; i < pages; i += 1) {
    let json;
    try {
      json = await tiktokMakeRequest(
        page,
        ITEM_LIST_API,
        { secUid, count: String(perPage), cursor: String(cursor) },
        { referer: "https://www.tiktok.com/", retries: 1 }
      );
    } catch {
      break;
    }
    calls += 1;
    const items = json?.itemList || json?.item_list || [];
    for (const it of items) {
      videos.push({
        videoId: String(it.id || it.aweme_id || ""),
        desc: String(it.desc || "").slice(0, 120),
        createTime: Number(it.createTime || 0) || null,
        views: Number(it?.stats?.playCount || 0) || 0,
        likes: Number(it?.stats?.diggCount || 0) || 0,
        comments: Number(it?.stats?.commentCount || 0) || 0,
        shares: Number(it?.stats?.shareCount || 0) || 0,
        collectCount: Number(it?.stats?.collectCount || 0) || 0,
      });
    }
    const next = json?.cursor ?? json?.nextCursor;
    const hasMore = !!(json?.hasMore ?? json?.has_more);
    if (!hasMore || items.length === 0 || next == null || next === cursor) break;
    cursor = next;
    if (i < pages - 1) await sleep(gap);
  }
  return { videos: videos.filter((v) => v.videoId).slice(0, maxVideos), calls };
}

/**
 * @param {import('playwright').Page} page
 * @param {{ awemeId: string, username?: string, maxPages?: number, perPage?: number, requestGapMs?: number }} opts
 */
export async function fetchVideoComments(page, opts) {
  const { tiktokMakeRequest } = await import(
    "../tools/influencer-functions/tiktok/tiktok-api-client.js"
  );
  const awemeId = String(opts.awemeId || "");
  const username = normalizeUsername(opts.username);
  const maxPages = Math.max(1, Number(opts.maxPages || 1));
  const perPage = Math.min(Math.max(Number(opts.perPage || 20), 1), 50);
  const gap = Number(opts.requestGapMs ?? 350);
  const comments = [];
  const seen = new Set();
  let cursor = 0;
  let calls = 0;
  let hasMore = true;
  let apiTotal = null;
  while (calls < maxPages && hasMore) {
    let json;
    try {
      json = await tiktokMakeRequest(
        page,
        COMMENT_API,
        { aweme_id: awemeId, count: String(perPage), cursor: String(cursor) },
        {
          referer: `https://www.tiktok.com/@${username || "user"}/video/${awemeId}`,
          retries: 1,
        }
      );
    } catch (e) {
      return { comments, calls: calls + 1, error: String(e?.message || e).slice(0, 160), hasMore: false, apiTotal };
    }
    calls += 1;
    const batch = json?.comments || json?.comment_list || [];
    if (apiTotal == null && json?.total != null) apiTotal = Number(json.total) || 0;
    for (const c of batch) {
      const cid = String(c.cid || "");
      if (cid && seen.has(cid)) continue;
      if (cid) seen.add(cid);
      comments.push({
        cid,
        awemeId,
        text: String(c.text || ""),
        diggCount: Number(c.digg_count || 0) || 0,
        replyCount: Number(c.reply_comment_total || 0) || 0,
        createTime: Number(c.create_time || 0) || null,
        language: c.comment_language || null,
        authorPinned: !!c.author_pin,
        isAuthorDigged: !!c.is_author_digged,
        userId: String(c?.user?.uid || ""),
        uniqueId: String(c?.user?.unique_id || ""),
        userSecUid: String(c?.user?.sec_uid || ""),
        userRegion: c?.user?.region || null,
      });
    }
    const next = json?.cursor ?? json?.nextCursor;
    hasMore = !!(json?.has_more ?? json?.hasMore) && batch.length > 0;
    if (hasMore && next != null) cursor = next;
    else if (next != null && next !== cursor) cursor = next;
    if (hasMore && calls < maxPages) await sleep(gap);
  }
  return { comments, calls, hasMore, apiTotal };
}
