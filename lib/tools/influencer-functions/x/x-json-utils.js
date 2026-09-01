/**
 * X (Twitter) GraphQL JSON 解析工具。
 * 参考 2026-06 x-relay ENGINE-RESEARCH：X 自 2026-05 起部分响应 legacy:null，
 * 解析需「子对象优先 + legacy 兜底」，并用深搜收集 __typename 节点（防布局漂移）。
 */

const TWEET_TYPENAMES = new Set(["Tweet", "TweetWithVisibilityResults", "TweetUnavailable"]);

function collectTweetAuthorUser(node, seenUsers, users) {
  const authorResult = node?.core?.user_results?.result || node?.user_results?.result || null;
  if (!authorResult || authorResult.__typename !== "User") return;
  const aid = String(authorResult.rest_id || authorResult.id_str || "");
  if (aid && !seenUsers.has(aid)) {
    seenUsers.add(aid);
    users.push({ id: aid, result: authorResult });
  }
}

/**
 * 深搜收集所有 Tweet/User 节点，返回按出现顺序去重后的扁平结果。
 * @param {unknown} root
 * @returns {{ tweets: Array<{id: string, result: object}>, users: Array<{id: string, result: object}> }}
 */
export function collectTypedNodes(root) {
  const tweets = [];
  const users = [];
  const seenTweets = new Set();
  const seenUsers = new Set();
  const stack = [root];
  let guard = 0;
  while (stack.length && guard < 2_000_000) {
    guard += 1;
    const node = stack.pop();
    if (node == null || typeof node !== "object") continue;
    const tn = node.__typename;
    if (tn === "Tweet") {
      const id = String(node.rest_id || node.id_str || "");
      if (id && !seenTweets.has(id)) {
        seenTweets.add(id);
        tweets.push({ id, result: node });
      }
      // Tweet 内部不再下钻，但作者 user 单独收集（供搜索去重）
      collectTweetAuthorUser(node, seenUsers, users);
      continue;
    }
    if (tn === "TweetWithVisibilityResults" && node.tweet && typeof node.tweet === "object") {
      const id = String(node.tweet.rest_id || node.tweet.id_str || "");
      if (id && !seenTweets.has(id)) {
        seenTweets.add(id);
        tweets.push({ id, result: node.tweet });
      }
      collectTweetAuthorUser(node.tweet, seenUsers, users);
      continue;
    }
    if (tn === "User") {
      const id = String(node.rest_id || node.id_str || "");
      if (id && !seenUsers.has(id)) {
        seenUsers.add(id);
        users.push({ id, result: node });
        continue; // 真实 User 记录不继续下钻
      }
      // 无 id 的 User 壳（如 UserOriginalsTimeline 顶层 data.user.result 包装节点）
      // 继续下钻，否则整个 timeline 里的推文会遍历不到
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return { tweets, users };
}

function pickFirst(...values) {
  for (const v of values) {
    if (v != null && v !== "") return v;
  }
  return null;
}

function textFromRuns(runs) {
  if (runs == null) return "";
  if (typeof runs === "string") return runs;
  if (typeof runs.simpleText === "string") return runs.simpleText;
  if (Array.isArray(runs)) return runs.map((r) => (r && r.text) || "").join("");
  if (runs.runs) return textFromRuns(runs.runs);
  return "";
}

function firstUrlFromEntitiesUrl(urls) {
  if (!Array.isArray(urls) || !urls.length) return null;
  const u = urls[0];
  return pickFirst(u?.expanded_url, u?.url, u?.display_url);
}

/** 从 entities.description.urls / description.urls 里取第一个外链 */
function descriptionUrlFromUser(user) {
  const legacyEntities = user?.legacy?.entities?.description?.urls;
  const urlEntities = user?.entities?.description?.urls;
  const url = pickFirst(
    firstUrlFromEntitiesUrl(urlEntities),
    firstUrlFromEntitiesUrl(legacyEntities)
  );
  return url || null;
}

/**
 * 归一化 User 结果（子对象优先 + legacy 兜底）。
 * @param {object} userResult
 */
export function normalizeXUser(userResult) {
  if (!userResult || typeof userResult !== "object") return null;
  const legacy = userResult.legacy || {};
  const screenName = pickFirst(
    userResult.core?.screen_name,
    userResult.screen_name,
    legacy.screen_name
  );
  if (!screenName) return null;
  const bio = pickFirst(
    textFromRuns(userResult.profile_bio?.description),
    textFromRuns(userResult.bio?.description),
    legacy.description
  );
  const followersRaw = pickFirst(
    userResult.followers_count,
    legacy.followers_count
  );
  return {
    userId: String(userResult.rest_id || userResult.id_str || ""),
    username: String(screenName).replace(/^@/, ""),
    displayName: pickFirst(
      userResult.core?.name,
      userResult.name,
      legacy.name,
      String(screenName).replace(/^@/, "")
    ),
    bio: String(bio || ""),
    followers: {
      count: Number.isFinite(Number(followersRaw)) ? Number(followersRaw) : 0,
      display:
        Number.isFinite(Number(followersRaw)) && Number(followersRaw) > 0
          ? String(followersRaw)
          : "0",
    },
    followingCount: Number(legacy.friends_count) || 0,
    postsCount: Number(legacy.statuses_count) || 0,
    likesCount: Number(legacy.favourites_count) || 0,
    verified: !!(userResult.is_blue_verified || legacy.verified),
    verifiedType: pickFirst(
      userResult.verification?.verified_type,
      legacy.verified_type,
      null
    ),
    avatarUrl: pickFirst(
      userResult.avatar?.image_url,
      legacy.profile_image_url_https,
      legacy.profile_image_url,
      ""
    ),
    // 2026 版响应 legacy.location 已消失，新字段 userResult.location.location；
    // DOM 兜底（parseProfileDom 的 UserLocation）仍会补最后一道。
    location: String(
      pickFirst(
        userResult.location?.location,
        legacy.location,
        ""
      ) || ""
    ),
    website: pickFirst(
      firstUrlFromEntitiesUrl(userResult.entities?.url?.urls),
      firstUrlFromEntitiesUrl(legacy.entities?.url?.urls),
      legacy.url,
      null
    ),
    createdAt: legacy.created_at || null,
    protected: !!(userResult.privacy?.protected ?? legacy.protected),
    isBlueVerified: !!userResult.is_blue_verified,
    profileUrl: `https://x.com/${String(screenName).replace(/^@/, "")}`,
  };
}

/**
 * 归一化 Tweet 结果。
 * @param {object} tweetResult
 */
export function normalizeXTweet(tweetResult) {
  if (!tweetResult || typeof tweetResult !== "object") return null;
  const legacy = tweetResult.legacy || {};
  const id = String(tweetResult.rest_id || tweetResult.id_str || "");
  if (!id) return null;
  const text = pickFirst(
    tweetResult.note_tweet?.note_tweet_results?.result?.text,
    legacy.full_text,
    legacy.text,
    ""
  );
  const viewsRaw = pickFirst(
    tweetResult.views?.count,
    tweetResult.ext_views?.count,
    legacy.ext_views?.count
  );
  const userResult =
    tweetResult.core?.user_results?.result || tweetResult.user_results?.result || null;
  const author = userResult ? normalizeXUser(userResult) : null;
  const media = Array.isArray(legacy.extended_entities?.media)
    ? legacy.extended_entities.media
    : Array.isArray(legacy.entities?.media)
      ? legacy.entities.media
      : [];
  const mediaTypes = [...new Set(media.map((m) => m.type).filter(Boolean))];
  const isVideo = mediaTypes.includes("video") || mediaTypes.includes("animated_gif");
  const isPhoto = mediaTypes.includes("photo");
  return {
    tweetId: id,
    text: String(text || ""),
    createdAt: legacy.created_at || null,
    likes: Number(legacy.favorite_count) || 0,
    retweets: Number(legacy.retweet_count) || 0,
    replies: Number(legacy.reply_count) || 0,
    quotes: Number(legacy.quote_count) || 0,
    views: Number.isFinite(Number(viewsRaw)) ? Number(viewsRaw) : 0,
    lang: legacy.lang || null,
    mediaTypes,
    mediaType: isVideo ? "video" : isPhoto ? "photo" : "text",
    author,
    url: author?.username ? `https://x.com/${author.username}/status/${id}` : null,
  };
}

/**
 * 从 timeline JSON 提取 Bottom cursor（供翻页）。
 * @param {unknown} root
 * @returns {string|null}
 */
export function extractTimelineBottomCursor(root) {
  const instructions =
    root?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
    root?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
    root?.data?.user?.result?.timeline?.timeline?.instructions ||
    [];
  let bottom = null;
  let top = null;
  const walk = (node) => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.entryType === "TimelineTimelineCursor" || node.__typename === "TimelineTimelineCursor") {
      if (node.cursorType === "Bottom" && node.value) bottom = node.value;
      if (node.cursorType === "Top" && node.value) top = node.value;
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk({ instructions });
  return bottom || top || null;
}

/**
 * 从 SearchTimeline JSON 提取红人（推文作者 + People 独立用户），按出现顺序去重。
 * @param {unknown} json
 * @returns {{ users: Array<object>, tweets: Array<object> }}
 */
export function extractSearchUsersFromJson(json) {
  const { tweets, users } = collectTypedNodes(json);
  const userMap = new Map();
  const ordered = [];
  const pushUser = (u) => {
    const raw = u?.result || u;
    // 已归一化对象（来自推文作者）直接使用；原始结果走 normalizeXUser
    const norm =
      raw && typeof raw === "object" && !raw.__typename && raw.username && raw.profileUrl
        ? raw
        : normalizeXUser(raw);
    if (!norm?.username) return;
    const key = String(norm.userId || norm.username).toLowerCase();
    if (!userMap.has(key)) {
      userMap.set(key, norm);
      ordered.push(norm);
    }
  };
  for (const tweet of tweets) {
    const norm = normalizeXTweet(tweet.result);
    if (norm?.author) pushUser({ result: norm.author });
  }
  for (const user of users) pushUser(user);
  const tweetRecords = tweets
    .map((t) => normalizeXTweet(t.result))
    .filter(Boolean);
  return { users: ordered, tweets: tweetRecords };
}

/**
 * 从 UserTweets / UserByScreenName 响应提取推文。
 * @param {unknown} json
 */
export function extractUserTweetsFromJson(json) {
  const { tweets } = collectTypedNodes(json);
  return tweets.map((t) => normalizeXTweet(t.result)).filter(Boolean);
}

/** 从 UserByScreenName 响应提取用户 */
export function extractUserFromUserByScreenName(json) {
  const user = json?.data?.user?.result;
  if (!user || typeof user !== "object") return null;
  return normalizeXUser(user);
}

/** 计算推文互动统计（供 LLM 画像分析样本，对齐 YT 视频统计口径） */
export function computeXTweetStatistics(tweets = []) {
  if (!tweets.length) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, avgRetweets: 0, sampleCount: 0 };
  }
  const sum = (fn) =>
    tweets.reduce((acc, t) => acc + (Number(fn(t)) || 0), 0);
  return {
    avgViews: Math.round(sum((t) => t.views) / tweets.length),
    avgLikes: Math.round(sum((t) => t.likes) / tweets.length),
    avgComments: Math.round(sum((t) => t.replies) / tweets.length),
    avgRetweets: Math.round(sum((t) => t.retweets) / tweets.length),
    sampleCount: tweets.length,
  };
}

/** 把推文映射为 search_video_data 形状（保持与其它平台管道一致） */
export function mapXTweetToSearchClip(tweet, author) {
  if (!tweet?.tweetId) return null;
  const u = author || tweet.author || {};
  return {
    videoId: tweet.tweetId,
    videoUrl: tweet.url || (u.username ? `https://x.com/${u.username}/status/${tweet.tweetId}` : null),
    description: tweet.text,
    views: tweet.views || 0,
    likes: tweet.likes || 0,
    comments: tweet.replies || 0,
    retweets: tweet.retweets || 0,
    createdAt: tweet.createdAt,
    mediaType: tweet.mediaType || "tweet",
    mediaTypes: tweet.mediaTypes || [],
  };
}
