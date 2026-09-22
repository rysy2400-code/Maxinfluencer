/**
 * Instagram 评论抓取 + 真实互动指标。
 *
 * 数据来源：已登录 Chrome（CDP 9223）+ Instagram Web 内部 API。
 *   - /api/v1/users/web_profile_info/   -> 用户 pk（当前会话易 429，失败走 topsearch 兜底）
 *   - /web/search/topsearch/            -> username -> pk 兜底
 *   - clips GraphQL（fetchUserClipsAll）-> 近期 Reels（含 comment_count / play_count / like_count）
 *   - /api/v1/media/{id}/comments/      -> 评论文案 + 点赞 + 子评论数 + 时间 + 评论者 pk/username
 *
 * 已知限制（实测）：
 *   1. 评论首屏有上限，`sort_order=recent` 约 15 条/媒体，且多数媒体没有 next_max_id，
 *      拿不到全量评论（对"抽样看互动质量"够用，不能当全量统计）。
 *   2. 评论者 user 对象不含 country_code / region；IG 只在"红人本人"维度能拿国家
 *      （about_this_account / web_profile_info），评论者国家需要逐人反查且成本高。
 *   3. IG 评论不返回 language 字段，只能用文本启发式推断（confidence 低于 TikTok 官方字段）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeIgUsername(u) {
  return String(u || "").replace(/^@/, "").trim();
}

// ---------------- 语言启发式 ----------------

/** 文字系统识别（短文本也有效），与 infer-bio-language 的脚本判定保持一致口径 */
function scriptLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0590-\u05ff]/.test(text)) return "he";
  if (/[\u0370-\u03ff]/.test(text)) return "el";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[\u0900-\u097f]/.test(text)) return "hi";
  if (/[\u0980-\u09ff]/.test(text)) return "bn";
  if (/[\u1000-\u109f]/.test(text)) return "my";
  if (/[\u0e80-\u0eff]/.test(text)) return "lo";
  if (/[\u1780-\u17ff]/.test(text)) return "km";
  return null;
}

/**
 * IG 评论语言推断（无官方字段）。
 * 文字系统 → 高置信；够长的拉丁文本走 detectBioLanguageProfile；过短 → unknown。
 * @param {string} text
 * @returns {{language: string, confidence: number, source: string}}
 */
export function estimateCommentLanguage(text) {
  const raw = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  if (!raw) return { language: "un", confidence: 0, source: "empty" };
  const script = scriptLanguage(raw);
  if (script) return { language: script, confidence: 0.95, source: "script" };
  if (raw.length < 6) return { language: "un", confidence: 0, source: "too_short" };
  const asciiWords = raw.match(/[a-zA-Z]{3,}/g) || [];
  if (asciiWords.length === 0) return { language: "un", confidence: 0, source: "no_letters" };
  // 轻量拉丁判定：只做 en/长词兜底，避免与 TikTok 官方字段口径混淆
  return { language: "en", confidence: 0.4, source: "ascii_default" };
}

// ---------------- 抓取 ----------------

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @returns {Promise<{pk: string|null, source: string|null}>}
 */
export async function resolveIgUserId(page, username) {
  const ig = await import(
    "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
  );
  const { fetchWebProfileInfo } = ig;
  const handle = normalizeIgUsername(username);
  if (!handle) return { pk: null, source: null };
  try {
    const profile = await fetchWebProfileInfo(page, handle);
    const u = profile?.data?.user || {};
    const pk = String(u.id || u.pk || "").trim();
    if (pk) return { pk, source: "web_profile_info" };
  } catch {
    /* fallthrough */
  }
  try {
    // 兜底：topsearch。自实现而不依赖 instagram-direct-fetch 里的同名封装，
    // 避免目标机器上的该模块版本较旧（没有该函数）导致兜底失效。
    if (typeof ig.resolveIgUserPkByUsername === "function") {
      const hit = await ig.resolveIgUserPkByUsername(page, handle);
      const pk = String(hit?.pk || "").trim();
      if (pk) return { pk, source: "topsearch" };
    } else if (typeof ig.igApiFetch === "function") {
      const json = await ig.igApiFetch(
        page,
        `/web/search/topsearch/?query=${encodeURIComponent(handle)}`,
        { referer: "https://www.instagram.com/" }
      );
      const entries = Array.isArray(json?.users) ? json.users : [];
      const lower = handle.toLowerCase();
      const hit = entries.find(
        (x) => String(x?.user?.username || "").toLowerCase() === lower
      );
      const pk = String(hit?.user?.pk || hit?.user?.pk_id || hit?.user?.id || "").trim();
      if (pk) return { pk, source: "topsearch" };
    }
  } catch {
    /* ignore */
  }
  return { pk: null, source: null };
}

/**
 * 近期 Reels（作为"近期视频"样本）。
 * @param {import('playwright').Page} page
 * @param {string} pk
 * @param {{ maxVideos?: number, username?: string, maxPages?: number }} [opts]
 */
export async function fetchRecentMedia(page, pk, opts = {}) {
  const { fetchUserClipsAll } = await import(
    "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
  );
  const { extractClipsMediaFromJson } = await import(
    "../tools/influencer-functions/instagram/instagram-json-utils.js"
  );
  const maxVideos = Math.max(1, Number(opts.maxVideos || 50));
  const maxPages = Math.min(Math.max(Number(opts.maxPages || Math.ceil(maxVideos / 12)), 1), 25);
  const batches = [];
  let calls = 0;
  try {
    const json = await fetchUserClipsAll(page, pk, {
      maxPages,
      username: opts.username || "",
    });
    calls += 1;
    if (json) batches.push(json);
  } catch {
    /* ignore */
  }
  const media = batches
    .flatMap((b) => extractClipsMediaFromJson(b) || [])
    .map((m) => ({
      mediaId: String(m.id || m.pk || ""),
      shortcode: String(m.code || m.shortcode || ""),
      createTime: Number(m.taken_at || m.device_timestamp || 0) || null,
      views: Number(m.play_count || m.view_count || m.ig_play_count || 0) || 0,
      likes: Number(m.like_count || 0) || 0,
      comments: Number(m.comment_count || 0) || 0,
      mediaType: m.media_type ?? null,
      productType: m.product_type || null,
    }))
    .filter((m) => m.mediaId);
  // 去重（同一 media 可能在多个 batch 出现）
  const seen = new Set();
  const deduped = [];
  for (const m of media) {
    if (seen.has(m.mediaId)) continue;
    seen.add(m.mediaId);
    deduped.push(m);
  }
  deduped.sort((a, b) => b.comments - a.comments);
  return { media: deduped.slice(0, maxVideos), calls };
}

/**
 * 单条媒体的评论（REST，最多 maxPages 页）。
 * @param {import('playwright').Page} page
 * @param {{ mediaId: string, maxPages?: number, perPage?: number, requestGapMs?: number }} opts
 */
export async function fetchMediaComments(page, opts) {
  const { igApiFetch } = await import(
    "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
  );
  const mediaId = String(opts.mediaId || "");
  const maxPages = Math.max(1, Number(opts.maxPages || 1));
  const gap = Number(opts.requestGapMs ?? 500);
  const comments = [];
  const seen = new Set();
  let calls = 0;
  let nextMaxId = null;
  let hasMore = true;
  let apiTotal = null;
  while (calls < maxPages && hasMore) {
    const base = `/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false&sort_order=recent`;
    const url = nextMaxId ? `${base}&next_max_id=${encodeURIComponent(nextMaxId)}` : base;
    let json;
    try {
      json = await igApiFetch(page, url, { referer: "https://www.instagram.com/" });
    } catch (e) {
      return { comments, calls: calls + 1, error: String(e?.message || e).slice(0, 160), hasMore: false, apiTotal };
    }
    calls += 1;
    if (!json) return { comments, calls, error: "empty_response", hasMore: false, apiTotal };
    if (apiTotal == null && json.comment_count != null) apiTotal = Number(json.comment_count) || 0;
    for (const c of json.comments || []) {
      const pk = String(c.pk || c.id || "");
      if (pk && seen.has(pk)) continue;
      if (pk) seen.add(pk);
      const text = String(c.text || "");
      const lang = estimateCommentLanguage(text);
      comments.push({
        cid: pk,
        mediaId,
        text,
        diggCount: Number(c.comment_like_count || 0) || 0,
        replyCount: Number(c.child_comment_count || 0) || 0,
        createTime: Number(c.created_at || c.created_at_utc || 0) || null,
        language: lang.language,
        languageConfidence: lang.confidence,
        languageSource: lang.source,
        isVerifiedAuthor: !!c?.user?.is_verified,
        userId: String(c?.user?.pk || c?.user_id || ""),
        uniqueId: String(c?.user?.username || ""),
      });
    }
    nextMaxId = json.next_max_id || null;
    hasMore = !!json.has_more_comments && !!nextMaxId;
    if (hasMore && calls < maxPages) await sleep(gap);
  }
  return { comments, calls, hasMore, apiTotal };
}
