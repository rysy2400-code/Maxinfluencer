import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";
import { markCandidatePicked } from "../../../../../lib/db/campaign-candidates-dao.js";

/**
 * POST /api/campaigns/[id]/outreach
 * 手动触发「联系某位红人」：
 * - 将候选红人写入执行表（pending_quote）
 * - 标记候选为 picked（后续由执行心跳 / InfluencerAgent 负责真正 DM/邮件）
 */
export async function POST(req, { params }) {
  try {
    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const body = await req.json();
    const influencerId = body?.influencerId;
    if (!influencerId) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId" },
        { status: 400 }
      );
    }

    // 读取候选快照
    const rows = await queryTikTok(
      `
      SELECT influencer_snapshot, match_score
      FROM tiktok_campaign_influencer_candidates
      WHERE campaign_id = ? AND influencer_id = ?
    `,
      [campaignId, influencerId]
    );
    if (!rows || rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "未找到该红人的候选记录" },
        { status: 404 }
      );
    }

    let snapshot = null;
    try {
      snapshot =
        typeof rows[0].influencer_snapshot === "string"
          ? JSON.parse(rows[0].influencer_snapshot || "{}")
          : rows[0].influencer_snapshot || {};
    } catch {
      snapshot = {};
    }
    const matchScore =
      typeof rows[0].match_score === "number" ? rows[0].match_score : null;

    // 插入执行表（若已存在则忽略）
    const now = new Date();
    await queryTikTok(
      `
      INSERT IGNORE INTO tiktok_campaign_execution (
        campaign_id,
        influencer_id,
        influencer_snapshot,
        stage,
        last_event
      )
      VALUES (?, ?, ?, 'pending_quote', ?)
    `,
      [
        campaignId,
        influencerId,
        JSON.stringify(snapshot),
        JSON.stringify({
          createdBy: "manual-outreach",
          createdAt: now.toISOString(),
          note: "通过前端「联系这位红人」按钮手动加入执行队列，待红人经纪人发送 DM/邮件。",
          matchScore,
        }),
      ]
    );

    // 标记候选已被消费
    await markCandidatePicked(campaignId, influencerId, now);

    // TODO：后续在此处接入真正的 InfluencerAgent 发送 DM/邮件

    return NextResponse.json({
      success: true,
      data: { campaignId, influencerId },
    });
  } catch (error) {
    console.error("[Campaign Outreach API] 联系红人失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "联系红人失败" },
      { status: 500 }
    );
  }
}

