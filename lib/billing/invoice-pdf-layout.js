/**
 * Shared invoice PDF layout (A4). Keep generate script and overlay in sync.
 */
export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginLeft: 50,
  marginRight: 545,
};

const TABLE_LEFT = 48;
const TABLE_RIGHT = 547;
const TABLE_WIDTH = TABLE_RIGHT - TABLE_LEFT;
const COL_COUNT = 5;
const COL_WIDTH = TABLE_WIDTH / COL_COUNT;
const CELL_PAD = 6;

/**
 * @returns {Array<{ key: string, header: string, cellX: number, x: number, width: number, cellWidth: number, align: string, headerAlign: string, headerLines?: string[] }>}
 */
export function buildInvoiceTableColumns() {
  const defs = [
    { key: "campaign", header: "Campaign", align: "left", headerAlign: "left" },
    { key: "influencer", header: "Influencer", align: "left", headerAlign: "left" },
    {
      key: "influencerFee",
      header: "Influencer Fee (USD)",
      headerLines: ["Influencer Fee", "(USD)"],
      align: "right",
      headerAlign: "right",
    },
    {
      key: "platformFee",
      header: "Platform Fee (USD)",
      headerLines: ["Platform Fee", "(USD)"],
      align: "right",
      headerAlign: "right",
    },
    { key: "total", header: "Total (USD)", headerLines: ["Total", "(USD)"], align: "right", headerAlign: "right" },
  ];

  return defs.map((d, i) => {
    const cellX = TABLE_LEFT + i * COL_WIDTH;
    return {
      ...d,
      cellX,
      cellWidth: COL_WIDTH,
      x: cellX + CELL_PAD,
      width: COL_WIDTH - CELL_PAD * 2,
    };
  });
}

export const INVOICE_TABLE_COLUMNS = buildInvoiceTableColumns();

export const META_LABELS = {
  invoiceNo: { text: "Invoice Number :", x: 352, y: 755 },
  invoiceDate: { text: "Invoice Date   :", x: 352, y: 738 },
  details: { text: "Details  :", x: PAGE.marginLeft, y: 645 },
  valueGap: 5,
};

export const INVOICE_PDF_LAYOUT = {
  page: PAGE,
  font: "WenQuanYi Micro Hei",
  sizes: { body: 10, table: 8, header: 7 },
  color: { text: { r: 0.12, g: 0.14, b: 0.18 } },
  meta: META_LABELS,
  fields: {
    toBlock: {
      x: 300,
      y: 695,
      size: 10,
      lineHeight: 12,
      maxWidth: PAGE.marginRight - 300 - 8,
    },
    table: {
      left: TABLE_LEFT,
      right: TABLE_RIGHT,
      headerY: 592,
      headerH: 22,
      startY: 566,
      rowHeight: 14,
      maxRows: 20,
      columns: INVOICE_TABLE_COLUMNS,
    },
    grandTotal: {
      label: "Grand Total (USD)",
      labelX: TABLE_LEFT + COL_WIDTH * 3 + CELL_PAD,
      y: 248,
      valueColumnIndex: 4,
    },
    bank: { x: PAGE.marginLeft, startY: 188, lineHeight: 13 },
    signature: { x: PAGE.marginLeft, y: 72, w: 118, h: 36 },
    signatoryLabelY: 58,
    footer: { x: PAGE.marginLeft, line1Y: 48, line2Y: 36, line1: "Grace Capital", line2: "Maxin AI" },
  },
};

/**
 * @param {import('pdf-lib').PDFFont} font
 * @param {string} label
 * @param {number} size
 */
export function valueXAfterLabel(font, label, labelX, gap = META_LABELS.valueGap, size = 10) {
  return labelX + font.widthOfTextAtSize(label, size) + gap;
}

/**
 * @param {string} text
 * @param {number} maxWidth
 * @param {import('pdf-lib').PDFFont} font
 * @param {number} size
 */
export function wrapTextLines(text, maxWidth, font, size) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const next = `${line} ${words[i]}`;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      lines.push(line);
      line = words[i];
    }
  }
  lines.push(line);

  // 单个“词”超出列宽时（例如无空格的中文长串），按字符拆行，避免中文内容溢出/漏字
  const out = [];
  for (const line of lines) {
    if (font.widthOfTextAtSize(line, size) <= maxWidth) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const ch of line) {
      if (current && font.widthOfTextAtSize(current + ch, size) > maxWidth) {
        out.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * @param {import('pdf-lib').PDFPage} page
 * @param {import('pdf-lib').PDFFont} font
 * @param {string} text
 * @param {{ cellX: number, cellWidth: number, y: number, size: number, align?: string }} box
 * @param {import('pdf-lib').RGB} color
 */
export function drawInTableCell(page, font, text, box, color) {
  const t = String(text ?? "");
  const tw = font.widthOfTextAtSize(t, box.size);
  let x = box.cellX + CELL_PAD;
  if (box.align === "right") {
    x = box.cellX + box.cellWidth - CELL_PAD - tw;
  } else if (box.align === "center") {
    x = box.cellX + (box.cellWidth - tw) / 2;
  }
  page.drawText(t, { x, y: box.y, size: box.size, font, color });
}
