import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";

/**
 * GET /api/campaigns/[id]/influencers
 * 返回某个 campaign 下参与执行的红人列表，并带最近对话预览与托管模式。
 */
export async function GET(req, { params }) {
  try {
    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const rows = await queryTikTok(
      `
      WITH execs AS (
        SELECT
          tiktok_username,
          influencer_id AS platform_influencer_id
        FROM tiktok_campaign_execution
        WHERE campaign_id = ?
      ),
      message_keys AS (
        SELECT tiktok_username, platform_influencer_id AS message_key
        FROM execs
        WHERE platform_influencer_id IS NOT NULL
          AND TRIM(platform_influencer_id) <> ''
        UNION
        SELECT tiktok_username, tiktok_username AS message_key
        FROM execs
        WHERE tiktok_username IS NOT NULL
          AND TRIM(tiktok_username) <> ''
      ),
      ranked AS (
        SELECT
          k.tiktok_username,
          m.id AS msg_id,
          m.event_time,
          m.sent_at,
          m.created_at,
          m.event_type,
          m.actor_type,
          m.subject,
          m.body_text,
          ROW_NUMBER() OVER (
            PARTITION BY k.tiktok_username
            ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC
          ) AS rn
        FROM message_keys k
        INNER JOIN tiktok_influencer_conversation_messages m
          ON m.influencer_id = k.message_key
      ),
      latest_messages AS (
        SELECT *
        FROM ranked
        WHERE rn = 1
      ),
      influencer_keys AS (
        SELECT tiktok_username, platform_influencer_id AS influencer_key
        FROM execs
        WHERE platform_influencer_id IS NOT NULL
          AND TRIM(platform_influencer_id) <> ''
        UNION
        SELECT tiktok_username, tiktok_username AS influencer_key
        FROM execs
        WHERE tiktok_username IS NOT NULL
          AND TRIM(tiktok_username) <> ''
      ),
      influencer_matches AS (
        SELECT
          k.tiktok_username,
          i.display_name,
          i.username,
          i.avatar_url,
          i.influencer_email,
          i.handover_mode,
          ROW_NUMBER() OVER (
            PARTITION BY k.tiktok_username
            ORDER BY i.id DESC
          ) AS rn
        FROM influencer_keys k
        LEFT JOIN tiktok_influencer i
          ON i.influencer_id = k.influencer_key
      ),
      latest_influencers AS (
        SELECT *
        FROM influencer_matches
        WHERE rn = 1
      )
      SELECT
        e.tiktok_username AS influencer_id,
        i.display_name,
        i.username,
        i.avatar_url,
        i.influencer_email,
        i.handover_mode,
        r.msg_id AS last_message_id,
        COALESCE(r.event_time, r.sent_at, r.created_at) AS last_event_time,
        r.event_type AS last_event_type,
        r.actor_type AS last_actor_type,
        r.subject AS last_subject,
        r.body_text AS last_body_text
      FROM execs e
      LEFT JOIN latest_influencers i
        ON i.tiktok_username = e.tiktok_username
      LEFT JOIN latest_messages r
        ON r.tiktok_username = e.tiktok_username
      ORDER BY last_event_time DESC, e.tiktok_username ASC
    `,
      [campaignId]
    );

    const items = (rows || []).map((r) => ({
      influencerId: r.influencer_id,
      displayName: r.display_name || null,
      username: r.username || null,
      avatarUrl: r.avatar_url || null,
      influencerEmail: r.influencer_email || null,
      handoverMode: r.handover_mode || "auto",
      lastEventTime: r.last_event_time || null,
      lastPreview: {
        eventType: r.last_event_type || null,
        actorType: r.last_actor_type || null,
        subject: r.last_subject || null,
        bodyText: r.last_body_text || null,
      },
    }));

    return NextResponse.json({
      success: true,
      items,
      count: items.length,
    });
  } catch (error) {
    console.error("[Campaign Influencers API] 获取失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取 campaign influencers 失败" },
      { status: 500 }
    );
  }
}
