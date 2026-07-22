import { NextResponse } from "next/server";
import { requireCrawlerOpsSuperAdmin } from "../../../../../../../lib/auth/require-crawler-ops-super-admin.js";
import { executeCrawlerAction } from "../../../../../../../lib/ops/crawler-action-service.js";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const result = await executeCrawlerAction({
      machineId: Number(params.machineId),
      action: params.action,
      platform: body.platform || null,
      reason: body.reason,
      requestedByUserId: auth.realUser.advertiserUserId,
    });
    return NextResponse.json({ success: true, action: result });
  } catch (error) {
    const badRequest = ["INVALID_ACTION", "REASON_REQUIRED"].includes(error.code);
    const conflict = ["ACTION_COOLDOWN", "MIXED_RELEASE_CONFLICT"].includes(error.code);
    const notFound = error.code === "MACHINE_NOT_FOUND";
    const precondition = error.code === "ACTIVE_RELEASE_MISSING";
    const status = badRequest ? 400 : notFound ? 404 : conflict ? 409 : precondition ? 412 : 500;
    console.error("[ops/crawler-action]", error);
    return NextResponse.json(
      { success: false, error: error.message || "操作失败", code: error.code || null },
      { status }
    );
  }
}
