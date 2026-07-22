import { NextResponse } from "next/server";
import { requireCrawlerOpsSuperAdmin } from "../../../../lib/auth/require-crawler-ops-super-admin.js";
import { listCrawlerSelfHealEvents } from "../../../../lib/db/crawler-self-heal-dao.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/crawler-self-heal-events?campaignId=&severity=warn|error|info&limit=50
 * 爬虫自愈事件（仅管理员，供 /ops 运维台使用）
 */
export async function GET(req) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const campaignId = searchParams.get("campaignId") || undefined;
    const severity = searchParams.get("severity") || undefined;
    const limit = parseInt(searchParams.get("limit") || "50", 10);

    const events = await listCrawlerSelfHealEvents({
      campaignId,
      severity,
      limit,
    });

    const warnErrorCount = events.filter(
      (e) => e.severity === "warn" || e.severity === "error"
    ).length;

    return NextResponse.json({
      success: true,
      events,
      count: events.length,
      warnErrorCount,
    });
  } catch (error) {
    console.error("[ops/crawler-self-heal-events]", error);
    return NextResponse.json(
      { success: false, error: error.message || "查询失败" },
      { status: 500 }
    );
  }
}
