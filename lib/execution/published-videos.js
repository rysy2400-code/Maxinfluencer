/**
 * 已发布视频（多平台）数据结构与读写工具。
 *
 * 结构（存于 last_event.publishedVideos，数组，一个平台一条）：
 * [
 *   {
 *     platform: 'youtube' | 'instagram' | 'tiktok' | 'x',
 *     url: string,
 *     videoId: string | null,
 *     shortcode: string | null,
 *     promoCode: string | null,
 *     publishedAt: string | null,   // ISO
 *     source: string | null,        // influencer_email | advertiser_portal | ...
 *     emailEventId: number | null,
 *     isPrimary: boolean,           // 旧单值字段（video_link 列等）取哪一条
 *     metrics: {
 *       views, viewsDisplay, likes, likesDisplay, comments, commentsDisplay,
 *       source, updatedAt
 *     } | null,
 *     metricsError: { message: string, at: string } | null
 *   }
 * ]
 *
 * 兼容策略：老数据没有 publishedVideos 时，由 deliverablesTimeline 里
 * kind="published" 的条目、或 video_link 列 / last_event.videoLink + promoCode
 * 合成，保证前端与导出在改造后不回退。
 */

import { parsePublishedVideoUrl } from "./published-video-url.js";

/** 展示顺序：固定 YouTube → Instagram → TikTok → X */
export const PUBLISHED_PLATFORM_ORDER = ["youtube", "instagram", "tiktok", "x"];

export const PUBLISHED_PLATFORM_LABELS = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X",
};

function parseJsonSafe(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function cleanString(v, maxLen = 1024) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function validIso(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * 归一化平台标识：接受 'youtube' / 'YouTube' / '@youtube' 等写法，链接可兜底识别。
 * @returns {'youtube'|'instagram'|'tiktok'|'x'|'unknown'}
 */
export function normalizePublishedPlatform(rawPlatform, rawUrl = "") {
  const raw = String(rawPlatform || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (raw.includes("youtube") || raw === "yt" || raw === "ytb" || raw.includes("youtu.be")) {
    return "youtube";
  }
  if (raw.includes("instagram") || raw === "ig" || raw === "ins" || raw === "reel") {
    return "instagram";
  }
  if (raw.includes("tiktok") || raw === "tk" || raw.includes("douyin")) {
    return "tiktok";
  }
  if (raw === "x" || raw.includes("twitter") || raw === "x.com") {
    return "x";
  }
  const parsed = parsePublishedVideoUrl(rawUrl);
  return parsed.platform || "unknown";
}

/** 数值化统计值：支持 123 / "123" / "12,345" / "1.2K" / "3M" / {count|display} */
export function parseStatNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    if (typeof v.count === "number" && Number.isFinite(v.count)) return v.count;
    return parseStatNumber(v.display);
  }
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([kmbt])?/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] || "").toLowerCase();
  const factor = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : unit === "t" ? 1e12 : 1;
  return base * factor;
}

/** 展示用统计值（保留原始 display 文本，如 "1.2K"） */
function statDisplay(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object") {
    if (typeof v.display === "string" && v.display.trim()) return v.display.trim();
    if (typeof v.count === "number" && Number.isFinite(v.count)) return String(v.count);
    return null;
  }
  const s = String(v).trim();
  return s || null;
}

/** 已发布视频条目归一化 */
export function normalizePublishedVideoEntry(raw, fallback = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const url = cleanString(src.url || src.link || src.videoLink || fallback.url || "");
  const parsed = parsePublishedVideoUrl(url || "");
  const platform = normalizePublishedPlatform(
    src.platform || fallback.platform,
    url || ""
  );
  const metricsSrc =
    src.metrics && typeof src.metrics === "object" ? src.metrics : null;
  const metrics = metricsSrc
    ? {
        views: parseStatNumber(metricsSrc.views),
        viewsDisplay: statDisplay(
          metricsSrc.viewsDisplay ?? metricsSrc.views
        ),
        likes: parseStatNumber(metricsSrc.likes),
        likesDisplay: statDisplay(
          metricsSrc.likesDisplay ?? metricsSrc.likes
        ),
        comments: parseStatNumber(metricsSrc.comments),
        commentsDisplay: statDisplay(
          metricsSrc.commentsDisplay ?? metricsSrc.comments
        ),
        source: cleanString(metricsSrc.source, 64),
        updatedAt:
          validIso(metricsSrc.updatedAt) || validIso(src.metricsUpdatedAt),
      }
    : null;

  return {
    platform,
    url: url || null,
    videoId: cleanString(src.videoId, 128) || parsed.videoId || null,
    shortcode: cleanString(src.shortcode, 128) || parsed.shortcode || null,
    username: cleanString(src.username, 128) || parsed.username || null,
    promoCode: cleanString(src.promoCode, 255),
    publishedAt: validIso(src.publishedAt) || validIso(src.at),
    source: cleanString(src.source, 64) || null,
    emailEventId:
      src.emailEventId != null && Number.isFinite(Number(src.emailEventId))
        ? Number(src.emailEventId)
        : null,
    isPrimary: src.isPrimary === true,
    metrics,
    metricsError:
      src.metricsError && typeof src.metricsError === "object"
        ? {
            message: cleanString(src.metricsError.message, 500) || "",
            at: validIso(src.metricsError.at),
          }
        : null,
  };
}

/** 去重键：优先 平台+视频ID/短码，其次 平台+去参链接 */
export function publishedVideoKey(entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  const platform = e.platform || "unknown";
  let id = e.videoId || e.shortcode || "";
  if (!id && e.url) {
    const parsed = parsePublishedVideoUrl(String(e.url));
    id = parsed.videoId || parsed.shortcode || "";
  }
  if (id) return `${platform}:${id}`;
  const url = String(e.url || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (url) return `${platform}:${url}`;
  return `${platform}:${String(e.promoCode || "").toLowerCase()}`;
}

/** 按固定平台顺序排序（同平台内按发布时间升序） */
export function sortPublishedVideos(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  return [...arr].sort((a, b) => {
    const ia = PUBLISHED_PLATFORM_ORDER.indexOf(a.platform);
    const ib = PUBLISHED_PLATFORM_ORDER.indexOf(b.platform);
    const ra = ia === -1 ? PUBLISHED_PLATFORM_ORDER.length : ia;
    const rb = ib === -1 ? PUBLISHED_PLATFORM_ORDER.length : ib;
    if (ra !== rb) return ra - rb;
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return ta - tb;
  });
}

/**
 * 从 last_event / execution 行解析多平台已发布视频。
 * 优先级：publishedVideos 数组 → deliverablesTimeline(kind=published) → 单值字段。
 */
export function resolvePublishedVideos(lastEventRaw, opts = {}) {
  const lastEvent = parseJsonSafe(lastEventRaw);
  const rows = [];
  const seen = new Set();

  const push = (entry) => {
    const normalized = normalizePublishedVideoEntry(entry);
    if (!normalized.url && !normalized.promoCode) return;
    const key = publishedVideoKey(normalized);
    if (seen.has(key)) {
      const existing = rows.find((r) => publishedVideoKey(r) === key);
      if (existing) {
        existing.promoCode = existing.promoCode || normalized.promoCode;
        existing.metrics = existing.metrics || normalized.metrics;
        existing.metricsError = existing.metricsError || normalized.metricsError;
        existing.publishedAt = existing.publishedAt || normalized.publishedAt;
        existing.emailEventId = existing.emailEventId || normalized.emailEventId;
      }
      return;
    }
    seen.add(key);
    rows.push(normalized);
  };

  const fromEvent = Array.isArray(lastEvent.publishedVideos)
    ? lastEvent.publishedVideos
    : [];
  for (const entry of fromEvent) push(entry);

  if (!rows.length) {
    const timeline = Array.isArray(lastEvent.deliverablesTimeline)
      ? lastEvent.deliverablesTimeline
      : [];
    for (const entry of timeline) {
      if (entry?.kind !== "published") continue;
      push({
        url: entry.link,
        promoCode: entry.promoCode,
        publishedAt: entry.at,
        source: entry.source,
        emailEventId: entry.emailEventId,
      });
    }
  }

  if (!rows.length) {
    const legacyUrl =
      cleanString(opts.videoLink) ||
      cleanString(lastEvent.videoLink) ||
      cleanString(opts.video_link) ||
      null;
    const legacyCode =
      cleanString(lastEvent.promoCode) || cleanString(opts.promoCode);
    if (legacyUrl || legacyCode) {
      push({
        url: legacyUrl,
        promoCode: legacyCode,
        publishedAt: lastEvent.publishedAt,
        source: legacyUrl ? "legacy_single" : null,
        metrics: legacyMetricsFromEvent(lastEvent, opts),
      });
    }
  }

  // 老数据的播放/点赞/评论是「单套指标」，挂在主链接对应的那条平台上
  const sorted = sortPublishedVideos(rows);
  if (sorted.length && !sorted.some((e) => e.metrics)) {
    const metrics = legacyMetricsFromEvent(lastEvent, opts);
    if (metrics) {
      const legacyUrl =
        cleanString(lastEvent.videoLink) ||
        cleanString(opts.videoLink) ||
        cleanString(opts.video_link);
      const target =
        (legacyUrl && sorted.find((e) => samePublishedVideoRef(e, { url: legacyUrl }))) ||
        sorted.find((e) => e.isPrimary) ||
        sorted[0];
      if (target) target.metrics = metrics;
    }
  }

  return withPrimaryFlag(sorted);
}

function legacyMetricsFromEvent(lastEvent, opts = {}) {
  const views = lastEvent?.views ?? opts.views;
  const likes = lastEvent?.likes ?? opts.likes;
  const comments = lastEvent?.comments ?? opts.comments;
  if (views == null && likes == null && comments == null) return null;
  return {
    views: parseStatNumber(views),
    viewsDisplay: statDisplay(views),
    likes: parseStatNumber(likes),
    likesDisplay: statDisplay(likes),
    comments: parseStatNumber(comments),
    commentsDisplay: statDisplay(comments),
    source: lastEvent?.metricsRaw?.source || null,
    updatedAt: validIso(lastEvent?.metricsUpdatedAt),
  };
}

/** 两个条目是否指向同一个视频（跨平台写法差异下按 videoId/短码/去参链接比较） */
export function samePublishedVideoRef(a, b) {
  const ref = (v) => {
    const url = String(v?.url || v || "");
    if (!url) return "";
    const parsed = parsePublishedVideoUrl(url);
    if (parsed.videoId || parsed.shortcode) return parsed.videoId || parsed.shortcode;
    return url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  };
  const ra = ref(a);
  const rb = ref(b);
  return Boolean(ra && rb && ra === rb);
}

/** 指定主链接：有 isPrimary 用 isPrimary，否则按平台顺序第一条 */
export function pickPrimaryPublishedVideo(list, preferredPlatform = null) {
  const arr = sortPublishedVideos(list);
  if (!arr.length) return null;
  if (preferredPlatform) {
    const preferred = normalizePublishedPlatform(preferredPlatform);
    const match = arr.find((e) => e.platform === preferred);
    if (match) return match;
  }
  return arr.find((e) => e.isPrimary) || arr[0];
}

/** 只保留一条 isPrimary（优先采用 preferredPlatform） */
export function withPrimaryFlag(list, preferredPlatform = null) {
  const sorted = sortPublishedVideos(list);
  if (!sorted.length) return sorted;
  const primary = pickPrimaryPublishedVideo(sorted, preferredPlatform);
  const primaryKey = primary ? publishedVideoKey(primary) : null;
  return sorted.map((entry) => ({
    ...entry,
    isPrimary: publishedVideoKey(entry) === primaryKey,
  }));
}

/**
 * 合并新旧条目（按 publishedVideoKey 去重）：
 * - 新条目覆盖 url/promoCode/发布时间等；已抓到的 metrics 保留（除非新条目自带 metrics）
 * - 保留历史条目，不删除
 */
export function mergePublishedVideos(existingList, incomingList, opts = {}) {
  const map = new Map();
  for (const raw of Array.isArray(existingList) ? existingList : []) {
    const entry = normalizePublishedVideoEntry(raw);
    if (!entry.url && !entry.promoCode) continue;
    map.set(publishedVideoKey(entry), entry);
  }
  for (const raw of Array.isArray(incomingList) ? incomingList : []) {
    const entry = normalizePublishedVideoEntry(raw);
    if (!entry.url && !entry.promoCode) continue;
    const key = publishedVideoKey(entry);
    const prev = map.get(key);
    map.set(
      key,
      prev
        ? {
            ...prev,
            ...entry,
            promoCode: entry.promoCode || prev.promoCode || null,
            publishedAt: entry.publishedAt || prev.publishedAt || null,
            source: entry.source || prev.source || null,
            emailEventId: entry.emailEventId || prev.emailEventId || null,
            metrics: entry.metrics || prev.metrics || null,
            metricsError: entry.metrics ? null : prev.metricsError || null,
          }
        : entry
    );
  }
  const merged = [...map.values()];
  return withPrimaryFlag(sortPublishedVideos(merged), opts.preferredPlatform);
}

/** 汇总各平台指标（数值） */
export function aggregatePublishedStats(list) {
  let views = 0;
  let likes = 0;
  let comments = 0;
  let hasViews = false;
  let hasLikes = false;
  let hasComments = false;
  let updatedAt = null;
  for (const entry of Array.isArray(list) ? list : []) {
    const m = entry?.metrics;
    if (!m) continue;
    if (Number.isFinite(m.views)) {
      views += m.views;
      hasViews = true;
    }
    if (Number.isFinite(m.likes)) {
      likes += m.likes;
      hasLikes = true;
    }
    if (Number.isFinite(m.comments)) {
      comments += m.comments;
      hasComments = true;
    }
    const at = validIso(m.updatedAt);
    if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
  }
  return {
    views: hasViews ? views : null,
    likes: hasLikes ? likes : null,
    comments: hasComments ? comments : null,
    updatedAt,
  };
}

/** 合计 CPM = 合作费用 / 全平台合计播放 × 1000 */
export function computeTotalCpm(feeUsd, totalViews) {
  const fee = Number(feeUsd);
  const views = Number(totalViews);
  if (!Number.isFinite(fee) || fee <= 0) return null;
  if (!Number.isFinite(views) || views <= 0) return null;
  return Number(((fee / views) * 1000).toFixed(2));
}

/**
 * 生成旧字段（video_link / promoCode / views / likes / comments / cpm），
 * 供合同、Bin 汇报、导出兜底等旧消费方继续使用。
 * @returns {{ videoLink: string|null, promoCode: string|null, views: number|null, likes: number|null, comments: number|null, cpm: number|null }}
 */
export function buildLegacyPublishedFields(list, opts = {}) {
  const arr = sortPublishedVideos(list);
  const primary = pickPrimaryPublishedVideo(arr, opts.preferredPlatform);
  const stats = aggregatePublishedStats(arr);
  return {
    videoLink: primary?.url || null,
    promoCode: primary?.promoCode || null,
    views: stats.views,
    likes: stats.likes,
    comments: stats.comments,
    cpm: computeTotalCpm(opts.feeUsd, stats.views),
  };
}

/**
 * 指标刷新任务：把执行行展开成「一行链接一个任务」。
 * @param {object} row tiktok_campaign_execution 行（含 last_event / video_link）
 * @param {{ platformFilter?: string|null, refreshHours?: number, now?: number }} [opts]
 */
export function publishedVideoTasksFromRow(row, opts = {}) {
  if (!row) return [];
  const lastEvent = parseJsonSafe(row.last_event);
  const entries = resolvePublishedVideos(lastEvent, {
    videoLink: row.video_link,
  });
  const platformFilter = opts.platformFilter
    ? normalizePublishedPlatform(opts.platformFilter)
    : null;
  const refreshMs = (Number(opts.refreshHours) || 6) * 3600 * 1000;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const tasks = [];
  for (const entry of entries) {
    if (!entry.url) continue;
    const parsed = parsePublishedVideoUrl(entry.url);
    const platform = normalizePublishedPlatform(entry.platform, entry.url);
    if (platform === "unknown" || parsed.platform === "unknown") continue;
    if (platformFilter && platform !== platformFilter) continue;
    const updatedAt = validIso(entry.metrics?.updatedAt);
    if (updatedAt && now - new Date(updatedAt).getTime() < refreshMs) continue;
    tasks.push({
      campaignId: row.campaign_id,
      influencerKey: row.tiktok_username,
      influencerId: row.influencer_id,
      platform,
      videoLink: entry.url,
      parsedVideo: parsed,
      entry,
      lastEvent,
      flatFee: row.flat_fee,
      currency: row.currency,
      snapshot: parseJsonSafe(row.influencer_snapshot),
    });
  }
  return tasks;
}

/**
 * 把一次抓取结果写回条目数组（返回新的数组）。
 * @param {Array} list 现有 publishedVideos
 * @param {{ videoLink: string, platform?: string, metrics?: object, error?: string }} result
 */
export function applyPublishedMetricsResult(list, result, opts = {}) {
  const targetUrl = cleanString(result?.videoLink, 1024) || "";
  const targetPlatform = result?.platform
    ? normalizePublishedPlatform(result.platform)
    : null;
  const now = validIso(opts.now) || new Date().toISOString();

  const arr = (Array.isArray(list) ? list : []).map((raw) => {
    const entry = normalizePublishedVideoEntry(raw);
    const key = publishedVideoKey(entry);
    const targetKey = publishedVideoKey(
      normalizePublishedVideoEntry({
        url: targetUrl,
        platform: targetPlatform || entry.platform,
      })
    );
    if (key !== targetKey) return entry;

    if (result?.error) {
      return {
        ...entry,
        metricsError: { message: String(result.error).slice(0, 500), at: now },
      };
    }
    const m = result?.metrics || {};
    return {
      ...entry,
      metrics: {
        views: parseStatNumber(m.views),
        viewsDisplay: statDisplay(m.viewsDisplay ?? m.views),
        likes: parseStatNumber(m.likes),
        likesDisplay: statDisplay(m.likesDisplay ?? m.likes),
        comments: parseStatNumber(m.comments),
        commentsDisplay: statDisplay(m.commentsDisplay ?? m.comments),
        source: cleanString(m.source, 64),
        updatedAt: now,
      },
      metricsError: null,
    };
  });

  return withPrimaryFlag(arr, opts.preferredPlatform);
}

/**
 * 红人回传多平台发布链接时的落库合并（纯函数，供事件 worker / API 复用）：
 * - publishedVideos：按 publishedVideoKey upsert，保留历史平台与已抓指标
 * - deliverablesTimeline：只为本次「新增」链接追加 kind="published" 条目（幂等）
 * - legacy：单值字段（video_link / promoCode / 合计 views、likes、comments、cpm）
 *
 * @param {{
 *   lastEvent?: object,
 *   timeline?: Array,
 *   incoming?: Array<{platform?: string, url: string, promoCode?: string|null}>,
 *   preferredPlatform?: string|null,
 *   feeUsd?: number|null,
 *   publishedAt?: string|null,
 *   source?: string|null,
 *   emailEventId?: number|null,
 *   savedAt?: string|null,
 * }} params
 */
export function upsertPublishedVideosFromUpdate(params = {}) {
  const lastEvent =
    params.lastEvent && typeof params.lastEvent === "object" ? params.lastEvent : {};
  const timeline = Array.isArray(params.timeline) ? params.timeline : [];
  const savedAt = validIso(params.savedAt) || new Date().toISOString();
  const publishedAt = validIso(params.publishedAt) || savedAt;

  const existing = Array.isArray(lastEvent.publishedVideos)
    ? lastEvent.publishedVideos
    : [];

  const incoming = [];
  const seen = new Set();
  for (const raw of Array.isArray(params.incoming) ? params.incoming : []) {
    const url = cleanString(raw?.url || raw?.link, 1024);
    if (!url) continue;
    const key = publishedVideoKey({ platform: raw?.platform || "", url });
    if (seen.has(key)) continue;
    seen.add(key);
    incoming.push({
      platform: normalizePublishedPlatform(raw?.platform, url),
      url,
      promoCode: cleanString(raw?.promoCode, 255),
      publishedAt,
      source: params.source || "influencer_email",
      emailEventId:
        params.emailEventId != null && Number.isFinite(Number(params.emailEventId))
          ? Number(params.emailEventId)
          : null,
    });
  }

  const publishedVideos = incoming.length
    ? mergePublishedVideos(existing, incoming, {
        preferredPlatform: params.preferredPlatform || null,
      })
    : sortPublishedVideos(existing);

  const existingKeys = new Set(
    timeline
      .filter((e) => e?.kind === "published")
      .map((e) => publishedVideoKey({ platform: e?.platform || "", url: e?.link || "" }))
  );
  const appended = [];
  for (const entry of incoming) {
    const key = publishedVideoKey(entry);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    appended.push({
      kind: "published",
      role: "influencer",
      type: "published_link",
      platform: entry.platform,
      link: entry.url,
      content: entry.promoCode ? `投流码: ${entry.promoCode}` : null,
      promoCode: entry.promoCode || null,
      at: savedAt,
      source: params.source || "influencer_email",
      emailEventId: entry.emailEventId || null,
    });
  }

  return {
    publishedVideos,
    deliverablesTimeline: appended.length ? [...timeline, ...appended] : timeline,
    appended,
    legacy: buildLegacyPublishedFields(publishedVideos, {
      feeUsd: params.feeUsd,
      preferredPlatform: params.preferredPlatform || null,
    }),
  };
}
