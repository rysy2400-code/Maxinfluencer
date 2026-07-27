import { queryTikTok } from "./mysql-tiktok.js";

function count(value) {
  return Number(value || 0);
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

const COHORT_CTES = `
  WITH first_touch AS (
    SELECT
      influencer_id,
      MIN(COALESCE(event_time, sent_at, created_at)) AS first_touched_at
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id IS NOT NULL
      AND influencer_id <> ''
      AND channel = 'email'
      AND direction = 'bin'
      AND event_type = 'email_outbound'
    GROUP BY influencer_id
  ),
  first_reply AS (
    SELECT
      influencer_id,
      MIN(COALESCE(event_time, sent_at, created_at)) AS first_replied_at
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id IS NOT NULL
      AND influencer_id <> ''
      AND channel = 'email'
      AND direction = 'influencer'
      AND event_type = 'email_inbound'
    GROUP BY influencer_id
  ),
  cohort AS (
    SELECT
      ft.influencer_id,
      ft.first_touched_at,
      fr.first_replied_at,
      i.platform,
      i.username,
      i.display_name,
      i.business_profile_markdown,
      i.business_profile_updated_at
    FROM first_touch ft
    LEFT JOIN first_reply fr
      ON fr.influencer_id = ft.influencer_id
     AND fr.first_replied_at >= ft.first_touched_at
    LEFT JOIN tiktok_influencer i
      ON i.influencer_id = ft.influencer_id
    WHERE ft.first_touched_at >= ?
      AND ft.first_touched_at < ?
  ),
  profiles AS (
    SELECT *
    FROM cohort
    WHERE first_replied_at IS NOT NULL
      AND business_profile_markdown IS NOT NULL
      AND TRIM(business_profile_markdown) <> ''
  ),
  opportunities AS (
    SELECT
      p.influencer_id,
      e.campaign_id,
      e.created_at AS recommended_at,
      JSON_UNQUOTE(JSON_EXTRACT(e.last_event, '$.systemQuoteApprovedAt')) AS advertiser_approved_at,
      JSON_UNQUOTE(JSON_EXTRACT(e.last_event, '$.creatorConfirmedSystemQuoteAt')) AS creator_confirmed_at
    FROM profiles p
    INNER JOIN tiktok_campaign_execution e
      ON (
        e.influencer_id = p.influencer_id
        OR (
          p.username IS NOT NULL
          AND LOWER(TRIM(LEADING '@' FROM e.tiktok_username)) = LOWER(TRIM(LEADING '@' FROM p.username))
        )
      )
     AND e.source = 'algorithm_recommendation'
     AND e.created_at >= p.first_touched_at
  )`;

export async function getBusinessProfileOpsSnapshot({ startAt, endAt, now = new Date() }) {
  const params = [startAt, endAt];
  const [summaryRows, detailRows] = await Promise.all([
    queryTikTok(
      `${COHORT_CTES}
       SELECT
         (SELECT COUNT(*) FROM cohort) AS touched_count,
         (SELECT COUNT(*) FROM cohort WHERE first_replied_at IS NOT NULL) AS replied_count,
         (SELECT COUNT(*) FROM profiles) AS profile_count,
         (SELECT COUNT(*) FROM opportunities) AS recommendation_count,
         (SELECT COUNT(*) FROM opportunities WHERE advertiser_approved_at IS NOT NULL) AS advertiser_approved_count,
         (SELECT COUNT(*) FROM opportunities WHERE creator_confirmed_at IS NOT NULL) AS creator_confirmed_count`,
      params
    ),
    queryTikTok(
      `${COHORT_CTES}
       SELECT
         p.influencer_id,
         p.platform,
         p.username,
         p.display_name,
         p.first_touched_at,
         p.first_replied_at,
         p.business_profile_markdown,
         p.business_profile_updated_at,
         COUNT(o.campaign_id) AS recommendation_count,
         SUM(o.advertiser_approved_at IS NOT NULL) AS advertiser_approved_count,
         SUM(o.creator_confirmed_at IS NOT NULL) AS creator_confirmed_count
       FROM profiles p
       LEFT JOIN opportunities o ON o.influencer_id = p.influencer_id
       GROUP BY
         p.influencer_id, p.platform, p.username, p.display_name,
         p.first_touched_at, p.first_replied_at,
         p.business_profile_markdown, p.business_profile_updated_at
       ORDER BY
         (SUM(o.advertiser_approved_at IS NOT NULL) - SUM(o.creator_confirmed_at IS NOT NULL)) DESC,
         COUNT(o.campaign_id) DESC,
         p.business_profile_updated_at DESC,
         p.influencer_id ASC`,
      params
    ),
  ]);

  const row = summaryRows?.[0] || {};
  const touched = count(row.touched_count);
  const replied = count(row.replied_count);
  const profiles = count(row.profile_count);
  const recommendations = count(row.recommendation_count);
  const advertiserApproved = count(row.advertiser_approved_count);
  const creatorConfirmed = count(row.creator_confirmed_count);

  return {
    snapshotAt: now.toISOString(),
    cohort: { startAt, endAt },
    acquisition: {
      touched,
      replied,
      profiles,
      replyRate: rate(replied, touched),
      profileRate: rate(profiles, replied),
    },
    cooperation: {
      recommendations,
      advertiserApproved,
      creatorConfirmed,
      advertiserApprovalRate: rate(advertiserApproved, recommendations),
      creatorConfirmationRate: rate(creatorConfirmed, advertiserApproved),
    },
    influencers: (detailRows || []).map((item) => {
      const recommendationCount = count(item.recommendation_count);
      const advertiserApprovedCount = count(item.advertiser_approved_count);
      const creatorConfirmedCount = count(item.creator_confirmed_count);
      return {
        influencerId: String(item.influencer_id),
        platform: item.platform || null,
        username: item.username || null,
        displayName: item.display_name || null,
        firstTouchedAt: item.first_touched_at || null,
        firstRepliedAt: item.first_replied_at || null,
        businessProfileMarkdown: item.business_profile_markdown || "",
        businessProfileUpdatedAt: item.business_profile_updated_at || null,
        recommendationCount,
        advertiserApprovedCount,
        advertiserApprovalRate: rate(advertiserApprovedCount, recommendationCount),
        creatorConfirmedCount,
        creatorConfirmationRate: rate(creatorConfirmedCount, advertiserApprovedCount),
      };
    }),
  };
}
