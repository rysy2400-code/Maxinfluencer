import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { createAdvertiserAccount, listAdminCompanies } from "../../../../lib/admin/account-admin-service.js";
import {
  normalizeAccountRole,
  normalizeRequiredText,
  validateSixDigitPassword,
} from "../../../../lib/admin/account-admin-validation.js";

export const dynamic = "force-dynamic";

async function requirePlatformAdmin(req) {
  const auth = await getAuthenticatedAdvertiserUser(req);
  return auth?.realUser?.isAdmin ? auth : null;
}

export async function GET(req) {
  try {
    const auth = await requirePlatformAdmin(req);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    const { searchParams } = new URL(req.url);
    const companies = await listAdminCompanies({
      q: searchParams.get("q") || "",
      limit: searchParams.get("limit") || 50,
    });
    return NextResponse.json({ success: true, companies });
  } catch (error) {
    console.error("[ops/accounts GET]", error);
    return NextResponse.json({ success: false, error: error.message || "查询失败" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const auth = await requirePlatformAdmin(req);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const companyName = normalizeRequiredText(body.companyName, 255);
    const username = normalizeRequiredText(body.username, 64);
    const role = normalizeAccountRole(body.role);
    if (!companyName) return NextResponse.json({ success: false, error: "请输入不超过 255 字的公司名" }, { status: 400 });
    if (!username) return NextResponse.json({ success: false, error: "请输入不超过 64 字的用户名" }, { status: 400 });
    if (!validateSixDigitPassword(body.password)) {
      return NextResponse.json({ success: false, error: "密码须为 6 位数字" }, { status: 400 });
    }
    if (!role) return NextResponse.json({ success: false, error: "账户类型无效" }, { status: 400 });
    const account = await createAdvertiserAccount({
      companyName,
      username,
      password: body.password,
      role,
      createdByUserId: auth.realUser.advertiserUserId,
    });
    return NextResponse.json({ success: true, account }, { status: 201 });
  } catch (error) {
    console.error("[ops/accounts POST]", error);
    const status = error.code === "ACCOUNT_EXISTS" ? 409 : 500;
    return NextResponse.json({ success: false, error: error.message || "创建失败" }, { status });
  }
}
