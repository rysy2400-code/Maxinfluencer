import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../lib/auth/require-billing-access.js";
import { queryTikTok } from "../../../../lib/db/mysql-tiktok.js";

export const dynamic = "force-dynamic";

/** @param {object} row */
function mapInvoice(row) {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    invoiceType: row.invoice_type,
    documentTitle: row.document_title,
    periodYyyymm: row.period_yyyymm,
    amountUsd: Number(row.amount_usd) || 0,
    status: row.status,
    issuedAt: row.issued_at,
    createdAt: row.created_at,
  };
}

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const rows = await queryTikTok(
      `
      SELECT id, invoice_no, invoice_type, document_title, period_yyyymm,
             amount_usd, status, issued_at, created_at
      FROM tiktok_advertiser_invoice
      WHERE advertiser_id = ?
      ORDER BY COALESCE(issued_at, created_at) DESC, id DESC
      LIMIT 200
    `,
      [gate.auth.effectiveUser.advertiserId]
    );

    return NextResponse.json({
      success: true,
      invoices: (rows || []).map(mapInvoice),
    });
  } catch (error) {
    console.error("[billing/invoices]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}
