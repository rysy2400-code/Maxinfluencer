import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../lib/auth/require-billing-access.js";
import { listBillingLedger } from "../../../../lib/billing/ledger-dao.js";
import { ledgerTypeLabel } from "../../../../lib/billing/ledger-types.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(req.url);
    const result = await listBillingLedger({
      advertiserId: gate.auth.effectiveUser.advertiserId,
      page: Number(searchParams.get("page")) || 1,
      pageSize: Number(searchParams.get("pageSize")) || 20,
      from: searchParams.get("from"),
      to: searchParams.get("to"),
      type: searchParams.get("type"),
    });

    return NextResponse.json({
      success: true,
      ...result,
      items: result.items.map((item) => ({
        ...item,
        typeLabel: ledgerTypeLabel(item.type),
      })),
    });
  } catch (error) {
    console.error("[billing/ledger]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}
