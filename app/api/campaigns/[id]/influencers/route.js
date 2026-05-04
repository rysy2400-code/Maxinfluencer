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

    // MySQL 8 支持窗口函数：为每个 influencer 取最新一条对话记录作为预览
    const rows = await queryTikTok(
      `
      WITH execs AS (
        SELECT influencer_id
        FROM tiktok_campaign_execution
        WHERE campaign_id = ?
      ),
      ranked AS (
        SELECT
          m.*,
          ROW_NUMBER() OVER (
            PARTITION BY m.influencer_id
            ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC
          ) AS rn
        FROM tiktok_influencer_conversation_messages m
        JOIN execs e ON e.influencer_id = m.influencer_id
      )
      SELECT
        e.influencer_id,
        i.display_name,
        i.username,
        i.avatar_url,
        i.influencer_email,
        i.handover_mode,
        r.id AS last_message_id,
        COALESCE(r.event_time, r.sent_at, r.created_at) AS last_event_time,
        r.event_type AS last_event_type,
        r.actor_type AS last_actor_type,
        r.subject AS last_subject,
        r.body_text AS last_body_text
      FROM execs e
      LEFT JOIN tiktok_influencer i ON i.influencer_id = e.influencer_id
      LEFT JOIN ranked r ON r.influencer_id = e.influencer_id AND r.rn = 1
      ORDER BY last_event_time DESC, e.influencer_id ASC
    `,
      [campaignId]
    );

    const items = (rows || []).map((r) => ({
      influencerId: r.influencer_id,
      displayName: r.display_name || null,
      username: r.username || null,
      avatarUrl: r.avatar_url || null,
      influencerEmail: r.influencer_email || null,
      handoverMode: r.handover_mode || "assist",
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

