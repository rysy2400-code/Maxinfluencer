import { queryTikTok } from "./mysql-tiktok.js";

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

/**
 * 选取本 campaign 下建议联系且未被消费的候选红人
 * @returns {Promise<Array<{ influencerId: string, snapshot: object, matchScore: number|null }>>}
 */
export async function pickCandidatesForExecution(campaignId, limit) {
  const limitInt = Math.max(0, Math.min(1000, Number(limit) || 0));
  if (limitInt <= 0) return [];

  // NOTE: 部分 MySQL 环境不支持在 LIMIT 中使用预编译占位符，这里安全地内联 limitInt
  const rows = await queryTikTok(
    `
    SELECT
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
        WHERE e.campaign_id = c.campaign_id AND e.influencer_id = c.influencer_id
      )
    ORDER BY
      COALESCE(c.match_score, 0) DESC,
      COALESCE(c.analyzed_at, c.created_at) DESC
    LIMIT ${limitInt}
  `,
    [campaignId]
  );

  return (rows || []).map((r) => ({
    influencerId: r.influencer_id,
    snapshot: parseJson(r.influencer_snapshot) || {},
    matchScore: typeof r.match_score === "number" ? r.match_score : null,
  }));
}

export async function markCandidatePicked(campaignId, influencerId, pickedAt) {
  await queryTikTok(
    `
    UPDATE tiktok_campaign_influencer_candidates
    SET picked_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND influencer_id = ?
  `,
    [pickedAt, campaignId, influencerId]
  );
}

/**
 * 批量 upsert 候选红人（来源于「搜索 + 主页 + 匹配分析」pipeline）
 * @param {string} campaignId
 * @param {Array<Object>} influencers - 来自 searchAndExtractInfluencers 的记录（包含 username / isRecommended / score / reason / analysis 等）
 */
export async function upsertCandidatesForCampaign(campaignId, influencers) {
  if (!campaignId || !Array.isArray(influencers) || influencers.length === 0) return;

  const now = new Date();
  const rows = [];

  for (const inf of influencers) {
    const influencerId = inf.influencerId || inf.influencer_id || inf.username || inf.id;
    if (!influencerId) continue;

    const matchScore =
      typeof inf.recommendationScore === "number"
        ? inf.recommendationScore
        : typeof inf.score === "number"
        ? inf.score
        : null;

    const shouldContact =
      typeof inf.isRecommended === "boolean" ? (inf.isRecommended ? 1 : 0) : 0;

    const summary =
      inf.recommendationReason ||
      inf.reason ||
      (shouldContact ? "匹配度较高，建议联系" : "匹配度一般或较低") ||
      null;
    const email = resolveCandidateEmail(inf);
    const hasEmail = email ? 1 : 0;

    const snapshot = {
      username: inf.username,
      displayName: inf.displayName || inf.name,
      profileUrl: inf.profileUrl,
      email,
      platform: inf.platform,
      followers: inf.followersData || inf.followers,
      views: inf.viewsData || inf.views,
      bio: inf.bio,
      verified: inf.verified,
      engagement: inf.engagement,
      postsCount: inf.postsCount,
    };

    rows.push({
      influencerId,
      matchScore,
      shouldContact,
      analysisSummary: summary,
      email,
      hasEmail,
      snapshot,
    });
  }

  if (rows.length === 0) return;

  const values = [];
  const placeholders = [];
  for (const r of rows) {
    placeholders.push("(?,?,?,?,?,?,?,?,?,?)");
    values.push(
      campaignId,
      r.influencerId,
      "web_search",
      JSON.stringify(r.snapshot),
      r.matchScore,
      r.shouldContact,
      r.analysisSummary,
      r.email,
      r.hasEmail,
      now
    );
  }

  const sql = `
    INSERT INTO tiktok_campaign_influencer_candidates (
      campaign_id,
      influencer_id,
      source,
      influencer_snapshot,
      match_score,
      should_contact,
      analysis_summary,
      email,
      has_email,
      analyzed_at
    )
    VALUES ${placeholders.join(",")}
    ON DUPLICATE KEY UPDATE
      source = VALUES(source),
      influencer_snapshot = VALUES(influencer_snapshot),
      match_score = VALUES(match_score),
      should_contact = VALUES(should_contact),
      analysis_summary = VALUES(analysis_summary),
      email = VALUES(email),
      has_email = VALUES(has_email),
      analyzed_at = VALUES(analyzed_at),
      updated_at = CURRENT_TIMESTAMP
  `;

  await queryTikTok(sql, values);
}


