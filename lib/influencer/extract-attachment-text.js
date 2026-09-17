// 收件附件的文本抽取：PDF 取文字层，图片走 OCR。
//
// 注意 pdf-parse 的版本差异：
// - v1：默认导出可调用函数 `pdfParse(buffer)` -> { text }
// - v2：命名导出 PDFParse 类，必须 `new PDFParse({ data })` + `await getText()`
// 本项目依赖是 v2（package.json: ^2.4.5）。早期按 v1 调用会抛
// "pdfParse is not a function"，导致所有收件 PDF 都解析失败，这里两种都兼容。

/**
 * 抽取 PDF 文字层。
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string>} 纯文本（无文字层时为空串）
 */
export async function extractPdfText(buffer) {
  const mod = await import("pdf-parse");

  // v2+
  if (typeof mod?.PDFParse === "function") {
    const parser = new mod.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return String(result?.text || "").trim();
    } finally {
      try {
        await parser.destroy?.();
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  }

  // v1 兜底
  const legacy = mod?.default || mod;
  if (typeof legacy === "function") {
    const data = await legacy(buffer);
    return String(data?.text || "").trim();
  }

  throw new Error(
    "pdf-parse 接口不兼容：既没有 PDFParse 类，也没有可调用的默认导出"
  );
}

/**
 * 图片 OCR（tesseract.js v5+ 默认导出上挂 recognize）。
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [lang]
 */
export async function extractImageText(buffer, lang = "eng") {
  const mod = await import("tesseract.js");
  const Tesseract = mod?.default || mod;
  if (typeof Tesseract?.recognize !== "function") {
    throw new Error("tesseract.js 接口不兼容：缺少 recognize()");
  }
  const result = await Tesseract.recognize(buffer, lang);
  return String(result?.data?.text || "").trim();
}

/**
 * 按 contentType / 文件名判断抽取方式。
 * @param {{ content_type?: string|null, contentType?: string|null, filename?: string|null, content?: Buffer|Uint8Array }} att
 * @returns {Promise<{ kind: string, text: string } | null>}
 */
export async function extractAttachmentText(att) {
  const contentType = String(
    att?.content_type || att?.contentType || ""
  ).toLowerCase();
  const filename = String(att?.filename || "");
  const buf = att?.content;
  if (!buf || (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array))) {
    return null;
  }

  if (contentType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
    try {
      const text = await extractPdfText(buf);
      return text ? { kind: "pdf_text", text } : null;
    } catch (err) {
      return {
        kind: "pdf_text_error",
        text: `PDF 解析失败: ${err?.message || String(err)}`,
      };
    }
  }

  if (contentType.startsWith("image/")) {
    try {
      const text = await extractImageText(buf, "eng");
      return text ? { kind: "image_ocr_text", text } : null;
    } catch (err) {
      return {
        kind: "image_ocr_error",
        text: `图片 OCR 失败: ${err?.message || String(err)}`,
      };
    }
  }

  return null;
}
