import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { BILLING_ISSUER } from "./issuer-config.js";
import {
  INVOICE_PDF_LAYOUT,
  META_LABELS,
  drawInTableCell,
  valueXAfterLabel,
  wrapTextLines,
} from "./invoice-pdf-layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "templates", "invoice-base.pdf");

const TEXT_COLOR = rgb(
  INVOICE_PDF_LAYOUT.color.text.r,
  INVOICE_PDF_LAYOUT.color.text.g,
  INVOICE_PDF_LAYOUT.color.text.b
);

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return x.toFixed(2);
}

function dashOrMoney(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
  return money(n);
}

/**
 * @param {import('pdf-lib').PDFPage} page
 * @param {import('pdf-lib').PDFFont} font
 * @param {string} label
 * @param {string} value
 * @param {{ text: string, x: number, y: number }} meta
 */
function drawLabelValue(page, font, label, value, meta) {
  const size = INVOICE_PDF_LAYOUT.sizes.body;
  const vx = valueXAfterLabel(font, label, meta.x, META_LABELS.valueGap);
  page.drawText(value, { x: vx, y: meta.y, size, font, color: TEXT_COLOR });
}

/**
 * @param {{
 *   invoiceNo: string,
 *   invoiceDate: string,
 *   billTo: { companyLegalName: string, companyAddress: string, contactName: string, contactEmail: string, taxId?: string },
 *   lineItems: Array<{ campaignName: string, influencerName: string, influencerFee: number | null, platformFee: number | null, total: number }>,
 *   grandTotal: number,
 * }} payload
 */
export async function renderInvoicePdf(payload) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      "缺少发票 PDF 底稿 lib/billing/templates/invoice-base.pdf。请运行 node scripts/generate-invoice-base.mjs"
    );
  }

  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const layout = INVOICE_PDF_LAYOUT.fields;
  const size = INVOICE_PDF_LAYOUT.sizes.body;

  drawLabelValue(page, font, META_LABELS.invoiceNo.text, payload.invoiceNo, META_LABELS.invoiceNo);
  drawLabelValue(page, font, META_LABELS.invoiceDate.text, payload.invoiceDate, META_LABELS.invoiceDate);
  drawLabelValue(
    page,
    font,
    META_LABELS.details.text,
    `<${payload.billTo.companyLegalName}>`,
    META_LABELS.details
  );

  const toParts = [
    payload.billTo.companyLegalName,
    ...String(payload.billTo.companyAddress || "")
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    payload.billTo.contactName
      ? `Contact: ${payload.billTo.contactName} <${payload.billTo.contactEmail}>`
      : "",
    payload.billTo.taxId ? `Tax ID / VAT: ${payload.billTo.taxId}` : "",
  ].filter(Boolean);

  let toY = layout.toBlock.y;
  for (const part of toParts) {
    for (const line of wrapTextLines(part, layout.toBlock.maxWidth, font, layout.toBlock.size)) {
      page.drawText(line, {
        x: layout.toBlock.x,
        y: toY,
        size: layout.toBlock.size,
        font,
        color: TEXT_COLOR,
      });
      toY -= layout.toBlock.lineHeight;
    }
  }

  let rowY = layout.table.startY;
  const tableSize = INVOICE_PDF_LAYOUT.sizes.table;
  for (const item of payload.lineItems.slice(0, layout.table.maxRows)) {
    const row = {
      campaign: item.campaignName || "—",
      influencer: item.influencerName || "—",
      influencerFee: dashOrMoney(item.influencerFee),
      platformFee: dashOrMoney(item.platformFee),
      total: money(item.total),
    };
    for (const col of layout.table.columns) {
      drawInTableCell(
        page,
        font,
        row[col.key] ?? "—",
        {
          cellX: col.cellX,
          cellWidth: col.cellWidth,
          y: rowY,
          size: tableSize,
          align: col.align,
        },
        TEXT_COLOR
      );
    }
    rowY -= layout.table.rowHeight;
  }

  const totalCol = layout.table.columns[layout.grandTotal.valueColumnIndex];
  drawInTableCell(page, font, money(payload.grandTotal), {
    cellX: totalCol.cellX,
    cellWidth: totalCol.cellWidth,
    y: layout.grandTotal.y,
    size,
    align: "right",
  }, TEXT_COLOR);

  return pdfDoc.save();
}

export function getInvoiceTemplatePath() {
  return TEMPLATE_PATH;
}

export { BILLING_ISSUER };
