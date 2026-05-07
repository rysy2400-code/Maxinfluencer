import { NextResponse } from "next/server";
import { getCampaignExecutionStatus } from "../../../../../lib/db/campaign-dao.js";

/**
 * GET /api/campaigns/[id]/execution-status
 * 返回红人执行进度：已联系、待审核价格、待寄样品、待审核草稿、已发布视频
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

    const data = await getCampaignExecutionStatus(campaignId);

    if (!data) {
      return NextResponse.json(
        { success: false, error: "Campaign 不存在" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error("[Campaign Execution API] 获取执行状态失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取执行状态失败" },
      { status: 500 }
    );
  }
}
