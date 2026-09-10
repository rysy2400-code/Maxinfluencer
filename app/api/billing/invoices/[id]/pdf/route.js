import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../../../lib/auth/require-billing-access.js";
import { getInvoiceById } from "../../../../../../lib/billing/invoice-dao.js";
import { loadInvoicePdf } from "../../../../../../lib/billing/invoice-pdf-store.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const invoiceId = Number(params.id);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      return NextResponse.json({ success: false, error: "无效的发票 ID" }, { status: 400 });
    }

    const row = await getInvoiceById(invoiceId, gate.auth.effectiveUser.advertiserId);
    if (!row) {
      return NextResponse.json({ success: false, error: "发票不存在" }, { status: 404 });
    }

    let pdf;
    try {
      pdf = await loadInvoicePdf(row);
    } catch (error) {
      console.error("[billing/invoices/pdf] 生成失败", row.id, error);
      return NextResponse.json({ success: false, error: "PDF 文件不存在" }, { status: 404 });
    }

    return new NextResponse(pdf.bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${row.invoice_no}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[billing/invoices/pdf]", error);
    return NextResponse.json(
      { success: false, error: error.message || "下载失败" },
      { status: 500 }
    );
  }
}
