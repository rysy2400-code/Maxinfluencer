/**
 * Generate invoice-base.pdf + optional preview sample.
 * Run: node scripts/generate-invoice-base.mjs --preview
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import {
  INVOICE_PDF_LAYOUT,
  INVOICE_TABLE_COLUMNS,
  META_LABELS,
  drawInTableCell,
  valueXAfterLabel,
  wrapTextLines,
} from "../lib/billing/invoice-pdf-layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const templatesDir = path.join(projectRoot, "lib/billing/templates");
const outBase = path.join(templatesDir, "invoice-base.pdf");
const outPreview = path.join(templatesDir, "invoice-base-preview.pdf");
const sigPath = path.join(projectRoot, "public/billing/bin-duan-signature.png");

const ISSUER = {
  companyName: "Grace Capital Group Limited",
  productName: "Maxin AI",
  bankName: "OCBC Bank Hong Kong",
  bankAddress: "161 Queen's Road, Central, Hong Kong",
  accountNo: "038524-831",
  accountHolder: "Grace Capital Group Limited",
  swiftCode: "OCBCHKHH",
  signatureName: "Bin Duan",
};

const black = rgb(0.12, 0.14, 0.18);
const gray = rgb(0.42, 0.45, 0.5);
const light = rgb(0.94, 0.95, 0.97);
const rule = rgb(0.82, 0.84, 0.88);

function drawMetaLabel(page, font, meta) {
  page.drawText(meta.text, {
    x: meta.x,
    y: meta.y,
    size: 10,
    font,
    color: gray,
  });
}

function drawTableHeader(page, bold, col, y) {
  const lines = col.headerLines || [col.header];
  let ly = y + (lines.length > 1 ? 4 : 0);
  for (const line of lines) {
    drawInTableCell(
      page,
      bold,
      line,
      {
        cellX: col.cellX,
        cellWidth: col.cellWidth,
        y: ly,
        size: 7,
        align: col.headerAlign,
      },
      black
    );
    ly -= 8;
  }
}

function drawWrappedBlock(page, font, lines, x, startY, maxWidth, size, lineHeight, color) {
  let y = startY;
  for (const part of lines) {
    for (const line of wrapTextLines(part, maxWidth, font, size)) {
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
    }
  }
  return y;
}

async function buildBasePage(pdf, { withPreviewSample = false } = {}) {
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const layout = INVOICE_PDF_LAYOUT.fields;
  const t = layout.table;

  page.drawLine({
    start: { x: INVOICE_PDF_LAYOUT.page.marginLeft, y: 770 },
    end: { x: INVOICE_PDF_LAYOUT.page.marginRight, y: 770 },
    thickness: 1,
    color: rule,
  });

  page.drawText("INVOICE", {
    x: INVOICE_PDF_LAYOUT.page.marginLeft,
    y: 790,
    size: 22,
    font: bold,
    color: black,
  });

  drawMetaLabel(page, regular, META_LABELS.invoiceNo);
  drawMetaLabel(page, regular, META_LABELS.invoiceDate);

  page.drawText("From", { x: 50, y: 715, size: 11, font: bold, color: black });
  page.drawText("To", { x: layout.toBlock.x, y: 715, size: 11, font: bold, color: black });
  page.drawText(ISSUER.companyName, { x: 50, y: 700, size: 10, font: regular, color: black });
  page.drawText(ISSUER.productName, { x: 50, y: 686, size: 10, font: regular, color: black });
  drawMetaLabel(page, regular, META_LABELS.details);

  page.drawRectangle({
    x: t.left,
    y: t.headerY - 6,
    width: t.right - t.left,
    height: t.headerH,
    color: light,
    borderColor: rule,
    borderWidth: 0.5,
  });

  for (const col of INVOICE_TABLE_COLUMNS) {
    drawTableHeader(page, bold, col, t.headerY);
  }

  for (let i = 1; i < INVOICE_TABLE_COLUMNS.length; i += 1) {
    const x = INVOICE_TABLE_COLUMNS[i].cellX;
    page.drawLine({
      start: { x, y: t.headerY - 6 },
      end: { x, y: t.headerY - 6 + t.headerH },
      thickness: 0.25,
      color: rule,
    });
  }

  page.drawLine({
    start: { x: t.left, y: t.headerY - 7 },
    end: { x: t.right, y: t.headerY - 7 },
    thickness: 0.5,
    color: rule,
  });
  page.drawLine({
    start: { x: t.left, y: 262 },
    end: { x: t.right, y: 262 },
    thickness: 0.5,
    color: rule,
  });

  page.drawText(layout.grandTotal.label, {
    x: layout.grandTotal.labelX,
    y: layout.grandTotal.y,
    size: 10,
    font: bold,
    color: black,
  });

  const bankLines = [
    ["Account Holder:", ISSUER.accountHolder],
    ["Account Number:", ISSUER.accountNo],
    ["SWIFT (BIC):", ISSUER.swiftCode],
    ["Bank Name:", ISSUER.bankName],
    ["Bank Address:", ISSUER.bankAddress],
  ];
  let by = layout.bank.startY;
  for (const [label, value] of bankLines) {
    page.drawText(label, { x: layout.bank.x, y: by, size: 9, font: bold, color: black });
    page.drawText(value, { x: 145, y: by, size: 9, font: regular, color: black });
    by -= layout.bank.lineHeight;
  }

  if (fs.existsSync(sigPath)) {
    const png = fs.readFileSync(sigPath);
    const img = await pdf.embedPng(png);
    page.drawImage(img, {
      x: layout.signature.x,
      y: layout.signature.y,
      width: layout.signature.w,
      height: layout.signature.h,
    });
  }

  page.drawText(`Authorized Signatory: ${ISSUER.signatureName}`, {
    x: 50,
    y: layout.signatoryLabelY,
    size: 9,
    font: regular,
    color: gray,
  });
  page.drawText(layout.footer.line1, {
    x: layout.footer.x,
    y: layout.footer.line1Y,
    size: 8,
    font: regular,
    color: gray,
  });
  page.drawText(layout.footer.line2, {
    x: layout.footer.x,
    y: layout.footer.line2Y,
    size: 8,
    font: regular,
    color: gray,
  });

  if (withPreviewSample) {
    const invNo = "GCG-M-202606-0001";
    const invDate = "2026-06-17";

    page.drawText(invNo, {
      x: valueXAfterLabel(regular, META_LABELS.invoiceNo.text, META_LABELS.invoiceNo.x),
      y: META_LABELS.invoiceNo.y,
      size: 10,
      font: regular,
      color: black,
    });
    page.drawText(invDate, {
      x: valueXAfterLabel(regular, META_LABELS.invoiceDate.text, META_LABELS.invoiceDate.x),
      y: META_LABELS.invoiceDate.y,
      size: 10,
      font: regular,
      color: black,
    });

    page.drawText("<TECDO HONG KONG LIMITED>", {
      x: valueXAfterLabel(regular, META_LABELS.details.text, META_LABELS.details.x),
      y: META_LABELS.details.y,
      size: 10,
      font: regular,
      color: black,
    });

    drawWrappedBlock(
      page,
      regular,
      [
        "TECDO HONG KONG LIMITED",
        "Room 505, 5th Floor, Beverley Commercial Centre, 87-105 Chatham Road South, Tsim Sha Tsui, Kowloon, HONG KONG",
      ],
      layout.toBlock.x,
      layout.toBlock.y,
      layout.toBlock.maxWidth,
      layout.toBlock.size,
      layout.toBlock.lineHeight,
      black
    );

    const rows = [
      { campaign: "—", influencer: "maddy.wads", inf: "456.00", pf: "22.80", tot: "478.80" },
      { campaign: "—", influencer: "about.kary", inf: "380.00", pf: "19.00", tot: "399.00" },
    ];
    let ry = t.startY;
    for (const row of rows) {
      const map = {
        campaign: row.campaign,
        influencer: row.influencer,
        influencerFee: row.inf,
        platformFee: row.pf,
        total: row.tot,
      };
      for (const col of INVOICE_TABLE_COLUMNS) {
        drawInTableCell(
          page,
          regular,
          map[col.key],
          {
            cellX: col.cellX,
            cellWidth: col.cellWidth,
            y: ry,
            size: 8,
            align: col.align,
          },
          black
        );
      }
      ry -= t.rowHeight;
    }

    const totalCol = INVOICE_TABLE_COLUMNS[layout.grandTotal.valueColumnIndex];
    drawInTableCell(page, bold, "877.80", {
      cellX: totalCol.cellX,
      cellWidth: totalCol.cellWidth,
      y: layout.grandTotal.y,
      size: 10,
      align: "right",
    }, black);
  }

  return page;
}

async function run() {
  const withPreview = process.argv.includes("--preview");
  fs.mkdirSync(templatesDir, { recursive: true });

  const basePdf = await PDFDocument.create();
  await buildBasePage(basePdf);
  fs.writeFileSync(outBase, await basePdf.save());
  console.log("✅ Wrote", outBase);

  if (withPreview) {
    const previewPdf = await PDFDocument.create();
    await buildBasePage(previewPdf, { withPreviewSample: true });
    fs.writeFileSync(outPreview, await previewPdf.save());
    console.log("✅ Wrote", outPreview);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
