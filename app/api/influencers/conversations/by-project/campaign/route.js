import { NextResponse } from "next/server";
import { listCampaignInfluencers } from "../../../../../../lib/db/influencer-inbox-by-project-dao.js";
import { requireInboxAdmin } from "../../../../../../lib/auth/influencer-inbox-auth-http.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const gate = await requireInboxAdmin(req);
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(req.url);
    const advertiserUserId = searchParams.get("advertiserUserId");
    const campaignId = searchParams.get("campaignId");
    const q = searchParams.get("q") || null;

    if (!campaignId || advertiserUserId == null || advertiserUserId === "") {
      return NextResponse.json(
        { success: false, error: "缺少 campaignId / advertiserUserId" },
        { status: 400 }
      );
    }

    const result = await listCampaignInfluencers({
      advertiserUserId,
      campaignId,
      q,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("[Campaign Influencers API] 失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取 campaign 红人列表失败" },
      { status: 500 }
    );
  }
}
