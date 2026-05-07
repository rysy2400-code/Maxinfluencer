import tiktokPool, { queryTikTok } from "./mysql-tiktok.js";
import { upsertInfluencer } from "./influencer-dao.js";

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
  if (!email) return null;
  return email;
}

function resolveCandidateEmail(inf) {
  return (
    normalizeEmail(inf?.email) ||
    normalizeEmail(inf?.profile_data?.userInfo?.email) ||
    null
  );
}

/** TikTok userId 字符串（与 tiktok_influencer.influencer_id 一致） */
export function resolvePlatformInfluencerId(inf = {}) {
  const raw =
    inf.tiktokUserId ??
    inf.tiktok_user_id ??
    inf.userId ??
    inf.profile_data?.userInfo?.userId ??
    inf.profile_data?.userInfo?.user_id ??
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

/** 与执行表/候选表 influencer_snapshot.views 结构一致：number 或 { avg } */
export function avgViewsFromSnapshot(s) {
  const v = s?.views;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v.avg === "number" && Number.isFinite(v.avg)) return v.avg;
  return null;
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
    await upsertInfluencer({
      influencerId: String(r.platformInfluencerId).trim(),
      platform: r.snapshot.platform || "tiktok",
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
      c.match_score
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
  return {
    username: inf.username ?? null,
    displayName: inf.displayName || inf.name || null,
    profileUrl: inf.profileUrl ?? null,
    email,
    platform: inf.platform ?? null,
    followers: inf.followersData ?? inf.followers ?? null,
    views: inf.viewsData ?? inf.views ?? null,
    bio: inf.bio ?? null,
    verified: inf.verified ?? null,
    engagement: inf.engagement ?? null,
    postsCount: inf.postsCount ?? null,
    analysisSummary,
    matchAnalysis,
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
    return { inserted: 0 };
  }

  const now = new Date();
  const rows = [];

  for (const inf of influencers) {
    const tiktokUsername = resolveTiktokUsername(inf);
    if (!tiktokUsername) continue;
    const platformInfluencerId = resolvePlatformInfluencerId(inf);

    const matchScore =
      typeof inf.recommendationScore === "number"
        ? inf.recommendationScore
        : typeof inf.score === "number"
          ? inf.score
          : null;

    const shouldContact =
      typeof inf.isRecommended === "boolean" ? (inf.isRecommended ? 1 : 0) : 0;

    const snapshot = buildNormalizedInfluencerSnapshot(inf, taskMeta);
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

  if (rows.length === 0) return { inserted: 0 };

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
      "web_search",
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
    INSERT IGNORE INTO tiktok_campaign_influencer_candidates (
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
  `;

  const [resultHeader] = await tiktokPool.execute(sql, values);
  const inserted = Number(resultHeader?.affectedRows ?? 0) || 0;
  return { inserted };
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

export async function bumpSearchTaskProgress(taskId, analyzedDelta) {
  const id = Number(taskId || 0);
  const delta = Number(analyzedDelta || 0);
  if (!id || delta <= 0) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET progress_analyzed_count = progress_analyzed_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [delta, id]
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
