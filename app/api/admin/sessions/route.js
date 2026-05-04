import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { listCampaignSessionsForAdmin } from "../../../../lib/db/campaign-session-dao.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/sessions?status=draft|published&limit=100
 * 仅 is_admin 用户可访问
 */
export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
    }
    if (!auth.isAdmin) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") || null;
    const limit = parseInt(searchParams.get("limit") || "100", 10);

    const sessions = await listCampaignSessionsForAdmin({
      status: status === "draft" || status === "published" ? status : null,
      limit,
    });

    return NextResponse.json({ success: true, sessions, count: sessions.length });
  } catch (error) {
    console.error("[admin/sessions]", error);
    return NextResponse.json(
      { success: false, error: error.message || "查询失败" },
      { status: 500 }
    );
  }
}
