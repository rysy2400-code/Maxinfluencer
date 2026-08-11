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

/**
 * 把 YouTube 时长文本解析为秒。
 * 支持 "9:40"、"1:02:30"、"9分钟40秒钟"、"1小时2分钟"、纯数字（秒）等格式。
 * @returns {number|null} 秒；解析失败返回 null
 */
export function parseYtDurationToSeconds(textOrObj) {
  if (textOrObj == null) return null;
  let s = "";
  if (typeof textOrObj === "object") {
    s = textOrObj.simpleText || textOrObj.content || "";
    if (!s) {
      const label = textOrObj.accessibility?.accessibilityData?.label;
      if (label) s = label;
    }
  } else {
    s = String(textOrObj);
  }
  s = s.trim();
  if (!s) return null;
  // 纯秒数
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }
  // 中文格式：1小时2分钟30秒 / 9分钟40秒钟（“3年前”这类发布时间不属于时长，由 publishedTime 解析）
  const zhMatches = [...s.matchAll(/(\d+)\s*小时|(\d+)\s*分钟|(\d+)\s*秒/g)];
  if (zhMatches.length > 0) {
    let h = 0;
    let m = 0;
    let sec = 0;
    for (const zh of zhMatches) {
      if (zh[1] != null) h = parseInt(zh[1], 10);
      else if (zh[2] != null) m = parseInt(zh[2], 10);
      else if (zh[3] != null) sec = parseInt(zh[3], 10);
    }
    return h * 3600 + m * 60 + sec;
  }
  // 冒号格式：9:40 / 1:02:30（若含“时长”等中文前缀，先去掉）
  const colon = s.match(/(?:^|[^\d:])(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?/);
  if (colon) {
    const h = colon[3] != null ? parseInt(colon[1], 10) : 0;
    const m = colon[3] != null ? parseInt(colon[2], 10) : parseInt(colon[1], 10);
    const sec = colon[3] != null ? parseInt(colon[3], 10) : parseInt(colon[2], 10);
    return h * 3600 + m * 60 + sec;
  }
  return null;
}

/** 从时长秒数生成人类可读文本（如 9:40 / 1:02:30），供 LLM 直接阅读 */
export function formatYtDurationDisplay(seconds) {
  const n = Number(seconds);
  if (seconds == null || seconds === "" || !Number.isFinite(n) || n < 0) return null;
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** 从 innertube 文本字段（对象或字符串）提取纯文本 */
function textFromYtField(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    return value.simpleText || (Array.isArray(value.runs) ? value.runs.map((r) => r.text || "").join("") : null) || value.content || null;
  }
  const s = String(value).trim();
  return s || null;
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
  const durationText = textFromYtField(vr.lengthText) || null;
  const durationSeconds = parseYtDurationToSeconds(vr.lengthText);
  const publishedTimeText = textFromYtField(vr.publishedTimeText) || null;
  return {
    videoId,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    username: channelRec?.username,
    profileUrl: channelRec?.profileUrl,
    description: title,
    views: { count: views, display: formatYtNumber(views) },
    duration: durationText,
    durationSeconds,
    publishedTimeText,
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

/** lockupViewModel 缩略图角标时长（如 "9:24"） */
function durationFromLockupViewModel(lv) {
  const overlays = lv?.contentImage?.thumbnailViewModel?.overlays || [];
  for (const ov of overlays) {
    const badges =
      ov?.thumbnailBottomOverlayViewModel?.badges ||
      ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges ||
      [];
    for (const b of badges) {
      const text = b?.thumbnailBadgeViewModel?.text || b?.text || null;
      if (text) return text;
    }
  }
  return null;
}

/** lockupViewModel metadataRows 中的发布时间（如 "2年前"） */
function publishedTimeFromLockupViewModel(lv) {
  const meta =
    lv?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel ||
    lv?.metadata?.contentMetadataViewModel;
  for (const row of meta?.metadataRows || []) {
    for (const part of row?.metadataParts || []) {
      const txt = part?.text?.content || part?.text?.simpleText || "";
      const acc = part?.accessibilityLabel || "";
      const raw = txt || acc || "";
      if (!raw) continue;
      // 跳过纯观看数（含 view/次/观看），保留时间文本（年/月/周/天/ago/hour/minute…）
      if (/view|次|观看/i.test(raw)) continue;
      if (/(年前|个月前|周前|天前|小时前|ago|hour|minute|day|week|month|year)/i.test(raw)) {
        return raw;
      }
    }
  }
  return null;
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
        const durationText = durationFromLockupViewModel(lv);
        list.push({
          videoId,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          description: titleFromLockupViewModel(lv),
          views: { count: views, display: formatYtNumber(views) },
          duration: durationText,
          durationSeconds: parseYtDurationToSeconds(durationText),
          publishedTimeText: publishedTimeFromLockupViewModel(lv),
          likes: { count: 0, display: "0" },
          comments: { count: 0, display: "0" },
          thumbnail: lv?.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || null,
        });
      }
    } else if (obj.lockupViewModel) {
      const lv = obj.lockupViewModel;
      const videoId = videoIdFromLockupViewModel(lv);
      if (videoId && !seen.has(videoId)) {
        seen.add(videoId);
        const views = viewsFromLockupViewModel(lv);
        const durationText = durationFromLockupViewModel(lv);
        list.push({
          videoId,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          description: titleFromLockupViewModel(lv),
          views: { count: views, display: formatYtNumber(views) },
          duration: durationText,
          durationSeconds: parseYtDurationToSeconds(durationText),
          publishedTimeText: publishedTimeFromLockupViewModel(lv),
          likes: { count: 0, display: "0" },
          comments: { count: 0, display: "0" },
          thumbnail: lv?.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || null,
        });
      }
    }
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
        duration: textFromYtField(vr.lengthText) || null,
        durationSeconds: parseYtDurationToSeconds(vr.lengthText),
        publishedTimeText: publishedTimeTextFrom(vr.publishedTimeText) || null,
        likes: { count: 0, display: "0" },
        comments: { count: 0, display: "0" },
        thumbnail: vr.thumbnail?.thumbnails?.slice(-1)[0]?.url || null,
      });
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

/**
 * 从任意 innertube / ytInitialData JSON 深度扫描订阅数（browse/about 结构不一致时的兜底）
 */
export function extractSubscriberCountFromInnertubeJson(json) {
  if (!json) return null;
  let best = 0;
  const walk = (obj, depth = 0) => {
    if (depth > 28 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x, depth + 1);
      return;
    }
    if (obj.subscriberCountText) {
      const txt =
        typeof obj.subscriberCountText === "string"
          ? obj.subscriberCountText
          : obj.subscriberCountText?.content ||
            obj.subscriberCountText?.simpleText ||
            textFromRuns(obj.subscriberCountText?.runs);
      const n = parseYtViewCount(txt);
      if (n > best) best = n;
    }
    const textBlob =
      obj?.text?.content ||
      (typeof obj?.text === "string" ? obj.text : null) ||
      obj?.simpleText ||
      null;
    if (
      textBlob &&
      /subscriber|订阅|subscribers/i.test(String(textBlob)) &&
      !/video/i.test(String(textBlob))
    ) {
      const n = parseYtViewCount(textBlob);
      if (n > best) best = n;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  return best > 0 ? { count: best, display: formatYtNumber(best) } : null;
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

function avgFrom(videos, pick) {
  const vals = (videos || [])
    .map((v) => pick(v))
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (!vals.length) return null;
  return Math.round(vals.reduce((s, n) => s + n, 0) / vals.length);
}

export function computeYtVideoStatistics(videos) {
  const withViews = (videos || []).filter((v) => (v.views?.count || 0) > 0);
  const total = withViews.reduce((s, v) => s + (v.views?.count || 0), 0);
  const avgViews =
    withViews.length > 0 ? Math.round(total / withViews.length) : null;
  const withEngagement = (videos || []).filter(
    (v) =>
      (v.likes?.count || 0) > 0 ||
      (v.comments?.count || 0) > 0 ||
      (v.views?.count || 0) > 0
  );
  return {
    avgViews,
    videosWithPlayCount: withViews.length,
    totalVideos: (videos || []).length,
    avgLikes: avgFrom(withEngagement, (v) => v.likes?.count),
    avgComments: avgFrom(withEngagement, (v) => v.comments?.count),
    videosWithEngagement: withEngagement.filter((v) => (v.likes?.count || 0) > 0)
      .length,
    videosWithComments: withEngagement.filter((v) => (v.comments?.count || 0) > 0)
      .length,
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
