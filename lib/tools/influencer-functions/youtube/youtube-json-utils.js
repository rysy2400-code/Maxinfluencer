/**
 * YouTube innertube / browse / search JSON 解析（搜索与 /videos 共用）
 */

import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";

export function formatYtNumber(num) {
  if (typeof num === "string") return num;
  const n = Number(num) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function parseYtViewCount(textOrObj) {
  if (textOrObj == null) return 0;
  if (typeof textOrObj === "object" && textOrObj.simpleText) {
    return parseYtViewCount(textOrObj.simpleText);
  }
  if (typeof textOrObj === "object" && textOrObj.runs?.[0]?.text) {
    return parseYtViewCount(textOrObj.runs[0].text);
  }
  const s = String(textOrObj).trim().replace(/,/g, "");
  if (!s || s === "no views") return 0;
  // 支持中文单位：万
  const mCN = s.match(/([\d.]+)\s*万/);
  if (mCN) return Math.round(parseFloat(mCN[1]) * 10000);
  const sl = s.toLowerCase();
  const m = sl.match(/^([\d.]+)\s*([kmb])?/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const u = m[2];
  if (u === "k") n *= 1000;
  else if (u === "m") n *= 1_000_000;
  else if (u === "b") n *= 1_000_000_000;
  return Math.round(n);
}

export function isYoutubeInnertubeUrl(url) {
  const u = String(url || "");
  if (!u.includes("youtube.com")) return false;
  return (
    u.includes("/youtubei/") ||
    u.includes("/search?") ||
    u.includes("/browse?") ||
    u.includes("/next?") ||
    u.includes("/player?")
  );
}

function navigationBrowseId(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return null;
  const be = endpoint.browseEndpoint || endpoint.browseId ? endpoint : null;
  const id =
    endpoint.browseEndpoint?.browseId ||
    endpoint.browseId ||
    be?.browseId ||
    null;
  if (id && String(id).startsWith("UC")) return String(id);
  return null;
}

function handleFromCanonicalUrl(url) {
  const s = String(url || "");
  const m = s.match(/\/@([a-zA-Z0-9._-]+)/);
  return m ? m[1] : null;
}

function textFromRuns(runs) {
  if (!runs) return "";
  if (typeof runs === "string") return runs;
  if (Array.isArray(runs)) {
    return runs.map((r) => r?.text || "").join("").trim();
  }
  if (runs.simpleText) return String(runs.simpleText).trim();
  return "";
}

/**
 * 从 videoRenderer 提取所属频道（搜索「视频」Tab）
 */
export function channelFromVideoRenderer(vr) {
  if (!vr || typeof vr !== "object") return null;
  const channelId =
    vr.channelId ||
    navigationBrowseId(vr.owner?.navigationEndpoint) ||
    navigationBrowseId(vr.longBylineText?.runs?.[0]?.navigationEndpoint) ||
    navigationBrowseId(vr.shortBylineText?.runs?.[0]?.navigationEndpoint);
  const ownerRuns =
    vr.ownerText?.runs ||
    vr.longBylineText?.runs ||
    vr.shortBylineText?.runs ||
    [];
  let handle = null;
  let displayName = null;
  for (const run of ownerRuns) {
    const t = run?.text?.trim();
    if (!t) continue;
    if (t.startsWith("@")) handle = t.replace(/^@/, "");
    else if (!displayName) displayName = t;
    const url = run?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
    const h = handleFromCanonicalUrl(url);
    if (h) handle = h;
    if (!channelId) {
      const bid = navigationBrowseId(run?.navigationEndpoint);
      if (bid) return { channelId: bid, handle, displayName: displayName || handle };
    }
  }
  if (!channelId && !handle) return null;
  return {
    channelId: channelId || null,
    handle: handle || null,
    displayName: displayName || handle || channelId,
  };
}

/**
 * 从 channelRenderer 提取频道
 */
export function channelFromChannelRenderer(cr) {
  if (!cr || typeof cr !== "object") return null;
  const channelId =
    cr.channelId ||
    navigationBrowseId(cr.navigationEndpoint) ||
    navigationBrowseId(cr.title?.runs?.[0]?.navigationEndpoint);
  const handle =
    handleFromCanonicalUrl(
      cr.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
        cr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer
          ?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url
    ) || null;
  const displayName =
    textFromRuns(cr.title?.runs || cr.title) || handle || channelId;
  if (!channelId && !handle) return null;
  return { channelId, handle, displayName };
}

/**
 * 递归收集搜索阶段的 videoRenderer / channelRenderer
 */
export function extractSearchRenderersFromJson(json) {
  const videos = [];
  const channels = [];
  const walk = (obj, depth = 0) => {
    if (depth > 22 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (obj.videoRenderer) {
      videos.push(obj.videoRenderer);
      walk(obj.videoRenderer, depth + 1);
    }
    if (obj.gridVideoRenderer) {
      videos.push(obj.gridVideoRenderer);
    }
    if (obj.channelRenderer) {
      channels.push(obj.channelRenderer);
    }
    if (obj.reelItemRenderer || obj.shortsLockupViewModel) {
      return;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  return { videos, channels };
}

export function buildChannelProfileUrl(handle, channelId) {
  const h = String(handle || "").replace(/^@/, "").trim();
  if (h) return `https://www.youtube.com/@${encodeURIComponent(h)}/videos`;
  const id = String(channelId || "").trim();
  if (id.startsWith("UC")) {
    return `https://www.youtube.com/channel/${id}/videos`;
  }
  return null;
}

export function buildChannelPublicUrl(handle, channelId) {
  const h = String(handle || "").replace(/^@/, "").trim();
  if (h) return `https://www.youtube.com/@${encodeURIComponent(h)}`;
  const id = String(channelId || "").trim();
  if (id.startsWith("UC")) return `https://www.youtube.com/channel/${id}`;
  return null;
}

/**
 * @param {Map<string, object>} channelMap keyed by channelId || @handle
 */
export function mergeChannelIntoMap(channelMap, partial, maxChannels) {
  if (!partial) return;
  const channelId = partial.channelId || null;
  const handle = partial.handle ? String(partial.handle).replace(/^@/, "") : null;
  const key = channelId || (handle ? `@${handle.toLowerCase()}` : null);
  if (!key) return;
  if (channelMap.has(key)) return;
  if (channelMap.size >= maxChannels) return;

  const profileUrl = buildChannelPublicUrl(handle, channelId);
  const videosUrl = buildChannelProfileUrl(handle, channelId);
  channelMap.set(key, {
    username: handle || channelId,
    displayName: partial.displayName || handle || channelId,
    profileUrl: profileUrl || videosUrl,
    videosUrl,
    avatarUrl: partial.avatarUrl || "",
    channelId,
    handle,
    followers: partial.followers || { count: 0, display: "0" },
    bio: partial.bio || "",
    verified: !!partial.verified,
    platform: "YouTube",
    userId: channelId,
    search_video_data: [],
  });
}

export function mapVideoRendererToSearchClip(vr, channelRec) {
  const videoId = vr.videoId || vr.navigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;
  const title = textFromRuns(vr.title?.runs || vr.title);
  const views = parseYtViewCount(
    vr.viewCountText?.simpleText ||
      vr.viewCountText?.runs?.[0]?.text ||
      vr.shortViewCountText
  );
  return {
    videoId,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    username: channelRec?.username,
    profileUrl: channelRec?.profileUrl,
    description: title,
    views: { count: views, display: formatYtNumber(views) },
    thumbnail:
      vr.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
      vr.thumbnail?.thumbnails?.[0]?.url ||
      null,
    platform: "YouTube",
  };
}

/**
 * 从 lockupViewModel（新版频道 Grid）提取视频 ID + 统计
 * thumbnail URL 格式：https://i.ytimg.com/vi/<videoId>/hqdefault.jpg
 */
function videoIdFromLockupViewModel(lv) {
  const sources = lv?.contentImage?.thumbnailViewModel?.image?.sources || [];
  for (const s of sources) {
    const m = String(s?.url || "").match(/\/vi\/([a-zA-Z0-9_-]{8,12})\//);
    if (m) return m[1];
  }
  // fallback: overlayMetadata → navigationEndpoint
  const ep = lv?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
  if (ep?.videoId) return ep.videoId;
  return null;
}

function viewsFromLockupViewModel(lv) {
  const meta =
    lv?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel ||
    lv?.metadata?.contentMetadataViewModel;
  for (const row of meta?.metadataRows || []) {
    for (const part of row?.metadataParts || []) {
      const txt = part?.text?.content || part?.text?.simpleText || "";
      if (txt.includes("view") || txt.includes("次") || txt.includes("观看")) {
        return parseYtViewCount(txt);
      }
    }
  }
  return 0;
}

function titleFromLockupViewModel(lv) {
  return (
    lv?.metadata?.lockupMetadataViewModel?.title?.content ||
    lv?.title?.content ||
    lv?.title?.runs?.[0]?.text ||
    ""
  );
}

/**
 * 从 innertube JSON 提取视频（首屏 ytInitialData / browse / next 共用）
 */
export function extractVideosFromInnertubeJson(data) {
  const list = [];
  const seen = new Set();
  const walk = (obj, d = 0) => {
    if (d > 22 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(x => walk(x, d + 1)); return; }
    // 新版 Grid
    if (obj.richItemRenderer?.content?.lockupViewModel) {
      const lv = obj.richItemRenderer.content.lockupViewModel;
      const videoId = videoIdFromLockupViewModel(lv);
      if (videoId && !seen.has(videoId)) {
        seen.add(videoId);
        const views = viewsFromLockupViewModel(lv);
        list.push({
          videoId,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          description: titleFromLockupViewModel(lv),
          views: { count: views, display: formatYtNumber(views) },
          likes: { count: 0, display: "0" },
          comments: { count: 0, display: "0" },
          thumbnail: lv?.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || null,
        });
      }
      return;
    }
    // 旧版 gridVideoRenderer / videoRenderer
    const vr = obj.videoRenderer || obj.gridVideoRenderer;
    if (vr?.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      const views = parseYtViewCount(
        vr.viewCountText?.simpleText || vr.viewCountText?.runs?.[0]?.text || vr.shortViewCountText
      );
      list.push({
        videoId: vr.videoId,
        videoUrl: `https://www.youtube.com/watch?v=${vr.videoId}`,
        description: textFromRuns(vr.title?.runs || vr.title),
        views: { count: views, display: formatYtNumber(views) },
        likes: { count: 0, display: "0" },
        comments: { count: 0, display: "0" },
        thumbnail: vr.thumbnail?.thumbnails?.slice(-1)[0]?.url || null,
      });
      return;
    }
    for (const v of Object.values(obj)) { if (typeof v === "object" && v) walk(v, d + 1); }
  };
  walk(data);
  return list;
}

/**
 * 从 ytInitialData（频道页）提取 pageHeaderViewModel 频道头部信息
 */
export function extractChannelHeaderFromYtInitialData(data, handleHint) {
  let hdrVm = null;
  let metaVm = null;
  const walk = (obj, d = 0) => {
    if (d > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(x => walk(x, d + 1)); return; }
    if (obj.pageHeaderViewModel && !hdrVm) hdrVm = obj.pageHeaderViewModel;
    if (obj.channelMetadataRenderer && !metaVm) metaVm = obj.channelMetadataRenderer;
    if (obj.c4TabbedHeaderRenderer && !metaVm) metaVm = obj.c4TabbedHeaderRenderer;
    for (const v of Object.values(obj)) { if (typeof v === "object" && v) walk(v, d + 1); }
  };
  walk(data);

  const target = String(handleHint || "").replace(/^@/, "").toLowerCase();
  const displayName =
    hdrVm?.title?.dynamicTextViewModel?.text?.content ||
    textFromRuns(metaVm?.title?.runs || metaVm?.title) ||
    target;

  const channelId =
    metaVm?.externalId ||
    metaVm?.channelId ||
    null;

  const avatarUrl =
    hdrVm?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.slice(-1)[0]?.url ||
    metaVm?.avatar?.thumbnails?.slice(-1)[0]?.url ||
    "";

  // subscriber count from metadata rows in pageHeaderViewModel
  let subCount = 0;
  const metaRows = hdrVm?.metadata?.contentMetadataViewModel?.metadataRows || [];
  for (const row of metaRows) {
    for (const part of row?.metadataParts || []) {
      const txt = part?.text?.content || part?.text?.simpleText || "";
      if (txt.includes("subscriber") || txt.includes("订阅")) {
        const n = parseYtViewCount(txt);
        if (n > subCount) subCount = n;
      }
    }
  }
  if (!subCount) {
    const subText = metaVm?.subscriberCountText?.simpleText || textFromRuns(metaVm?.subscriberCountText?.runs) || "0";
    subCount = parseYtViewCount(subText);
  }

  const bio = textFromRuns(metaVm?.description?.runs || metaVm?.description) || "";
  const handle =
    handleFromCanonicalUrl(metaVm?.vanityChannelUrl || metaVm?.channelUrl) ||
    target ||
    displayName.replace(/^@/, "");

  return {
    username: handle,
    displayName,
    channelId,
    bio,
    email: extractEmailFromBio(bio) || null,
    country: null, // country read from /about page separately
    avatarUrl,
    verified: !!(metaVm?.badges?.length || metaVm?.isVerified),
    followers: { count: subCount, display: formatYtNumber(subCount) },
  };
}

/**
 * /about 页 aboutChannelViewModel 中的订阅数
 */
export function extractSubscriberFromAboutViewModel(aboutMeta) {
  if (!aboutMeta || typeof aboutMeta !== "object") return null;
  const subText =
    (typeof aboutMeta.subscriberCountText === "string"
      ? aboutMeta.subscriberCountText
      : null) ||
    aboutMeta.subscriberCountText?.content ||
    aboutMeta.subscriberCountText?.simpleText ||
    textFromRuns(aboutMeta.subscriberCountText?.runs);
  if (!subText) return null;
  const n = parseYtViewCount(subText);
  if (!n) return null;
  return { count: n, display: formatYtNumber(n) };
}

/** 从任意 innertube JSON 尝试解析频道头部（含 browse 响应内的 pageHeaderViewModel） */
export function extractChannelHeaderFromInnertubeJson(json, handleHint) {
  if (!json) return null;
  const fromInitial = extractChannelHeaderFromYtInitialData(json, handleHint);
  if (fromInitial?.followers?.count > 0) return fromInitial;
  return extractChannelHeaderFromBrowseJson(json, handleHint) || fromInitial;
}

/** @deprecated 使用 extractVideosFromInnertubeJson */
export function extractVideosFromYtInitialData(data) {
  return extractVideosFromInnertubeJson(data);
}

/**
 * 频道 browse/next API：与 ytInitialData 同一解析器（含 lockupViewModel）
 */
export function extractVideosFromBrowseJson(json) {
  return extractVideosFromInnertubeJson(json);
}

export function extractChannelHeaderFromBrowseJson(json, handleHint) {
  let user = null;
  const target = String(handleHint || "")
    .replace(/^@/, "")
    .toLowerCase();
  const walk = (obj, depth = 0) => {
    if (depth > 22 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    const meta =
      obj.channelMetadataRenderer ||
      obj.c4TabbedHeaderRenderer ||
      obj.pageHeaderRenderer?.content?.pageHeaderViewModel;
    if (meta && !user) user = meta;
    if (obj.aboutChannelRenderer || obj.aboutChannelViewModel) {
      if (!user) user = obj;
      else user._about = obj.aboutChannelRenderer || obj.aboutChannelViewModel;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);

  const header = user?.channelMetadataRenderer || user?.c4TabbedHeaderRenderer || user;
  if (!header && !user) return null;

  const channelId =
    header?.externalId ||
    header?.channelId ||
    navigationBrowseId(header?.navigationEndpoint) ||
    null;
  const vanity = header?.vanityChannelUrl || header?.channelUrl;
  const handle =
    handleFromCanonicalUrl(vanity) ||
    target ||
    textFromRuns(header?.title)?.replace(/^@/, "") ||
    null;

  const subText =
    header?.subscriberCountText?.simpleText ||
    textFromRuns(header?.subscriberCountText?.runs) ||
    header?.subscriberCount ||
    "0";
  const subCount = parseYtViewCount(subText);

  let bio =
    textFromRuns(header?.description?.runs || header?.description) ||
    textFromRuns(user?._about?.description?.runs) ||
    "";

  let country =
    textFromRuns(user?._about?.country?.runs || user?._about?.country) ||
    header?.country ||
    null;
  if (country && typeof country === "object") {
    country = textFromRuns(country.runs || country);
  }

  const email =
    header?.businessEmail ||
    extractEmailFromBio(bio) ||
    extractEmailFromBio(
      textFromRuns(user?._about?.description?.runs || user?._about?.description)
    ) ||
    null;

  return {
    username: handle || target,
    displayName: textFromRuns(header?.title?.runs || header?.title) || handle,
    channelId,
    bio,
    email,
    country: country ? String(country).trim() : null,
    avatarUrl:
      header?.avatar?.thumbnails?.slice(-1)[0]?.url ||
      header?.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
      "",
    verified: !!(header?.badges?.length || header?.isVerified),
    followers: { count: subCount, display: formatYtNumber(subCount) },
  };
}

export function computeYtVideoStatistics(videos) {
  const withViews = (videos || []).filter((v) => (v.views?.count || 0) > 0);
  const total = withViews.reduce((s, v) => s + (v.views?.count || 0), 0);
  const avgViews =
    withViews.length > 0 ? Math.round(total / withViews.length) : null;
  return {
    avgViews,
    videosWithPlayCount: withViews.length,
    totalVideos: (videos || []).length,
    avgLikes: null,
    avgComments: null,
  };
}

export function mergeYtVideoIntoMap(videoMap, video, maxVideos) {
  const id = video?.videoId;
  if (!id || videoMap.has(id)) return;
  if (videoMap.size >= maxVideos) return;
  videoMap.set(id, video);
}

export function sortYtVideosByRecency(videos) {
  return [...(videos || [])];
}
