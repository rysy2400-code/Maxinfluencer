import fs from "fs";
import path from "path";
import { getBillingProfile } from "./billing-profile-dao.js";
import {
  buildInvoicePdfStorageKey,
  formatInvoiceDateHkt,
  getInvoiceStorageDir,
  normalizeInvoicePdfStorageKey,
  resolveInvoicePdfPathCandidates,
  updateInvoicePdfStorageKey,
} from "./invoice-dao.js";
import { renderInvoicePdf } from "./invoice-pdf.js";

/** @param {unknown} raw */
function parseLineItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 用数据库里的发票记录重建 PDF（历史文件丢失或路径失效时的兜底）。
 *
 * @param {object} row
 * @returns {Promise<Buffer>}
 */
async function regenerateInvoicePdf(row) {
  const profile = await getBillingProfile(row.advertiser_id);
  const issuedAt = row.issued_at ? new Date(row.issued_at) : new Date();

  return renderInvoicePdf({
    invoiceNo: row.invoice_no,
    invoiceDate: formatInvoiceDateHkt(issuedAt),
    billTo: {
      companyLegalName: profile?.company_legal_name || "—",
      companyAddress: profile?.company_address || "",
      contactName: profile?.contact_name || "",
      contactEmail: profile?.contact_email || "",
      taxId: profile?.tax_id || "",
    },
    lineItems: parseLineItems(row.line_items_json),
    grandTotal: Number(row.amount_usd) || 0,
  });
}

/**
 * 读取发票 PDF 字节流。
 *
 * 依次尝试：库里的 pdf_storage_key → 规范目录 storage/invoices/<advertiserId>/<invoiceNo>.pdf
 * → 用 line_items_json 现场重新生成并回写磁盘/数据库。
 *
 * @param {object} row tiktok_advertiser_invoice 行
 * @returns {Promise<{ bytes: Buffer, absPath: string | null, regenerated: boolean }>}
 */
export async function loadInvoicePdf(row) {
  for (const absPath of resolveInvoicePdfPathCandidates(row)) {
    if (fs.existsSync(absPath)) {
      return { bytes: fs.readFileSync(absPath), absPath, regenerated: false };
    }
  }

  const bytes = await regenerateInvoicePdf(row);
  const storageKey = buildInvoicePdfStorageKey(row.advertiser_id, row.invoice_no);
  const canonicalPath = path.join(getInvoiceStorageDir(row.advertiser_id), `${row.invoice_no}.pdf`);

  let absPath = null;
  try {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, bytes);
    absPath = canonicalPath;
    if (normalizeInvoicePdfStorageKey(row.pdf_storage_key) !== storageKey) {
      await updateInvoicePdfStorageKey(row.id, storageKey);
    }
  } catch (error) {
    // 磁盘不可写时仍然把内存中的 PDF 返回给用户，下载不受影响
    console.warn("[billing/invoice-pdf] 重建后写盘失败:", error.message);
  }

  return { bytes, absPath, regenerated: true };
}
