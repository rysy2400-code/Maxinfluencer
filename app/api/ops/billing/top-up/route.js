import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { recordTopUp } from "../../../../../lib/admin/account-admin-service.js";
import {
  normalizeIsoDate,
  normalizeRequiredText,
  normalizeUsdAmount,
} from "../../../../../lib/admin/account-admin-validation.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth?.realUser?.isAdmin) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const advertiserId = Number(body.advertiserId);
    const amountUsd = normalizeUsdAmount(body.amountUsd);
    const receivedAt = normalizeIsoDate(body.receivedAt);
    const noBankReference = body.noBankReference === true;
    const bankReference = noBankReference ? null : normalizeRequiredText(body.bankReference, 255);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
    if (!Number.isSafeInteger(advertiserId) || advertiserId <= 0) {
      return NextResponse.json({ success: false, error: "请选择公司" }, { status: 400 });
    }
    if (!amountUsd) return NextResponse.json({ success: false, error: "请输入有效的 USD 金额，最多两位小数" }, { status: 400 });
    if (!receivedAt) return NextResponse.json({ success: false, error: "到账日期无效" }, { status: 400 });
    if (!noBankReference && !bankReference) {
      return NextResponse.json({ success: false, error: "请输入银行流水号，或勾选无银行流水号" }, { status: 400 });
    }
    const topUp = await recordTopUp({
      advertiserId,
      amountUsd,
      receivedAt,
      bankReference,
      noBankReference,
      note,
      createdByUserId: auth.realUser.advertiserUserId,
    });
    return NextResponse.json({ success: true, topUp }, { status: 201 });
  } catch (error) {
    console.error("[ops/billing/top-up]", error);
    const status = error.code === "TOPUP_EXISTS" ? 409 : error.code === "COMPANY_NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ success: false, error: error.message || "充值入账失败" }, { status });
  }
}
