import { NextResponse } from "next/server";
import { requireCrawlerOpsSuperAdmin } from "../../../../lib/auth/require-crawler-ops-super-admin.js";
import { getEmailOpsSnapshot } from "../../../../lib/db/email-ops-dao.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(request);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    return NextResponse.json({ success: true, ...(await getEmailOpsSnapshot()) });
  } catch (error) {
    console.error("[ops/email-health]", error);
    return NextResponse.json(
      { success: false, error: error?.message || "邮箱指标查询失败" },
      { status: 500 }
    );
  }
}
