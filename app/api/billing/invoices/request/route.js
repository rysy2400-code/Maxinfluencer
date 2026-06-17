import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../../lib/auth/require-billing-access.js";
import { requestInvoice } from "../../../../../lib/billing/request-invoice.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({}));
    const type = String(body.type || "").trim();
    const result = await requestInvoice({
      advertiserId: gate.auth.effectiveUser.advertiserId,
      userId: gate.auth.realUser.advertiserUserId,
      type,
      ledgerId: body.ledgerId != null ? Number(body.ledgerId) : undefined,
      periodYyyymm: body.periodYyyymm != null ? String(body.periodYyyymm) : undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      invoice: result.invoice,
      message: result.invoice.emailSent
        ? "发票已生成并已发送至通知邮箱"
        : `发票已生成，但邮件发送失败：${result.invoice.emailError || "未知错误"}`,
    });
  } catch (error) {
    console.error("[billing/invoices/request]", error);
    return NextResponse.json(
      { success: false, error: error.message || "申请失败" },
      { status: 500 }
    );
  }
}
