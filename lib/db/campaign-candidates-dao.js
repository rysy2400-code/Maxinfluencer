import tiktokPool, { queryTikTok } from "./mysql-tiktok.js";
import { upsertInfluencer } from "./influencer-dao.js";
import { extractEmailFromBio, isLikelyIgHeaderStatsBio } from "../influencer/extract-email-from-bio.js";
import { ingestKeywordSignalsFromRecommendedInfluencer } from "./campaign-keyword-signals-dao.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email;
}

function collectIgApiEmailsFromObject(root, depth = 0, out = []) {
  if (depth > 12 || !root || typeof root !== "object") return out;
  if (Array.isArray(root)) {
    for (const item of root) collectIgApiEmailsFromObject(item, depth + 1, out);
    return out;
  }
  for (const [key, value] of Object.entries(root)) {
    if (
      /^(public_email|business_email|contact_email)$/i.test(key) &&
      typeof value === "string"
    ) {
      const mail = normalizeEmail(value);
      if (mail) out.push(mail);
    } else if (typeof value === "object" && value) {
      collectIgApiEmailsFromObject(value, depth + 1, out);
    }
  }
  return out;
}

export function resolveCandidateEmail(inf) {
  const fromLinks = (links) => {
    if (!Array.isArray(links)) return null;
    for (const link of links) {
      const url = String(link?.url || "");
      if (/^mailto:/i.test(url)) {
        const mail = normalizeEmail(url.replace(/^mailto:/i, "").split("?")[0]);
        if (mail) return mail;
      }
      const fromUrl = extractEmailFromBio(url);
      if (fromUrl) return normalizeEmail(fromUrl);
    }
    return null;
  };

  const bioCandidates = [
    inf?.bio,
    inf?.profile_data?.userInfo?.bio,
    inf?.profileData?.userInfo?.bio,
    inf?.profile_data?.rawUser?.biography,
    inf?.profileData?.rawUser?.biography,
  ].filter((b) => typeof b === "string" && b.trim() && !isLikelyIgHeaderStatsBio(b));

  const apiEmails = [
    ...collectIgApiEmailsFromObject(inf?.profile_data),
    ...collectIgApiEmailsFromObject(inf?.profileData),
  ];

  return (
    normalizeEmail(inf?.email) ||
    normalizeEmail(inf?.profile_data?.userInfo?.email) ||
    normalizeEmail(inf?.profileData?.userInfo?.email) ||
    apiEmails.map((e) => normalizeEmail(e)).find(Boolean) ||
    bioCandidates.map((b) => extractEmailFromBio(b)).find(Boolean) ||
    fromLinks(inf?.aboutLinks) ||
    fromLinks(inf?.profile_data?.userInfo?.aboutLinks) ||
    fromLinks(inf?.profileData?.userInfo?.aboutLinks) ||
    null
  );
}

/** TikTok userId 字符串（与 tiktok_influencer.influencer_id 一致） */
export function resolvePlatformInfluencerId(inf = {}) {
  const raw =
    inf.tiktokUserId ??
    inf.tiktok_user_id ??
    inf.userId ??
    inf.channelId ??
    inf.profile_data?.userInfo?.userId ??
    inf.profile_data?.userInfo?.user_id ??
    inf.profile_data?.userInfo?.channelId ??
    null;
  if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  const legacy = inf.influencerId ?? inf.influencer_id ?? inf.id;
  if (legacy != null && /^\d{10,}$/.test(String(legacy).trim())) {
    return String(legacy).trim();
  }
  return null;
}

/** handle，无 @ */
export function resolveTiktokUsername(inf = {}) {
  const u = inf.username ?? inf.handle;
  if (typeof u === "string" && u.replace(/^@/, "").trim()) {
    return u.replace(/^@/, "").trim();
  }
  const legacy = inf.influencerId ?? inf.influencer_id ?? inf.id;
  if (legacy != null && !/^\d{10,}$/.test(String(legacy).trim())) {
    return String(legacy).replace(/^@/, "").trim();
  }
  return null;
}

function followerCountFromSnapshot(s) {
  const f = s?.followers;
  if (typeof f === "number" && Number.isFinite(f)) return f;
  if (f && typeof f.count === "number" && Number.isFinite(f.count)) return f.count;
  return null;
}

import { avgViewsFromSnapshot } from "../influencer/avg-views.js";

export { avgViewsFromSnapshot };

/** campaign 候选池已有 handle（小写、无 @） */
export async function loadCandidateUsernameSet(campaignId) {
  if (!campaignId) return new Set();
  const rows = await queryTikTok(
    `
    SELECT LOWER(tiktok_username) AS u
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  return new Set(
    (rows || [])
      .map((r) => String(r.u ?? r.U ?? "").trim())
      .filter(Boolean)
  );
}

/** enrich 前查候选表：该 campaign 是否已有此红人 */
export async function isCandidateInCampaign(campaignId, username) {
  if (!campaignId || !username) return false;
  const u = String(username).replace(/^@/, "").trim().toLowerCase();
  if (!u) return false;
  const rows = await queryTikTok(
    `
    SELECT 1 AS ok
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ? AND LOWER(tiktok_username) = ?
    LIMIT 1
  `,
    [campaignId, u]
  );
  return !!(rows && rows.length > 0);
}

async function loadGlobalInfluencerEmailMap(usernames = []) {
  const normalized = [
    ...new Set(
      (usernames || [])
        .map((u) => String(u || "").replace(/^@/, "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  const out = new Map();
  for (let i = 0; i < normalized.length; i += 100) {
    const chunk = normalized.slice(i, i + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await queryTikTok(
      `
      SELECT LOWER(username) AS username, influencer_email
      FROM TikTok_influencer
      WHERE LOWER(username) IN (${placeholders})
        AND influencer_email IS NOT NULL
        AND influencer_email <> ''
      `,
      chunk
    );
    for (const row of rows || []) {
      const email = normalizeEmail(row.influencer_email);
      if (email) out.set(String(row.username || "").toLowerCase(), email);
    }
  }
  return out;
}

function applyGlobalEmailFallback(inf = {}, username, globalEmailByUsername) {
  if (resolveCandidateEmail(inf)) return inf;
  const key = String(username || inf.username || inf.handle || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  const globalEmail = normalizeEmail(globalEmailByUsername?.get(key));
  if (!globalEmail) return inf;
  return {
    ...inf,
    email: globalEmail,
    aboutEmailSource: inf.aboutEmailSource || "global_influencer_email",
    aboutEmailSourceDetail:
      inf.aboutEmailSourceDetail || "TikTok_influencer.influencer_email",
  };
}

/**
 * 候选联系人邮箱解析：先直接解析；缺失时回退到全局 TikTok_influencer.influencer_email
 * （与 upsertCandidatesForCampaign 写候选时的邮箱来源一致，保证 ct 计数与候选一致）。
 */
export async function resolveCandidateEmailWithGlobalFallback(inf) {
  const direct = resolveCandidateEmail(inf);
  if (direct) return direct;
  const username = String(inf?.username || inf?.handle || "")
    .replace(/^@/, "")
    .trim();
  if (!username) return null;
  const map = await loadGlobalInfluencerEmailMap([username]);
  const patched = applyGlobalEmailFallback(inf, username, map);
  return resolveCandidateEmail(patched) || patched?.email || null;
}

async function syncGlobalInfluencerFromCandidateRow(campaignId, r) {
  const url = r.snapshot?.profileUrl;
  if (!url || typeof url !== "string" || !url.trim()) return;
  if (!r.platformInfluencerId || String(r.platformInfluencerId).trim() === "") {
    return;
  }
  const uname =
    typeof r.snapshot.username === "string"
      ? r.snapshot.username.replace(/^@/, "").trim() || null
      : null;
  try {
    const platformSlug = String(r.snapshot.platform || "tiktok")
      .trim()
      .toLowerCase()
      .includes("instagram")
      ? "instagram"
      : String(r.snapshot.platform || "tiktok")
          .trim()
          .toLowerCase()
          .includes("youtube")
        ? "youtube"
        : "tiktok";
    await upsertInfluencer({
      influencerId: String(r.platformInfluencerId).trim(),
      platform: platformSlug,
      username: uname || r.tiktokUsername || undefined,
      displayName: r.snapshot.displayName || uname || r.tiktokUsername || undefined,
      profileUrl: url.trim(),
      followerCount: followerCountFromSnapshot(r.snapshot),
      avgViews: avgViewsFromSnapshot(r.snapshot),
      influencerEmail: r.email || null,
      source: "web_search",
      sourceRef: campaignId || null,
      sourcePayload: { origin: "tiktok_campaign_influencer_candidates", campaignId },
      lastFetchedAt: new Date(),
    });
  } catch (e) {
    console.warn(
      "[campaign-candidates-dao] 同步 tiktok_influencer 失败:",
      r.tiktokUsername,
      e?.message || e
    );
  }
}

/**
 * 选取本 campaign 下建议联系且未被消费的候选红人
 * @returns {Promise<Array<{ tiktokUsername: string, platformInfluencerId: string|null, snapshot: object, matchScore: number|null }>>}
 */
export async function pickCandidatesForExecution(campaignId, limit) {
  const limitInt = Math.max(0, Math.min(1000, Number(limit) || 0));
  if (limitInt <= 0) return [];

  const rows = await queryTikTok(
    `
    SELECT
      c.tiktok_username,
      c.influencer_id,
      c.influencer_snapshot,
      c.match_score,
      c.source
    FROM tiktok_campaign_influencer_candidates c
    WHERE
      c.campaign_id = ?
      AND c.has_email = 1
      AND c.should_contact = 1
      AND c.picked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tiktok_campaign_execution e
        WHERE e.campaign_id = c.campaign_id AND e.tiktok_username = c.tiktok_username
      )
    ORDER BY
      (c.source = 'user_upload') DESC,
      COALESCE(c.match_score, 0) DESC,
      COALESCE(c.analyzed_at, c.created_at) DESC
    LIMIT ${limitInt}
  `,
    [campaignId]
  );

  return (rows || []).map((r) => ({
    tiktokUsername: r.tiktok_username,
    platformInfluencerId: r.influencer_id || null,
    snapshot: parseJson(r.influencer_snapshot) || {},
    matchScore: typeof r.match_score === "number" ? r.match_score : null,
    source: r.source || "web_search",
  }));
}

export async function markCandidatePicked(campaignId, tiktokUsername, pickedAt) {
  await queryTikTok(
    `
    UPDATE tiktok_campaign_influencer_candidates
    SET picked_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND tiktok_username = ?
  `,
    [pickedAt, campaignId, tiktokUsername]
  );
}

function numericCount(value) {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object") {
    return numericCount(value.count ?? value.avg ?? value.value);
  }
  const n = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function compactVideoList(list, limit = 12) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, limit).map((v = {}) => ({
    videoId: v.videoId ?? v.id ?? v.pk ?? null,
    videoUrl: v.videoUrl ?? v.url ?? v.postUrl ?? null,
    postCode: v.postCode ?? v.shortCode ?? v.code ?? null,
    mediaType: v.mediaType ?? v.type ?? null,
    description: v.description ?? v.desc ?? v.caption ?? null,
    views: v.views ?? null,
    likes: v.likes ?? null,
    comments: v.comments ?? null,
    thumbnail: v.thumbnail ?? v.coverUrl ?? v.cover ?? null,
    engagementSource: v.engagementSource ?? null,
  }));
}

function summarizeViews(videos) {
  const counts = (Array.isArray(videos) ? videos : [])
    .map((v) => numericCount(v?.views))
    .filter((n) => n > 0);
  if (!counts.length) return null;
  const avg = Math.round(counts.reduce((sum, n) => sum + n, 0) / counts.length);
  return { avg, display: formatCompactCount(avg), sampleSize: counts.length };
}

function summarizeEngagement(videos) {
  const rows = (Array.isArray(videos) ? videos : []).map((v) => ({
    likes: numericCount(v?.likes),
    comments: numericCount(v?.comments),
    views: numericCount(v?.views),
  }));
  const withLikes = rows.filter((r) => r.likes > 0);
  const withComments = rows.filter((r) => r.comments > 0);
  const withViews = rows.filter((r) => r.views > 0);
  if (!withLikes.length && !withComments.length && !withViews.length) return null;
  const avg = (arr, key) =>
    arr.length
      ? Math.round(arr.reduce((sum, row) => sum + row[key], 0) / arr.length)
      : null;
  const avgLikes = avg(withLikes, "likes");
  const avgComments = avg(withComments, "comments");
  const avgViews = avg(withViews, "views");
  const rate =
    avgViews && (avgLikes || avgComments)
      ? Number((((avgLikes || 0) + (avgComments || 0)) / avgViews * 100).toFixed(2))
      : null;
  return {
    rate,
    avgLikes,
    avgComments,
    avgViews,
    sampleSize: rows.length,
  };
}

function hasPositiveMetric(value, keys = ["avg", "count", "value"]) {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "object") {
    return keys.some((key) => hasPositiveMetric(value[key], keys));
  }
  return numericCount(value) > 0;
}

function mergeEngagementSummary(existing, fallback) {
  if (!existing) return fallback || null;
  if (!fallback) return existing;
  return {
    ...existing,
    rate: hasPositiveMetric(existing.rate) ? existing.rate : fallback.rate,
    avgLikes: hasPositiveMetric(existing.avgLikes) ? existing.avgLikes : fallback.avgLikes,
    avgComments: hasPositiveMetric(existing.avgComments)
      ? existing.avgComments
      : fallback.avgComments,
    avgViews: hasPositiveMetric(existing.avgViews) ? existing.avgViews : fallback.avgViews,
    sampleSize: existing.sampleSize || fallback.sampleSize || null,
  };
}

function isInstagramInfluencer(inf = {}) {
  return String(inf.platform || inf.platformSlug || "")
    .toLowerCase()
    .includes("instagram");
}

function normalizeSnapshotVideoCountry(inf = {}) {
  const raw = inf.video_publish_country ?? inf.videoPublishCountry ?? null;
  if (raw != null && String(raw).trim()) return raw;
  return isInstagramInfluencer(inf) ? "country_unknown" : null;
}

function formatCompactCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(Math.round(num));
}

/**
 * 重分析后更新候选行（覆盖 match / 摘要 / snapshot / 邮箱等）
 * @param {string} campaignId
 * @param {string} tiktokUsername
 * @param {object} inf enrich+分析合并后的红人对象
 * @param {{ taskId?: number|null, runId?: string|null, searchKeyword?: string|null }} [taskMeta]
 */
export async function updateCandidateAfterReanalysis(
  campaignId,
  tiktokUsername,
  inf = {},
  taskMeta = {}
) {
  if (!campaignId || !tiktokUsername) return { updated: 0 };

  const globalEmailByUsername = await loadGlobalInfluencerEmailMap([tiktokUsername]);
  const infForSnapshot = applyGlobalEmailFallback(
    inf,
    tiktokUsername,
    globalEmailByUsername
  );
  const snapshot = buildNormalizedInfluencerSnapshot(infForSnapshot, taskMeta);
  const matchScore =
    typeof infForSnapshot.recommendationScore === "number"
      ? infForSnapshot.recommendationScore
      : typeof infForSnapshot.score === "number"
        ? infForSnapshot.score
        : null;
  const shouldContact =
    typeof infForSnapshot.isRecommended === "boolean"
      ? infForSnapshot.isRecommended
        ? 1
        : 0
      : 0;
  const email = snapshot.email;
  const hasEmail = email ? 1 : 0;

  const result = await queryTikTok(
    `
    UPDATE tiktok_campaign_influencer_candidates
    SET
      influencer_id = COALESCE(?, influencer_id),
      influencer_snapshot = ?,
      match_score = ?,
      should_contact = ?,
      analysis_summary = ?,
      match_analysis = ?,
      email = ?,
      has_email = ?,
      analyzed_at = NOW(),
      updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND LOWER(tiktok_username) = LOWER(?)
  `,
    [
      resolvePlatformInfluencerId(infForSnapshot),
      JSON.stringify(snapshot),
      matchScore,
      shouldContact,
      snapshot.analysisSummary,
      JSON.stringify(snapshot.matchAnalysis),
      email,
      hasEmail,
      campaignId,
      tiktokUsername.replace(/^@/, "").trim(),
    ]
  );

  const updated =
    typeof result?.affectedRows === "number" ? result.affectedRows : 0;
  return { updated };
}

/**
 * 结构化匹配分析（与 match_analysis 列、influencer_snapshot.matchAnalysis 一致）
 * @param {object} inf
 * @param {{ taskId?: number|null, runId?: string|null, searchKeyword?: string|null }} taskMeta
 */
export function buildMatchAnalysisObject(inf = {}, taskMeta = {}) {
  const analysisLong =
    (typeof inf?.analysis === "string" && inf.analysis.trim()) ||
    (typeof inf?.recommendationAnalysis === "string" && inf.recommendationAnalysis.trim()) ||
    "";
  const score =
    typeof inf?.score === "number"
      ? inf.score
      : typeof inf?.recommendationScore === "number"
        ? inf.recommendationScore
        : null;
  return {
    version: 1,
    analyzedAt: new Date().toISOString(),
    taskId: taskMeta.taskId ?? null,
    runId: taskMeta.runId ?? null,
    keyword: taskMeta.searchKeyword ?? null,
    analysis: analysisLong || null,
    score,
    isRecommended: typeof inf?.isRecommended === "boolean" ? inf.isRecommended : null,
  };
}

/**
 * 与 upsertCandidatesForCampaign / 写入 tiktok_campaign.recommended_influencers 使用的统一红人快照结构
 * @param {object} inf
 * @param {{ taskId?: number|null, runId?: string|null, searchKeyword?: string|null }} taskMeta
 */
export function buildNormalizedInfluencerSnapshot(inf = {}, taskMeta = {}) {
  const rec = inf.isRecommended;
  const analysisSummary =
    inf.recommendationReason ||
    inf.reason ||
    (typeof rec === "boolean"
      ? rec
        ? "匹配度较高，建议联系"
        : "匹配度一般或较低"
      : "匹配度一般或较低");
  const email = resolveCandidateEmail(inf);
  const matchAnalysis = buildMatchAnalysisObject(inf, taskMeta);
  const gmvRaw = inf.gmv;
  const gmv =
    typeof gmvRaw === "number" && Number.isFinite(gmvRaw) ? gmvRaw : null;
  const gmvDisplayRaw = inf.gmvDisplay ?? inf.gmv_display ?? null;
  const gmvDisplay =
    gmvDisplayRaw != null && String(gmvDisplayRaw).trim()
      ? String(gmvDisplayRaw).trim()
      : null;
  const unitsSoldRaw = inf.unitsSold ?? inf.units_sold ?? null;
  const unitsSold =
    typeof unitsSoldRaw === "number" && Number.isFinite(unitsSoldRaw)
      ? unitsSoldRaw
      : null;
  const unitsSoldDisplayRaw =
    inf.unitsSoldDisplay ?? inf.units_sold_display ?? null;
  const unitsSoldDisplay =
    unitsSoldDisplayRaw != null && String(unitsSoldDisplayRaw).trim()
      ? String(unitsSoldDisplayRaw).trim()
      : null;
  const videos = compactVideoList(
    inf.videos ??
      inf.profile_data?.videos ??
      inf.profileData?.videos ??
      [],
    12
  );
  const searchVideos = compactVideoList(
    inf.searchVideos ?? inf.search_video_data ?? [],
    12
  );
  const allVideosForStats = [...videos, ...searchVideos];
  const views = inf.viewsData ?? inf.views ?? summarizeViews(allVideosForStats);
  const engagementSummary = summarizeEngagement(allVideosForStats);
  const engagement =
    mergeEngagementSummary(inf.engagement, engagementSummary);
  return {
    username: inf.username ?? null,
    displayName: inf.displayName || inf.name || null,
    profileUrl: inf.profileUrl ?? null,
    email,
    platform: inf.platform ?? null,
    followers: inf.followersData ?? inf.followers ?? null,
    views,
    bio:
      inf.bio ??
      inf.profile_data?.userInfo?.bio ??
      inf.profileData?.userInfo?.bio ??
      null,
    aboutLinks:
      inf.aboutLinks ??
      inf.profile_data?.userInfo?.aboutLinks ??
      inf.profileData?.userInfo?.aboutLinks ??
      null,
    aboutEmailSource:
      inf.aboutEmailSource ??
      inf.profile_data?.userInfo?.aboutEmailSource ??
      inf.profileData?.userInfo?.aboutEmailSource ??
      null,
    verified: inf.verified ?? null,
    engagement,
    videos,
    searchVideos,
    search_video_data: searchVideos,
    postsCount: inf.postsCount ?? null,
    videoPublishCountry: normalizeSnapshotVideoCountry(inf),
    videoPublishCountrySource:
      inf.video_publish_country_source ?? inf.videoPublishCountrySource ?? null,
    gmv,
    gmvDisplay,
    gmvCurrency: "USD",
    gmvPeriodDays: 30,
    gmvSource: inf.gmvSource ?? null,
    gmvUpdatedAt: inf.gmvUpdatedAt ?? null,
    unitsSold,
    unitsSoldDisplay,
    analysisSummary,
    matchAnalysis,
    writerIp: inf.writerIp ?? taskMeta.workerIp ?? null,
    writerHost: inf.writerHost ?? taskMeta.workerHost ?? null,
    enrichStatus: inf.enrichStatus ?? null,
    enrichError: inf.enrichError ?? inf.enrich_skipped_reason ?? null,
    dataIncomplete:
      typeof inf.dataIncomplete === "boolean" ? inf.dataIncomplete : null,
  };
}

/**
 * 批量插入候选红人（INSERT IGNORE：同一 campaign+tiktok_username 已存在则整行不写入、不覆盖）
 * @param {string} campaignId
 * @param {Array<Object>} influencers
 * @param {{ taskId?: number|null, runId?: string|null, searchKeyword?: string|null }} [taskMeta]
 * @returns {Promise<{ inserted: number }>}
 */
export async function upsertCandidatesForCampaign(campaignId, influencers, taskMeta = {}) {
  if (!campaignId || !Array.isArray(influencers) || influencers.length === 0) {
    return { inserted: 0, emailPatched: 0, newRecommendedInserted: 0 };
  }

  const existingRows = await queryTikTok(
    `
    SELECT LOWER(tiktok_username) AS u
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  const existingUsernames = new Set(
    (existingRows || []).map((r) => String(r.u || "").trim().toLowerCase()).filter(Boolean)
  );

  const allowIncompleteCandidates =
    process.env.DEBUG_WRITE_INCOMPLETE_CANDIDATES === "1";
  const globalEmailByUsername = await loadGlobalInfluencerEmailMap(
    influencers.map((inf) => resolveTiktokUsername(inf))
  );

  let newRecommendedInserted = 0;
  for (const inf of influencers) {
    if (inf?.dataIncomplete === true && !allowIncompleteCandidates) continue;
    if (inf?.isRecommended !== true) continue;
    const tiktokUsername = resolveTiktokUsername(inf);
    if (!tiktokUsername) continue;
    const norm = tiktokUsername.toLowerCase();
    if (existingUsernames.has(norm)) continue;

    try {
      await ingestKeywordSignalsFromRecommendedInfluencer(campaignId, inf, {
        productInfo: taskMeta.productInfo || {},
        taskMeta,
      });
    } catch (signalErr) {
      console.warn(
        `[upsertCandidatesForCampaign] 信号提取失败 @${tiktokUsername}:`,
        signalErr?.message || signalErr
      );
    }
    newRecommendedInserted += 1;
    existingUsernames.add(norm);
  }

  const now = new Date();
  const rows = [];

  for (const inf of influencers) {
    if (inf?.dataIncomplete === true && !allowIncompleteCandidates) continue;
    const tiktokUsername = resolveTiktokUsername(inf);
    if (!tiktokUsername) continue;
    const infForSnapshot = applyGlobalEmailFallback(
      inf,
      tiktokUsername,
      globalEmailByUsername
    );
    const platformInfluencerId = resolvePlatformInfluencerId(infForSnapshot);

    const matchScore =
      typeof infForSnapshot.recommendationScore === "number"
        ? infForSnapshot.recommendationScore
        : typeof infForSnapshot.score === "number"
          ? infForSnapshot.score
          : null;

    const shouldContact =
      typeof infForSnapshot.isRecommended === "boolean"
        ? infForSnapshot.isRecommended
          ? 1
          : 0
        : 0;

    const snapshot = buildNormalizedInfluencerSnapshot(infForSnapshot, taskMeta);
    const email = snapshot.email;
    const hasEmail = email ? 1 : 0;
    const analysisSummary = snapshot.analysisSummary;
    const matchAnalysis = JSON.stringify(snapshot.matchAnalysis);

    rows.push({
      tiktokUsername,
      platformInfluencerId,
      matchScore,
      shouldContact,
      analysisSummary,
      matchAnalysis,
      email,
      hasEmail,
      snapshot,
    });
  }

  if (rows.length === 0) {
    return { inserted: 0, emailPatched: 0, newRecommendedInserted };
  }

  const candidateSource =
    typeof taskMeta.source === "string" && taskMeta.source.trim()
      ? taskMeta.source.trim()
      : "web_search";

  for (const r of rows) {
    await syncGlobalInfluencerFromCandidateRow(campaignId, r);
  }

  const values = [];
  const placeholders = [];
  for (const r of rows) {
    placeholders.push("(?,?,?,?,?,?,?,?,?,?,?,?)");
    values.push(
      campaignId,
      r.tiktokUsername,
      r.platformInfluencerId,
      candidateSource,
      JSON.stringify(r.snapshot),
      r.matchScore,
      r.shouldContact,
      r.analysisSummary,
      r.matchAnalysis,
      r.email,
      r.hasEmail,
      now
    );
  }

  const sql = `
    INSERT INTO tiktok_campaign_influencer_candidates (
      campaign_id,
      tiktok_username,
      influencer_id,
      source,
      influencer_snapshot,
      match_score,
      should_contact,
      analysis_summary,
      match_analysis,
      email,
      has_email,
      analyzed_at
    )
    VALUES ${placeholders.join(",")}
    ON DUPLICATE KEY UPDATE
      should_contact = IF(
        VALUES(should_contact) = 1,
        1,
        tiktok_campaign_influencer_candidates.should_contact
      ),
      email = IF(
        tiktok_campaign_influencer_candidates.has_email = 0
          AND VALUES(has_email) = 1,
        VALUES(email),
        tiktok_campaign_influencer_candidates.email
      ),
      has_email = IF(
        tiktok_campaign_influencer_candidates.has_email = 0
          AND VALUES(has_email) = 1,
        1,
        tiktok_campaign_influencer_candidates.has_email
      ),
      influencer_snapshot = IF(
        tiktok_campaign_influencer_candidates.has_email = 0
          AND VALUES(has_email) = 1,
        VALUES(influencer_snapshot),
        tiktok_campaign_influencer_candidates.influencer_snapshot
      ),
      updated_at = IF(
        tiktok_campaign_influencer_candidates.has_email = 0
          AND VALUES(has_email) = 1,
        VALUES(analyzed_at),
        tiktok_campaign_influencer_candidates.updated_at
      )
  `;

  // The placeholder count varies with each batch, so do not cache this as a
  // server-side prepared statement.
  const [resultHeader] = await tiktokPool.query(sql, values);
  const affected = Number(resultHeader?.affectedRows ?? 0) || 0;
  const inserted = affected === 1 ? 1 : 0;
  const emailPatched = affected === 2 ? 1 : 0;

  const taskIdNum = Number(taskMeta.taskId || 0);
  if (taskIdNum > 0 && newRecommendedInserted > 0) {
    await bumpSearchTaskNewRecommendedInsertProgress(taskIdNum, newRecommendedInserted);
  }

  return { inserted, emailPatched, newRecommendedInserted };
}

/**
 * 从 tiktok_campaign_influencer_candidates 回填 tiktok_influencer（缓存键优先平台 userId，否则 handle）。
 */
export async function backfillTiktokInfluencerFromCampaignCandidates(campaignId) {
  if (!campaignId) return { attempted: 0, skippedNoProfileUrl: 0 };
  const dbRows = await queryTikTok(
    `
    SELECT tiktok_username, influencer_id, email, influencer_snapshot
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  let attempted = 0;
  let skippedNoProfileUrl = 0;
  for (const row of dbRows || []) {
    const snapshot = parseJson(row.influencer_snapshot) || {};
    const url = snapshot.profileUrl;
    if (!url || typeof url !== "string" || !url.trim()) {
      skippedNoProfileUrl += 1;
      continue;
    }
    attempted += 1;
    await syncGlobalInfluencerFromCandidateRow(campaignId, {
      tiktokUsername: row.tiktok_username,
      platformInfluencerId: row.influencer_id || null,
      email: row.email || snapshot.email || null,
      snapshot,
    });
  }
  return { attempted, skippedNoProfileUrl, totalCandidates: (dbRows || []).length };
}

export async function bumpSearchTaskNewRecommendedInsertProgress(taskId, delta = 1) {
  const id = Number(taskId || 0);
  const d = Number(delta || 0);
  if (!id || d <= 0) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_new_recommended_insert_count = progress_new_recommended_insert_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ?
  `,
    [d, id]
  );
}

export async function bumpSearchTaskProgress(
  taskId,
  analyzedDelta,
  { recommendedDelta = 0, contactableDelta = 0 } = {}
) {
  const id = Number(taskId || 0);
  const analyzed = Number(analyzedDelta || 0);
  const recommended = Number(recommendedDelta || 0);
  const contactable = Number(contactableDelta || 0);
  if (!id || (analyzed <= 0 && recommended <= 0 && contactable <= 0)) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_analyzed_count = progress_analyzed_count + ?,
        progress_recommended_count = progress_recommended_count + ?,
        progress_contactable_count = progress_contactable_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [analyzed, recommended, contactable, id]
  );
}

/** 搜索阶段结束：写入关键词搜索池频道数 */
export async function setSearchTaskSearchFoundCount(taskId, count) {
  const id = Number(taskId || 0);
  const n = Number(count || 0);
  if (!id || n < 0) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_search_found_count = ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [n, id]
  );
}

export async function bumpSearchTaskProfileBrowsedProgress(taskId, delta = 1) {
  const id = Number(taskId || 0);
  const d = Number(delta || 0);
  if (!id || d <= 0) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_profile_browsed_count = progress_profile_browsed_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [d, id]
  );
}

export async function bumpSearchTaskSkipCountryProgress(
  taskId,
  { unknownDelta = 0, mismatchDelta = 0 } = {}
) {
  const id = Number(taskId || 0);
  const unknown = Number(unknownDelta || 0);
  const mismatch = Number(mismatchDelta || 0);
  if (!id || (unknown <= 0 && mismatch <= 0)) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_skip_country_unknown_count = progress_skip_country_unknown_count + ?,
        progress_skip_country_mismatch_count = progress_skip_country_mismatch_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [unknown, mismatch, id]
  );
}

/** 工作笔记 / 任务结束摘要：从 task 表读取展示指标 */
export async function fetchSearchTaskWorkNoteMetrics(taskId) {
  const id = Number(taskId || 0);
  if (!id) {
    return {
      searchFoundCount: 0,
      profileBrowsedCount: 0,
      analyzedCount: 0,
      recommendedCount: 0,
      contactableCount: 0,
      skipCountryUnknownCount: 0,
      skipCountryMismatchCount: 0,
      newRecommendedInsertCount: 0,
    };
  }
  const rows = await queryTikTok(
    `
    SELECT
      progress_search_found_count AS searchFound,
      progress_profile_browsed_count AS profileBrowsed,
      progress_analyzed_count AS analyzed,
      progress_recommended_count AS recommended,
      progress_contactable_count AS contactable,
      progress_skip_country_unknown_count AS skipUnknown,
      progress_skip_country_mismatch_count AS skipMismatch,
      progress_new_recommended_insert_count AS newRecommendedInsert
    FROM tiktok_influencer_search_task
    WHERE id = ?
    LIMIT 1
  `,
    [id]
  );
  const r = rows?.[0] || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    searchFoundCount: num(r.searchFound ?? r.searchfound ?? r.SEARCH_FOUND),
    profileBrowsedCount: num(r.profileBrowsed ?? r.profilebrowsed ?? r.PROFILE_BROWSED),
    analyzedCount: num(r.analyzed ?? r.ANALYZED),
    recommendedCount: num(r.recommended ?? r.RECOMMENDED),
    contactableCount: num(r.contactable ?? r.CONTACTABLE),
    skipCountryUnknownCount: num(r.skipUnknown ?? r.skipunknown ?? r.SKIP_UNKNOWN),
    skipCountryMismatchCount: num(r.skipMismatch ?? r.skipmismatch ?? r.SKIP_MISMATCH),
    newRecommendedInsertCount: num(
      r.newRecommendedInsert ?? r.newrecommendedinsert ?? r.NEW_RECOMMENDED_INSERT
    ),
  };
}

/** 任务结束时写回最终摘要指标；使用 GREATEST 避免覆盖运行中已累加的更大值。 */
export async function setSearchTaskFinalMetrics(taskId, metrics = {}) {
  const id = Number(taskId || 0);
  if (!id) return;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_search_found_count = GREATEST(progress_search_found_count, ?),
        progress_profile_browsed_count = GREATEST(progress_profile_browsed_count, ?),
        progress_analyzed_count = GREATEST(progress_analyzed_count, ?),
        progress_recommended_count = GREATEST(progress_recommended_count, ?),
        progress_contactable_count = GREATEST(progress_contactable_count, ?),
        progress_skip_country_unknown_count = GREATEST(progress_skip_country_unknown_count, ?),
        progress_skip_country_mismatch_count = GREATEST(progress_skip_country_mismatch_count, ?),
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ?
  `,
    [
      num(metrics.searchFoundCount),
      num(metrics.profileBrowsedCount),
      num(metrics.analyzedCount),
      num(metrics.recommendedCount),
      num(metrics.contactableCount),
      num(metrics.skipCountryUnknownCount),
      num(metrics.skipCountryMismatchCount),
      id,
    ]
  );
}

/** 仅刷新 last_progress_at，供 worker 僵死回收判断（搜索结束 / 每条 enrich 完成） */
export async function touchSearchTaskLastProgressAt(taskId) {
  const id = Number(taskId || 0);
  if (!id) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [id]
  );
}

export async function bumpSearchTaskCountryProgress(
  taskId,
  { checkedDelta = 0, passedDelta = 0 } = {}
) {
  const id = Number(taskId || 0);
  const checked = Number(checkedDelta || 0);
  const passed = Number(passedDelta || 0);
  if (!id || (checked <= 0 && passed <= 0)) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_country_checked_count = progress_country_checked_count + ?,
        progress_country_passed_count = progress_country_passed_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [checked, passed, id]
  );
}

function parseTaskPayload(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return { ...raw };
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 追加本任务国家过滤结果到 payload.countryFilter.outcomes */
export async function appendSearchTaskCountryOutcome(
  taskId,
  outcome,
  allowedCountries = []
) {
  const id = Number(taskId || 0);
  if (!id || !outcome) return;

  const rows = await queryTikTok(
    `SELECT payload FROM tiktok_influencer_search_task WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows?.length) return;

  const payload = parseTaskPayload(rows[0].payload);
  if (!payload.countryFilter || typeof payload.countryFilter !== "object") {
    payload.countryFilter = { allowed: [], outcomes: [] };
  }
  if (!Array.isArray(payload.countryFilter.outcomes)) {
    payload.countryFilter.outcomes = [];
  }
  payload.countryFilter.allowed = (allowedCountries || [])
    .map((c) => String(c || "").trim())
    .filter(Boolean);
  payload.countryFilter.outcomes.push(outcome);

  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET payload = ?,
        updated_at = NOW()
    WHERE id = ?
  `,
    [JSON.stringify(payload), id]
  );
}
