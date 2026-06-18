/**
 * Instagram GraphQL / API JSON 解析工具（搜索与主页共用）
 */

import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";
import { normalizeInfluencerCountryToIso } from "../../../influencer/campaign-country-codes.js";

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
  if (!node || typeof node !== "object") return 0;
  const nested = node.media && typeof node.media === "object" ? node.media : null;
  const candidates = [
    node.play_count,
    node.video_view_count,
    node.view_count,
    node.ig_play_count,
    node.video_play_count,
    node?.clips_metadata?.play_count,
    node?.clips_metadata?.viewer_count,
    nested?.play_count,
    nested?.video_view_count,
    nested?.view_count,
    nested?.ig_play_count,
    nested?.video_play_count,
    nested?.clips_metadata?.play_count,
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

function mergeIgVideoFields(existing, incoming) {
  if (!existing || !incoming) return incoming || existing;
  const out = { ...existing };
  if ((incoming.views?.count || 0) > (out.views?.count || 0)) {
    out.views = incoming.views;
  }
  if ((incoming.likes?.count || 0) > (out.likes?.count || 0)) {
    out.likes = incoming.likes;
  }
  if ((incoming.comments?.count || 0) > (out.comments?.count || 0)) {
    out.comments = incoming.comments;
  }
  const desc = incoming.description || incoming.caption;
  if (desc && !(out.description || out.caption)) {
    out.description = desc;
    out.caption = desc;
  }
  return out;
}

/** 将单条 media 并入 Reels Map（去重，保留更高互动字段） */
export function mergeIgReelIntoMap(videoMap, node, username) {
  const handle = String(username || "").replace(/^@/, "").toLowerCase();
  const mediaNode = node?.media && typeof node.media === "object" ? node.media : node;
  const owner = (mediaNode.user?.username || mediaNode.owner?.username || "")
    .toString()
    .toLowerCase();
  if (owner && owner !== handle) return false;
  if (!isIgReelMedia(mediaNode)) return false;
  const video = mapIgMediaToProfileVideo(mediaNode, handle);
  const key = video.videoId || video.videoUrl;
  if (!key) return false;
  if (videoMap.has(key)) {
    videoMap.set(key, mergeIgVideoFields(videoMap.get(key), video));
    return false;
  }
  videoMap.set(key, video);
  return true;
}

/** 从 clips GraphQL / REST 响应提取 Reels media 节点 */
export function extractClipsMediaFromJson(json) {
  const nodes = [];
  const conn = json?.data?.xdt_api__v1__clips__user__connection_v2;
  if (conn?.edges?.length) {
    for (const edge of conn.edges) {
      const media = edge?.node?.media || edge?.node;
      if (media && typeof media === "object") nodes.push(media);
    }
  }
  if (Array.isArray(json?.items)) {
    for (const item of json.items) {
      if (item && typeof item === "object") nodes.push(item);
    }
  }
  if (!nodes.length) {
    return extractMediaNodesFromJson(json).filter(isIgReelMedia);
  }
  const seen = new Set();
  return nodes.filter((n) => {
    const key = String(n.pk || n.id || n.code || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return isIgReelMedia(n);
  });
}

/** GraphQL / REST clips 响应是否含可用 Reels 节点 */
export function isUsableIgClipsJson(json) {
  if (!json || typeof json !== "object") return false;
  return extractClipsMediaFromJson(json).length > 0;
}

/** 从 GraphQL 响应中探测 Reels 是否还有更多页 */
export function extractReelsPaginationHints(json) {
  const conn = json?.data?.xdt_api__v1__clips__user__connection_v2;
  const pageInfo = conn?.page_info || json?.paging_info;
  let moreAvailable = null;
  let maxId = null;

  if (pageInfo) {
    if (typeof pageInfo.more_available === "boolean") {
      moreAvailable = pageInfo.more_available;
    }
    if (typeof pageInfo.has_next_page === "boolean") {
      moreAvailable = pageInfo.has_next_page;
    }
    if (pageInfo.max_id != null) maxId = String(pageInfo.max_id);
    if (pageInfo.end_cursor != null && maxId == null) maxId = String(pageInfo.end_cursor);
  }

  const walk = (obj, depth = 0) => {
    if (depth > 14 || !obj || typeof obj !== "object") return;
    if (moreAvailable == null && typeof obj.more_available === "boolean") {
      moreAvailable = obj.more_available;
    }
    if (moreAvailable == null && typeof obj.has_next_page === "boolean") {
      moreAvailable = obj.has_next_page;
    }
    if (maxId == null && obj.max_id != null) maxId = String(obj.max_id);
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  if (moreAvailable == null || maxId == null) walk(json);
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
    email:
      user.public_email ||
      user.business_email ||
      extractEmailFromBio(user.biography) ||
      null,
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

/**
 * 深度扫描 user / profile JSON 中的 country_code
 * @param {object|null|undefined} root
 * @param {string} [username]
 */
export function extractIgCountryFromUserDeep(root, username = "") {
  if (!root || typeof root !== "object") return null;
  const handle = String(username || "").replace(/^@/, "").toLowerCase();
  const hits = [];
  const walk = (obj, depth = 0) => {
    if (depth > 14 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (
        (k === "country_code" || k === "countryCode" || k === "account_country") &&
        v != null &&
        v !== ""
      ) {
        hits.push(String(v).trim());
      } else if (typeof v === "object" && v) {
        walk(v, depth + 1);
      }
    }
  };
  walk(root);
  if (handle) {
    const user = extractUserNodesFromJson(root, handle);
    if (user?.country_code) hits.unshift(String(user.country_code).trim());
  }
  for (const raw of hits) {
    const iso = normalizeInfluencerCountryToIso(raw);
    if (iso) return { countryRaw: raw, videoPublishCountry: iso, source: "profile_api_deep" };
  }
  return null;
}

/**
 * 从简介文本推断国家（轻量规则，避免 About 弹窗）
 * @param {string|null|undefined} bio
 */
export function inferIgCountryFromBio(bio) {
  const text = String(bio || "").trim();
  if (!text) return null;
  const patterns = [
    /(?:based in|located in|living in|📍)\s*([^|\n]+)/i,
    /\b(USA|U\.S\.A\.|United States|UK|United Kingdom|Canada|Australia|Germany|France|Italy|Spain|Japan|Korea|Singapore|Mexico|Brazil|India)\b/i,
    /\b([A-Za-z .]{2,40},\s*(?:CA|NY|TX|FL|WA|USA|US|UK))\b/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    const candidate = (m?.[1] || m?.[0] || "").trim();
    if (!candidate) continue;
    const iso = normalizeInfluencerCountryToIso(candidate);
    if (iso) {
      return { countryRaw: candidate, videoPublishCountry: iso, source: "bio_infer" };
    }
  }
  return null;
}

/**
 * 从 Reels/clips GraphQL 批次里读 owner.country_code
 * @param {object[]} batches
 * @param {string} username
 */
export function extractIgCountryFromClipsBatches(batches, username) {
  const handle = String(username || "").replace(/^@/, "").toLowerCase();
  if (!handle || !Array.isArray(batches)) return null;
  for (const json of batches) {
    for (const media of extractClipsMediaFromJson(json)) {
      const owner = media.user || media.owner || null;
      const ownerHandle = String(owner?.username || "").replace(/^@/, "").toLowerCase();
      if (ownerHandle && ownerHandle !== handle) continue;
      const raw =
        owner?.country_code ||
        owner?.account_country ||
        media?.location?.short_name ||
        null;
      const iso = normalizeInfluencerCountryToIso(raw);
      if (iso) {
        return { countryRaw: raw, videoPublishCountry: iso, source: "clips_owner" };
      }
    }
    const deep = extractIgCountryFromUserDeep(json, username);
    if (deep?.videoPublishCountry) return { ...deep, source: "clips_graphql_deep" };
  }
  return null;
}
