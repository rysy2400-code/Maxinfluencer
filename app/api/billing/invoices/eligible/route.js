import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../../lib/auth/require-billing-access.js";
import { getEligibleInvoiceOptions } from "../../../../../lib/billing/invoice-eligible.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const options = await getEligibleInvoiceOptions(gate.auth.effectiveUser.advertiserId);
    return NextResponse.json({ success: true, ...options });
  } catch (error) {
    console.error("[billing/invoices/eligible]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}
