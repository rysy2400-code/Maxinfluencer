import { NextResponse } from "next/server";
import { getCampaignById } from "../../../../../lib/db/campaign-dao.js";
import { getReportConfigByCampaignId } from "../../../../../lib/db/campaign-report-config-dao.js";

/**
 * GET /api/campaigns/[id]/report-config
 * 返回执行节奏 + 汇报配置 + 异常规则，供前端右侧文档展示
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

    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: "Campaign 不存在" },
        { status: 404 }
      );
    }

    const reportConfig = await getReportConfigByCampaignId(campaignId);

    return NextResponse.json({
      success: true,
      campaignId,
      influencersPerDay: campaign.influencersPerDay ?? null,
      keywordStrategy: campaign.keywordStrategy || null,
      reportConfig: reportConfig || null,
    });
  } catch (error) {
    console.error("[Campaign ReportConfig API] 获取配置失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取配置失败" },
      { status: 500 }
    );
  }
}

