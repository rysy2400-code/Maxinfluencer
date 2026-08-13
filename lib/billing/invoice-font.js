import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fontkit from "@pdf-lib/fontkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * WenQuanYi Micro Hei（Apache 2.0 / GPLv3 双许可）TTF。
 * pdf-lib 标准字体只支持 WinAnsi（Latin-1），无法编码中文；
 * 这里用 TrueType 字体 + fontkit 子集化嵌入，发票中遇到中文（活动名/红人名/抬头等）
 * 不会报 “WinAnsi cannot encode”，且每个 PDF 只嵌入用到的字形，体积很小。
 * 注意：不能换成 Noto Sans SC 的可变/静态 TTF——fontkit 对该字体做子集化会生成损坏的
 * glyf/loca 表，导致 PDF 渲染乱码（已验证）。
 */
export const INVOICE_FONT_PATH = path.join(__dirname, "fonts", "WenQuanYiMicroHei.ttf");

let cachedFontBytes = null;

function getFontBytes() {
  if (!cachedFontBytes) {
    cachedFontBytes = fs.readFileSync(INVOICE_FONT_PATH);
  }
  return cachedFontBytes;
}

/**
 * 将发票字体嵌入 PDF 文档（注册 fontkit + 子集化嵌入）。
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {{ subset?: boolean }} [options]
 */
export async function embedInvoiceFont(pdfDoc, options = {}) {
  const { subset = true } = options;
  pdfDoc.registerFontkit(fontkit);
  return pdfDoc.embedFont(getFontBytes(), { subset });
}
