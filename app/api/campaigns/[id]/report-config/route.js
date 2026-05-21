import { NextResponse } from "next/server";
import { getCampaignById } from "../../../../../lib/db/campaign-dao.js";
import { getReportConfigByCampaignId } from "../../../../../lib/db/campaign-report-config-dao.js";
import { CAMPAIGN_STATUS_UI_LABEL } from "../../../../../lib/tools/campaign-execution/campaign-execution-tools.js";

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
    const ip = campaign.influencerProfile || {};

    const status = campaign.status || "running";
    const statusLabel = CAMPAIGN_STATUS_UI_LABEL[status] || status;

    return NextResponse.json({
      success: true,
      campaignId,
      status,
      statusLabel,
      influencersPerDay: campaign.influencersPerDay ?? null,
      keywordStrategy: campaign.keywordStrategy || null,
      /** 与 tiktok_campaign.influencer_profile 对齐，供工作笔记分项展示 */
      influencerProfile: {
        followerRange: ip.followerRange ?? null,
        viewRange: ip.viewRange ?? null,
        accountType: ip.accountType ?? null,
      },
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

