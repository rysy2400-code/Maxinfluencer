import fs from "fs";
import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../../../lib/auth/require-billing-access.js";
import {
  getInvoiceById,
  resolveInvoicePdfPath,
} from "../../../../../../lib/billing/invoice-dao.js";

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

    const absPath = resolveInvoicePdfPath(row.pdf_storage_key);
    if (!absPath || !fs.existsSync(absPath)) {
      return NextResponse.json({ success: false, error: "PDF 文件不存在" }, { status: 404 });
    }

    const bytes = fs.readFileSync(absPath);
    return new NextResponse(bytes, {
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
