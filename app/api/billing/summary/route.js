import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../lib/auth/require-billing-access.js";
import { getBillingSummary } from "../../../../lib/billing/ledger-dao.js";
import { BILLING_ISSUER } from "../../../../lib/billing/issuer-config.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const summary = await getBillingSummary(gate.auth.effectiveUser.advertiserId);

    return NextResponse.json({
      success: true,
      summary,
      issuer: BILLING_ISSUER,
    });
  } catch (error) {
    console.error("[billing/summary]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}
