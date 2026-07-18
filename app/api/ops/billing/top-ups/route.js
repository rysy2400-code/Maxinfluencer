import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { listAdminTopUps } from "../../../../../lib/admin/account-admin-service.js";
import { normalizeIsoDate } from "../../../../../lib/admin/account-admin-validation.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth?.realUser?.isAdmin) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }
    const { searchParams } = new URL(req.url);
    const advertiserIdText = searchParams.get("advertiserId") || "";
    const advertiserId = advertiserIdText ? Number(advertiserIdText) : null;
    const fromText = searchParams.get("from") || "";
    const toText = searchParams.get("to") || "";
    if (advertiserIdText && (!Number.isSafeInteger(advertiserId) || advertiserId <= 0)) {
      return NextResponse.json({ success: false, error: "公司参数无效" }, { status: 400 });
    }
    const from = fromText ? normalizeIsoDate(fromText) : null;
    const to = toText ? normalizeIsoDate(toText) : null;
    if ((fromText && !from) || (toText && !to) || (from && to && from > to)) {
      return NextResponse.json({ success: false, error: "日期范围无效" }, { status: 400 });
    }
    const result = await listAdminTopUps({
      advertiserId,
      from,
      to,
      reference: (searchParams.get("reference") || "").trim().slice(0, 255),
      page: searchParams.get("page") || 1,
      pageSize: searchParams.get("pageSize") || 20,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("[ops/billing/top-ups]", error);
    return NextResponse.json({ success: false, error: error.message || "查询失败" }, { status: 500 });
  }
}
