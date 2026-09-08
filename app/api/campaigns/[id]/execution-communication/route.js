import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessCampaign } from "../../../../../lib/auth/campaign-access.js";
import { getExecutionCommunicationTimeline } from "../../../../../lib/db/campaign-communication-dao.js";

/**
 * GET /api/campaigns/[id]/execution-communication?username=xxx
 * 返回单个红人卡片“沟通记录”的结构化事件流：
 * 特殊请求（品牌方发起 / 红人反馈）+ 砍价记录 + 交付时间线，按时间倒序。
 */
export async function GET(req, { params }) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json(
        { success: false, error: "请先登录" },
        { status: 401 }
      );
    }

    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const access = await assertUserCanAccessCampaign(campaignId, auth);
    if (!access.ok) {
      return NextResponse.json(
        {
          success: false,
          error:
            access.status === 403
              ? "无权查看该 Campaign"
              : access.status === 404
              ? "Campaign 不存在"
              : "无权查看",
        },
        { status: access.status }
      );
    }

    const { searchParams } = new URL(req.url);
    const username = searchParams.get("username") || "";
    if (!username.trim()) {
      return NextResponse.json(
        { success: false, error: "缺少 username" },
        { status: 400 }
      );
    }

    const data = await getExecutionCommunicationTimeline({
      campaignId,
      influencerId: username,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[Campaign Communication API] 获取沟通记录失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取沟通记录失败" },
      { status: 500 }
    );
  }
}
