import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { getCrawlerFleetSnapshot } from "../../../../lib/db/crawler-fleet-ops-dao.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/crawler-fleet-snapshot
 * 14 台爬虫机器矩阵：健康 + 各平台最近完成搜索任务 + 最近导入任务
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

    const snapshot = await getCrawlerFleetSnapshot();

    return NextResponse.json({
      success: true,
      ...snapshot,
    });
  } catch (error) {
    console.error("[ops/crawler-fleet-snapshot]", error);
    return NextResponse.json(
      { success: false, error: error.message || "查询失败" },
      { status: 500 }
    );
  }
}
