/**
 * 从推荐红人 profile 视频中规则提取 #tag / @mention 信号。
 */

const NOISE_HASHTAGS = new Set([
  "#fyp",
  "#foryou",
  "#foryoupage",
  "#viral",
  "#trending",
  "#ad",
  "#sponsored",
  "#tiktok",
  "#tiktokshop",
  "#duet",
  "#stitch",
  "#explore",
  "#reels",
  "#reelsinstagram",
  "#instagram",
  "#youtube",
  "#shorts",
  "#capcut",
]);

function normalizeHashtag(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const withHash = s.startsWith("#") ? s : `#${s.replace(/^#+/, "")}`;
  const body = withHash.slice(1);
  if (!/^[\w\u4e00-\u9fa5]+$/.test(body)) return null;
  return withHash.toLowerCase();
}

function normalizeMention(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const withAt = s.startsWith("@") ? s : `@${s.replace(/^@+/, "")}`;
  const body = withAt.slice(1);
  if (!/^[\w.]+$/.test(body)) return null;
  return withAt;
}

function collectBrandTerms(productInfo = {}) {
  const terms = new Set();
  const add = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s) terms.add(s);
  };
  add(productInfo.brandName);
  add(productInfo.brand);
  add(productInfo.productName);
  if (Array.isArray(productInfo.brandAliases)) {
    for (const x of productInfo.brandAliases) add(x);
  }
  return terms;
}

function isOwnBrandSignal(value, brandTerms) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[@#]/, "");
  if (!key) return false;
  for (const term of brandTerms) {
    if (!term) continue;
    if (key === term || key.includes(term)) return true;
  }
  return false;
}

function parseTagsFromDescription(desc) {
  const hashtags = [];
  const mentions = [];
  const text = String(desc || "");
  if (!text) return { hashtags, mentions };

  const tagMatches = text.match(/#[\w\u4e00-\u9fa5]+/g) || [];
  for (const raw of tagMatches) {
    const tag = normalizeHashtag(raw);
    if (tag) hashtags.push(tag);
  }

  const mentionMatches = text.match(/@[\w.]+/g) || [];
  for (const raw of mentionMatches) {
    const mention = normalizeMention(raw);
    if (mention) mentions.push(mention);
  }

  return { hashtags, mentions };
}

function collectVideosFromInfluencer(influencer = {}) {
  const profile = influencer.profile_data || influencer.profileData || {};
  const lists = [
    profile.videos,
    profile.videoList,
    profile.posts,
    profile.reels,
    influencer.videos,
  ].filter(Array.isArray);

  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const video of list) {
      if (!video || typeof video !== "object") continue;
      const id = String(video.videoId || video.id || video.shortcode || "").trim();
      const key = id || JSON.stringify(video).slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(video);
      if (out.length >= 50) return out;
    }
  }
  return out;
}

/**
 * @param {object} influencer
 * @param {object} [productInfo]
 * @returns {{ hashtags: string[], mentions: string[] }}
 */
export function extractKeywordSignalsFromInfluencer(influencer = {}, productInfo = {}) {
  const brandTerms = collectBrandTerms(productInfo);
  const hashtagSet = new Set();
  const mentionSet = new Set();
  const videos = collectVideosFromInfluencer(influencer);

  for (const video of videos) {
    const arrayTags = Array.isArray(video.hashtags) ? video.hashtags : [];
    for (const raw of arrayTags) {
      const tag = normalizeHashtag(raw);
      if (tag && !NOISE_HASHTAGS.has(tag) && !isOwnBrandSignal(tag, brandTerms)) {
        hashtagSet.add(tag);
      }
    }

    const arrayMentions = Array.isArray(video.mentions) ? video.mentions : [];
    for (const raw of arrayMentions) {
      const mention = normalizeMention(raw);
      if (mention && !isOwnBrandSignal(mention, brandTerms)) {
        mentionSet.add(mention);
      }
    }

    const desc = video.description || video.caption || video.desc || "";
    const parsed = parseTagsFromDescription(desc);
    for (const tag of parsed.hashtags) {
      if (!NOISE_HASHTAGS.has(tag) && !isOwnBrandSignal(tag, brandTerms)) {
        hashtagSet.add(tag);
      }
    }
    for (const mention of parsed.mentions) {
      if (!isOwnBrandSignal(mention, brandTerms)) {
        mentionSet.add(mention);
      }
    }
  }

  return {
    hashtags: Array.from(hashtagSet),
    mentions: Array.from(mentionSet),
  };
}

export { normalizeHashtag, normalizeMention, NOISE_HASHTAGS };
