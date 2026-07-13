import { queryTikTok } from "./mysql-tiktok.js";
import { extractKeywordSignalsFromInfluencer } from "../influencer/extract-keyword-signals.js";
import { normalizePlatformSlug } from "../influencer/resolve-campaign-platforms.js";

const COOLDOWN_DAYS_ZERO_YIELD = 14;
const COOLDOWN_DAYS_WITH_YIELD = 7;
const PROMPT_SIGNAL_LIMIT = 10;

export function normalizeSignalMatchKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[@#]/, "")
    .replace(/\s+/g, " ");
}

function resolveInfluencerPlatformSlug(influencer = {}, taskMeta = {}) {
  const fromInf = normalizePlatformSlug(
    influencer.platform || influencer.snapshot?.platform || null
  );
  if (fromInf) return fromInf;
  const fromMeta = normalizePlatformSlug(taskMeta.platform || null);
  if (fromMeta) return fromMeta;
  return "tiktok";
}

function resolveContributorUsername(influencer = {}) {
  const raw =
    influencer.username ||
    influencer.tiktokUsername ||
    influencer.tiktok_username ||
    influencer.handle ||
    null;
  const s = String(raw || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  return s || null;
}

async function upsertOneSignal({
  campaignId,
  platform,
  signalType,
  signalValue,
  contributorUsername,
  occurrenceDelta = 1,
}) {
  if (!campaignId || !platform || !signalType || !signalValue || !contributorUsername) {
    return;
  }

  const contributorResult = await queryTikTok(
    `
    INSERT IGNORE INTO tiktok_campaign_keyword_signal_contributor (
      campaign_id,
      platform,
      signal_type,
      signal_value,
      contributor_username
    ) VALUES (?, ?, ?, ?, ?)
  `,
    [campaignId, platform, signalType, signalValue, contributorUsername]
  );

  const contributorInserted = Number(contributorResult?.affectedRows || 0) > 0;
  const influencerDelta = contributorInserted ? 1 : 0;

  await queryTikTok(
    `
    INSERT INTO tiktok_campaign_keyword_signals (
      campaign_id,
      platform,
      signal_type,
      signal_value,
      influencer_count,
      occurrence_count,
      first_seen_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      influencer_count = influencer_count + ?,
      occurrence_count = occurrence_count + ?,
      last_seen_at = NOW()
  `,
    [
      campaignId,
      platform,
      signalType,
      signalValue,
      influencerDelta,
      occurrenceDelta,
      influencerDelta,
      occurrenceDelta,
    ]
  );
}

/**
 * 从首次入库的 isRecommended 红人提取信号写入池。
 */
export async function ingestKeywordSignalsFromRecommendedInfluencer(
  campaignId,
  influencer = {},
  options = {}
) {
  if (!campaignId || influencer?.isRecommended !== true) return { ingested: 0 };

  const platform = resolveInfluencerPlatformSlug(influencer, options.taskMeta || {});
  const contributorUsername = resolveContributorUsername(influencer);
  if (!contributorUsername) return { ingested: 0 };

  const { hashtags, mentions } = extractKeywordSignalsFromInfluencer(
    influencer,
    options.productInfo || {}
  );

  let ingested = 0;
  for (const tag of hashtags) {
    await upsertOneSignal({
      campaignId,
      platform,
      signalType: "hashtag",
      signalValue: tag,
      contributorUsername,
    });
    ingested += 1;
  }
  for (const mention of mentions) {
    await upsertOneSignal({
      campaignId,
      platform,
      signalType: "mention",
      signalValue: mention,
      contributorUsername,
    });
    ingested += 1;
  }

  return { ingested };
}

/**
 * 取当前平台可注入 prompt 的 top 信号（未在冷却期）。
 * Instagram 仅返回 hashtag。
 */
export async function getPromptKeywordSignals(campaignId, platform) {
  const platformSlug = normalizePlatformSlug(platform) || "tiktok";
  if (!campaignId) return [];

  const rows = await queryTikTok(
    `
    SELECT
      signal_type AS signalType,
      signal_value AS signalValue,
      influencer_count AS influencerCount,
      consumed_at AS consumedAt,
      last_new_recommended_count AS lastNewRecommendedCount
    FROM tiktok_campaign_keyword_signals
    WHERE campaign_id = ?
      AND platform = ?
      AND (
        consumed_at IS NULL
        OR (
          last_new_recommended_count > 0
          AND consumed_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        )
        OR (
          last_new_recommended_count = 0
          AND consumed_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        )
      )
    ORDER BY influencer_count DESC, last_seen_at DESC
    LIMIT 50
  `,
    [
      campaignId,
      platformSlug,
      COOLDOWN_DAYS_WITH_YIELD,
      COOLDOWN_DAYS_ZERO_YIELD,
    ]
  );

  let list = (rows || []).map((r) => ({
    signal_type: r.signalType,
    signal_value: r.signalValue,
    influencer_count: Number(r.influencerCount || 0),
  }));

  if (platformSlug === "instagram") {
    list = list.filter((s) => s.signal_type === "hashtag");
  }

  return list.slice(0, PROMPT_SIGNAL_LIMIT);
}

/**
 * 搜索任务完成后，按 keyword 归一化匹配并标记 signal 消费。
 */
export async function consumeKeywordSignalForSearch({
  campaignId,
  platform,
  keyword,
  newRecommendedCount = 0,
}) {
  const platformSlug = normalizePlatformSlug(platform) || "tiktok";
  const matchKey = normalizeSignalMatchKey(keyword);
  if (!campaignId || !matchKey) return { consumed: false };

  const rows = await queryTikTok(
    `
    SELECT id, signal_value AS signalValue
    FROM tiktok_campaign_keyword_signals
    WHERE campaign_id = ?
      AND platform = ?
  `,
    [campaignId, platformSlug]
  );

  const hit = (rows || []).find(
    (r) => normalizeSignalMatchKey(r.signalValue) === matchKey
  );
  if (!hit) return { consumed: false };

  await queryTikTok(
    `
    UPDATE tiktok_campaign_keyword_signals
    SET consumed_at = NOW(),
        last_new_recommended_count = ?,
        last_seen_at = NOW()
    WHERE id = ?
  `,
    [Math.max(0, Number(newRecommendedCount || 0)), hit.id]
  );

  return { consumed: true, signalValue: hit.signalValue };
}
