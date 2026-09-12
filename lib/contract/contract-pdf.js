/**
 * Collaboration Agreement PDF 渲染（Binfluencer <-> Creator，纯英文，A4）。
 *
 * 设计约束（依据业务确认）：
 * 1) 只涉及两方：Binfluencer（Agency）与红人（Creator），不出现广告主主体；
 * 2) 不写权利归属（Rights & Usage）条款，遇到该类问题走特殊请求；
 * 3) 机构名 Binfluencer、官网 https://www.binfluencer.xyz，签字人 Bin（Founder），
 *    使用 public/billing/bin-duan-signature.png 签名图；
 * 4) 红人签字栏留空；邮件回复确认即可，不强制签字回传；
 * 5) 条款尽量简单，纯英文。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, rgb } from "pdf-lib";
import { embedInvoiceFont } from "../billing/invoice-font.js";
import { wrapTextLines } from "../billing/invoice-pdf-layout.js";
import { buildContractClauses } from "./contract-clauses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SIGNATURE_PNG = path.join(
  __dirname,
  "..",
  "..",
  "public",
  "billing",
  "bin-duan-signature.png"
);

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN_X = 56;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 50;
const CONTENT_WIDTH = PAGE.width - MARGIN_X * 2;
const COL_GAP = 26;
const COL_WIDTH = (CONTENT_WIDTH - COL_GAP) / 2;

const SIZES = { title: 17, subtitle: 10, heading: 11, body: 10, small: 8.5 };
const TEXT_COLOR = rgb(0.12, 0.14, 0.18);
const MUTED_COLOR = rgb(0.4, 0.43, 0.47);
const RULE_COLOR = rgb(0.76, 0.79, 0.83);

function asParagraphs(text) {
  if (Array.isArray(text)) {
    return text.map((t) => String(t ?? "").trim()).filter(Boolean);
  }
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((t) => t.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

/**
 * @param {{
 *   contractNo: string,
 *   contractDate: string,
 *   agency: { name: string, website?: string, signatory: string, title: string, signaturePngPath?: string },
 *   creator: { displayName?: string, handle: string, email?: string, profileUrl?: string },
 *   brandName?: string,
 *   productLink?: string,
 *   deliverablesText: string | string[],
 *   feeAmount: number,
 *   currency?: string,
 *   paymentMethods?: string[],
 * }} payload
 */
export async function renderCollaborationContractPdf(payload) {
  const pdfDoc = await PDFDocument.create();
  // 复用发票字体（含 CJK 字形，保证日文显示名等非 Latin-1 字符可编码）
  const font = await embedInvoiceFont(pdfDoc);

  let page = null;
  let cursor = 0;

  const addPage = () => {
    page = pdfDoc.addPage([PAGE.width, PAGE.height]);
    cursor = PAGE.height - MARGIN_TOP;
  };

  const ensureSpace = (needed) => {
    if (!page || cursor - needed < MARGIN_BOTTOM) addPage();
  };

  const drawWrapped = (
    text,
    {
      x = MARGIN_X,
      width = CONTENT_WIDTH,
      size = SIZES.body,
      color = TEXT_COLOR,
      lineHeight = size * 1.38,
      gapAfter = 0,
    } = {}
  ) => {
    const lines = wrapTextLines(text, width, font, size);
    for (const line of lines) {
      ensureSpace(lineHeight);
      page.drawText(line, { x, y: cursor - size, size, font, color });
      cursor -= lineHeight;
    }
    cursor -= gapAfter;
  };

  const drawHeading = (text) => {
    ensureSpace(SIZES.heading * 1.55 + 4);
    page.drawText(text, {
      x: MARGIN_X,
      y: cursor - SIZES.heading,
      size: SIZES.heading,
      font,
      color: TEXT_COLOR,
    });
    cursor -= SIZES.heading * 1.55;
  };

  const drawRule = ({ x = MARGIN_X, width = CONTENT_WIDTH, gapBefore = 4, gapAfter = 10 } = {}) => {
    ensureSpace(gapBefore + gapAfter + 1);
    cursor -= gapBefore;
    page.drawLine({
      start: { x, y: cursor },
      end: { x: x + width, y: cursor },
      thickness: 0.7,
      color: RULE_COLOR,
    });
    cursor -= gapAfter;
  };

  const gap = (n) => {
    cursor -= n;
  };

  addPage();

  // ---- 标题 ----
  const title = "COLLABORATION AGREEMENT";
  const titleWidth = font.widthOfTextAtSize(title, SIZES.title);
  ensureSpace(SIZES.title * 1.4);
  page.drawText(title, {
    x: (PAGE.width - titleWidth) / 2,
    y: cursor - SIZES.title,
    size: SIZES.title,
    font,
    color: TEXT_COLOR,
  });
  cursor -= SIZES.title * 1.4;

  const metaLine = `Agreement No.: ${payload.contractNo}        Date: ${payload.contractDate}`;
  const metaWidth = font.widthOfTextAtSize(metaLine, SIZES.subtitle);
  ensureSpace(SIZES.subtitle * 1.4);
  page.drawText(metaLine, {
    x: (PAGE.width - metaWidth) / 2,
    y: cursor - SIZES.subtitle,
    size: SIZES.subtitle,
    font,
    color: MUTED_COLOR,
  });
  cursor -= SIZES.subtitle * 1.45;

  drawRule({ gapBefore: 5, gapAfter: 12 });

  // ---- 缔约双方 ----
  drawWrapped(
    'This Collaboration Agreement (this "Agreement") is entered into as of the date above by and between:'
  );
  gap(5);

  drawWrapped(`${payload.agency.name} ("Agency"), website: ${payload.agency.website}`);
  gap(2);

  const creatorBits = [];
  if (payload.creator.displayName) creatorBits.push(payload.creator.displayName);
  if (payload.creator.handle) {
    creatorBits.push(`(@${String(payload.creator.handle).replace(/^@/, "")})`);
  }
  const creatorIdentity = creatorBits.join(" ");
  const creatorDetailBits = [];
  if (payload.creator.profileUrl) creatorDetailBits.push(payload.creator.profileUrl);
  if (payload.creator.email) creatorDetailBits.push(payload.creator.email);
  const creatorLine = creatorDetailBits.length
    ? `${creatorIdentity} ("Creator"), ${creatorDetailBits.join(", ")}`
    : `${creatorIdentity} ("Creator")`;
  drawWrapped(creatorLine);
  gap(8);

  if (payload.brandName || payload.productLink) {
    const scopeBits = [];
    if (payload.brandName) scopeBits.push(`the brand ${payload.brandName}`);
    if (payload.productLink) scopeBits.push(`product link: ${payload.productLink}`);
    drawWrapped(
      `This Agreement relates to the collaboration between the Parties in connection with ${scopeBits.join(
        "; "
      )} (the "Campaign").`
    );
    gap(8);
  }

  // 条款编号：出现 Additional Terms 时插在第 4 条，General 顺延为第 5 条
  const clauses = buildContractClauses({
    deliverablesText: payload.deliverablesText,
    feeAmount: payload.feeAmount,
    currency: payload.currency,
    paymentMethods: payload.paymentMethods,
    sectionOverrides: payload.sectionOverrides,
    additionalTerms: payload.additionalTerms,
  });
  const additionalTerms = clauses.additionalTerms;
  const hasAdditional = additionalTerms.length > 0;
  const numGeneral = hasAdditional ? 5 : 4;

  // ---- 1. Deliverables ----
  drawHeading("1. Deliverables");
  const deliverableParagraphs = asParagraphs(clauses.deliverables);
  if (!deliverableParagraphs.length) {
    drawWrapped("As agreed between the Parties in writing.");
  } else {
    deliverableParagraphs.forEach((p, idx) =>
      drawWrapped(p, { gapAfter: idx === deliverableParagraphs.length - 1 ? 0 : 6 })
    );
  }
  gap(10);

  // ---- 2. Fee ----
  drawHeading("2. Fee");
  drawWrapped(clauses.fee);
  gap(10);

  // ---- 3. Payment Terms ----
  drawHeading("3. Payment Terms");
  drawWrapped(clauses.paymentMethod);
  gap(4);
  drawWrapped(clauses.paymentTiming);
  gap(4);
  drawWrapped(clauses.acceptance);
  gap(10);

  // ---- 4. Additional Terms（仅当存在协商新增条款时出现） ----
  if (hasAdditional) {
    drawHeading("4. Additional Terms");
    additionalTerms.forEach((t, idx) =>
      drawWrapped(t, { gapAfter: idx === additionalTerms.length - 1 ? 0 : 6 })
    );
    gap(10);
  }

  // ---- General ----
  drawHeading(`${numGeneral}. General`);
  drawWrapped(clauses.general);
  gap(16);

  // ---- 签署区 ----
  ensureSpace(150);
  drawWrapped(
    "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the date first written above.",
    { gapAfter: 14 }
  );

  const signatureBlockTop = cursor;
  const leftX = MARGIN_X;
  const rightX = MARGIN_X + COL_WIDTH + COL_GAP;

  page.drawText(payload.agency.name.toUpperCase(), {
    x: leftX,
    y: signatureBlockTop - SIZES.small,
    size: SIZES.small,
    font,
    color: MUTED_COLOR,
  });
  page.drawText("CREATOR", {
    x: rightX,
    y: signatureBlockTop - SIZES.small,
    size: SIZES.small,
    font,
    color: MUTED_COLOR,
  });

  const sigLineY = signatureBlockTop - 62;

  let signatureImage = null;
  const signaturePath = payload.agency.signaturePngPath || DEFAULT_SIGNATURE_PNG;
  if (signaturePath && fs.existsSync(signaturePath)) {
    try {
      signatureImage = await pdfDoc.embedPng(fs.readFileSync(signaturePath));
    } catch {
      signatureImage = null;
    }
  }
  if (signatureImage) {
    const maxW = Math.min(150, COL_WIDTH - 8);
    const maxH = 34;
    const scale = Math.min(maxW / signatureImage.width, maxH / signatureImage.height);
    page.drawImage(signatureImage, {
      x: leftX,
      y: sigLineY + 8,
      width: signatureImage.width * scale,
      height: signatureImage.height * scale,
    });
  }

  for (const x of [leftX, rightX]) {
    page.drawLine({
      start: { x, y: sigLineY },
      end: { x: x + COL_WIDTH, y: sigLineY },
      thickness: 0.7,
      color: RULE_COLOR,
    });
  }

  let leftY = sigLineY - 15;
  page.drawText(payload.agency.signatory, { x: leftX, y: leftY, size: SIZES.body, font, color: TEXT_COLOR });
  leftY -= 13;
  page.drawText(`${payload.agency.title}, ${payload.agency.name}`, {
    x: leftX,
    y: leftY,
    size: SIZES.body,
    font,
    color: TEXT_COLOR,
  });
  leftY -= 13;
  page.drawText(`Date: ${payload.contractDate}`, { x: leftX, y: leftY, size: SIZES.body, font, color: TEXT_COLOR });

  let rightY = sigLineY - 15;
  page.drawText("Name: ______________________", { x: rightX, y: rightY, size: SIZES.body, font, color: TEXT_COLOR });
  rightY -= 13;
  page.drawText(`Handle: @${String(payload.creator.handle || "").replace(/^@/, "")}`, {
    x: rightX,
    y: rightY,
    size: SIZES.body,
    font,
    color: TEXT_COLOR,
  });
  rightY -= 13;
  page.drawText("Date: ______________________", { x: rightX, y: rightY, size: SIZES.body, font, color: TEXT_COLOR });

  return pdfDoc.save();
}
