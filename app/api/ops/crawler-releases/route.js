import { NextResponse } from "next/server";
import { requireCrawlerOpsSuperAdmin } from "../../../../lib/auth/require-crawler-ops-super-admin.js";
import {
  listCrawlerReleases,
} from "../../../../lib/db/crawler-ops-registry-dao.js";
import { setActiveCrawlerRelease } from "../../../../lib/ops/crawler-release-service.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(req);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    return NextResponse.json({ success: true, releases: await listCrawlerReleases() });
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return NextResponse.json({ success: true, releases: [], migrationRequired: true });
    }
    console.error("[ops/crawler-releases:get]", error);
    return NextResponse.json({ success: false, error: error.message || "查询失败" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(req);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const release = await setActiveCrawlerRelease({
      platform: String(body.platform || "").trim().toLowerCase(),
      sha: body.sha,
      note: body.note,
      releasedBy: auth.realUser.advertiserUserId,
    });
    return NextResponse.json({ success: true, release }, { status: 201 });
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return NextResponse.json(
        { success: false, error: "Crawler 注册表尚未迁移", code: "MIGRATION_REQUIRED" },
        { status: 412 }
      );
    }
    const status = ["INVALID_PLATFORM", "INVALID_RELEASE_SHA", "RELEASE_COMMIT_MISSING"].includes(error.code)
      ? 400
      : error.code === "RELEASE_UPDATE_BUSY"
        ? 409
        : 500;
    console.error("[ops/crawler-releases:post]", error);
    return NextResponse.json(
      { success: false, error: error.message || "设置生产版本失败", code: error.code || null },
      { status }
    );
  }
}
