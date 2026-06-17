import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../../lib/auth/require-billing-access.js";
import { listBillingLedgerForExport } from "../../../../../lib/billing/ledger-dao.js";
import { ledgerTypeLabel } from "../../../../../lib/billing/ledger-types.js";

export const dynamic = "force-dynamic";

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatUsd(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(req.url);
    const items = await listBillingLedgerForExport({
      advertiserId: gate.auth.effectiveUser.advertiserId,
      from: searchParams.get("from"),
      to: searchParams.get("to"),
      type: searchParams.get("type"),
    });

    const header = [
      "时间",
      "类型",
      "Campaign",
      "红人",
      "红人合作费(USD)",
      "平台服务费5%(USD)",
      "合计(USD)",
      "余额(USD)",
      "备注",
    ];
    const lines = [header.join(",")];
    for (const row of items) {
      const total =
        row.type === "quote_approve"
          ? Math.abs(row.influencerAmount) + Math.abs(row.platformFeeAmount)
          : Math.abs(row.amount);
      lines.push(
        [
          row.createdAt ? new Date(row.createdAt).toISOString() : "",
          ledgerTypeLabel(row.type),
          row.campaignName || "",
          row.influencerDisplayName || "",
          row.type === "quote_approve" ? formatUsd(Math.abs(row.influencerAmount)) : "",
          row.type === "quote_approve" ? formatUsd(Math.abs(row.platformFeeAmount)) : "",
          formatUsd(row.type === "top_up" ? row.amount : -total),
          formatUsd(row.balanceAfter),
          row.note || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }

    const csv = "\uFEFF" + lines.join("\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="billing-ledger.csv"',
      },
    });
  } catch (error) {
    console.error("[billing/ledger/export]", error);
    return NextResponse.json(
      { success: false, error: error.message || "导出失败" },
      { status: 500 }
    );
  }
}
