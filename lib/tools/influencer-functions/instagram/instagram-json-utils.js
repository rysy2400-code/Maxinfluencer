/**
 * Instagram GraphQL / API JSON 解析工具（搜索与主页共用）
 */

export function formatIgNumber(num) {
  if (typeof num === "string") return num;
  const n = Number(num) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function extractMediaNodesFromJson(json) {
  const posts = [];
  const walk = (obj, depth = 0) => {
    if (depth > 16 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    const hasMedia =
      (obj.code || obj.shortcode) &&
      (obj.pk || obj.id) &&
      (obj.user || obj.owner || obj.caption != null || obj.media_type != null);
    if (hasMedia && (obj.code || obj.shortcode)) {
      posts.push(obj);
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  const seen = new Set();
  return posts.filter((p) => {
    const key = String(p.pk || p.id || p.code);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractUserNodesFromJson(json, username) {
  const target = String(username || "")
    .replace(/^@/, "")
    .toLowerCase();
  const users = [];
  const walk = (obj, depth = 0) => {
    if (depth > 18 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    const uname = (obj.username || obj.user_name || "")
      .toString()
      .toLowerCase();
    const hasUserShape =
      uname &&
      (obj.pk || obj.id) &&
      (obj.edge_followed_by != null ||
        obj.follower_count != null ||
        obj.biography != null ||
        obj.full_name != null);
    if (hasUserShape && (!target || uname === target)) {
      users.push(obj);
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  if (!users.length) return null;
  if (!target) return users[0];
  return users.find((u) => u.username?.toLowerCase() === target) || users[0];
}

export function postUrlFromCode(code, mediaType, productType) {
  const c = String(code || "").trim();
  if (!c) return null;
  const isReel =
    mediaType === 2 ||
    productType === "clips" ||
    productType === "reels" ||
    productType === "igtv";
  return isReel
    ? `https://www.instagram.com/reel/${c}/`
    : `https://www.instagram.com/p/${c}/`;
}

/** 是否为视频/Reels（排除纯图文帖） */
export function isIgReelMedia(node) {
  if (!node) return false;
  const mt = node.media_type;
  const pt = String(node.product_type || "").toLowerCase();
  if (mt === 2) return true;
  if (pt === "clips" || pt === "reels" || pt === "igtv") return true;
  if (node.video_versions || node.video_duration != null) return true;
  if (node.video_versions2?.candidates?.length) return true;
  return false;
}

/** 从 media 节点解析播放次数（Reels 常有 play_count / video_view_count） */
export function extractIgPlayCount(node) {
  const candidates = [
    node.play_count,
    node.video_view_count,
    node.view_count,
    node.ig_play_count,
    node.video_play_count,
    node?.clips_metadata?.play_count,
    node?.clips_metadata?.viewer_count,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * 对齐 TikTok profile videos 结构，供 merge + LLM 使用
 */
export function mapIgMediaToProfileVideo(node, username) {
  const mapped = mapIgMediaToSearchPost(node);
  const playCount = extractIgPlayCount(node);
  const handle = String(username || mapped.username || "").replace(/^@/, "");
  return {
    videoId: String(mapped.pk || mapped.postCode || ""),
    videoUrl:
      mapped.postUrl ||
      postUrlFromCode(mapped.postCode, 2, node.product_type),
    username: handle || mapped.username,
    description: mapped.description,
    caption: mapped.description,
    views: {
      count: playCount,
      display: formatIgNumber(playCount),
    },
    likes: mapped.likes,
    comments: mapped.comments,
    shares: null,
    favorites: null,
    mediaType: "reel",
    thumbnail: mapped.thumbnail,
    postedTime: node.taken_at
      ? new Date(Number(node.taken_at) * 1000).toISOString()
      : node.device_timestamp
        ? new Date(Number(node.device_timestamp)).toISOString()
        : null,
  };
}

/**
 * 近 N 条视频统计（均播仅统计 views.count > 0 的 Reels，与 TikTok 播放量均值口径一致）
 */
export function computeIgVideoStatistics(videos = []) {
  const list = Array.isArray(videos) ? videos : [];
  const withViews = list.filter((v) => (v.views?.count || 0) > 0);
  const validEngagement = list.filter(
    (v) =>
      (v.views?.count > 0) ||
      (v.likes?.count > 0) ||
      (v.comments?.count > 0)
  );
  const avgFrom = (subset, getter) => {
    if (!subset.length) return null;
    const sum = subset.reduce((s, v) => s + (getter(v) || 0), 0);
    return Math.round(sum / subset.length);
  };
  return {
    videoCount: list.length,
    reelCount: list.filter((v) => v.mediaType === "reel").length,
    videosWithPlayCount: withViews.length,
    avgViews: avgFrom(withViews, (v) => v.views?.count),
    avgLikes: avgFrom(validEngagement, (v) => v.likes?.count),
    avgComments: avgFrom(validEngagement, (v) => v.comments?.count),
    avgFavorites: null,
  };
}

/** 将单条 media 并入 Reels Map（去重） */
export function mergeIgReelIntoMap(videoMap, node, username) {
  const handle = String(username || "").replace(/^@/, "").toLowerCase();
  const owner = (node.user?.username || node.owner?.username || "")
    .toString()
    .toLowerCase();
  if (owner && owner !== handle) return false;
  if (!isIgReelMedia(node)) return false;
  const video = mapIgMediaToProfileVideo(node, handle);
  const key = video.videoId || video.videoUrl;
  if (!key || videoMap.has(key)) return false;
  videoMap.set(key, video);
  return true;
}

/** 从 GraphQL 响应中探测 Reels 是否还有更多页 */
export function extractReelsPaginationHints(json) {
  let moreAvailable = null;
  let maxId = null;
  const walk = (obj, depth = 0) => {
    if (depth > 14 || !obj || typeof obj !== "object") return;
    if (typeof obj.more_available === "boolean") {
      moreAvailable = obj.more_available;
    }
    if (obj.max_id != null && maxId == null) {
      maxId = String(obj.max_id);
    }
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  return { moreAvailable, maxId };
}

/** 按 media pk 降序（通常较新在前） */
export function sortIgVideosByPkDesc(videos = []) {
  return [...videos].sort((a, b) => {
    const pa = BigInt(String(a.videoId || "0"));
    const pb = BigInt(String(b.videoId || "0"));
    if (pa > pb) return -1;
    if (pa < pb) return 1;
    return 0;
  });
}

export function mapIgMediaToSearchPost(node) {
  const code = node.code || node.shortcode;
  const username = node.user?.username || node.owner?.username || null;
  const mediaType = node.media_type ?? node.product_type;
  const postUrl = postUrlFromCode(code, mediaType, node.product_type);
  const likeCount =
    node.like_count ??
    node.edge_liked_by?.count ??
    node.edge_media_preview_like?.count ??
    0;
  const commentCount = node.comment_count ?? node.edge_media_to_comment?.count ?? 0;
  const caption =
    typeof node.caption === "string"
      ? node.caption
      : node.caption?.text ?? node.edge_media_to_caption?.edges?.[0]?.node?.text ?? "";

  return {
    postCode: code,
    postUrl,
    mediaType:
      mediaType === 2 || node.product_type === "clips" ? "reel" : "post",
    username,
    likes: { count: Number(likeCount) || 0, display: formatIgNumber(likeCount) },
    comments: {
      count: Number(commentCount) || 0,
      display: formatIgNumber(commentCount),
    },
    description: caption ? String(caption).slice(0, 500) : null,
    thumbnail:
      node.image_versions2?.candidates?.[0]?.url ||
      node.display_url ||
      node.thumbnail_src ||
      null,
    pk: node.pk || node.id || null,
  };
}

export function mapIgUserToUserInfo(user) {
  if (!user) return null;
  const followersRaw =
    user.edge_followed_by?.count ??
    user.follower_count ??
    user.followers_count ??
    0;
  const followingRaw =
    user.edge_follow?.count ?? user.following_count ?? 0;
  const postsRaw =
    user.edge_owner_to_timeline_media?.count ??
    user.media_count ??
    user.post_count ??
    0;

  return {
    username: user.username,
    displayName: user.full_name || user.username,
    avatarUrl:
      user.profile_pic_url_hd ||
      user.profile_pic_url ||
      user.hd_profile_pic_url_info?.url ||
      "",
    bio: user.biography || "",
    email: user.public_email || user.business_email || null,
    userId: user.pk || user.id ? String(user.pk || user.id) : null,
    verified: !!(user.is_verified || user.is_verified_badge),
    followers: {
      count: Number(followersRaw) || 0,
      display: formatIgNumber(followersRaw),
    },
    following: {
      count: Number(followingRaw) || 0,
      display: formatIgNumber(followingRaw),
    },
    postsCount: {
      count: Number(postsRaw) || 0,
      display: formatIgNumber(postsRaw),
    },
  };
}
