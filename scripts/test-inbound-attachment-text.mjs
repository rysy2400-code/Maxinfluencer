// 回归测试：收件 PDF 的文字抽取。
//
// 背景：package.json 依赖 pdf-parse ^2.4.5，但代码曾按 v1 的 pdfParse(buffer) 调用，
// v2 没有默认导出、必须 new PDFParse({data}) + getText()，导致所有收件 PDF 都报
// "pdfParse is not a function"。本测试用 pdf-lib 现造一个含文字的 PDF 验证抽取。
//
// 运行：node scripts/test-inbound-attachment-text.mjs

import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  extractAttachmentText,
  extractPdfText,
} from "../lib/influencer/extract-attachment-text.js";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok ${name}`);
}

const MARKER = "MEDIA KIT SMOKE TEST 20260917";

async function buildSamplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 200]);
  page.drawText(MARKER, { x: 40, y: 120, size: 16, font });
  page.drawText("Flat fee USD 1500", { x: 40, y: 90, size: 12, font });
  return Buffer.from(await doc.save());
}

async function run() {
  const pdfBuffer = await buildSamplePdf();
  assert.ok(pdfBuffer.subarray(0, 5).toString("latin1") === "%PDF-", "样例 PDF 头不对");

  console.log("[1] extractPdfText：能抽出文字层");
  {
    const text = await extractPdfText(pdfBuffer);
    assert.ok(text.includes(MARKER), `未抽到标记文字，实际: ${JSON.stringify(text.slice(0, 200))}`);
    assert.ok(text.includes("Flat fee USD 1500"));
    ok("pdf-parse v2 API 调用正确");
  }

  console.log("[2] extractAttachmentText：按 contentType 判定 PDF");
  {
    const byType = await extractAttachmentText({
      content_type: "application/pdf",
      filename: "kit.pdf",
      content: pdfBuffer,
    });
    assert.equal(byType.kind, "pdf_text");
    assert.ok(byType.text.includes(MARKER));

    // contentType 缺失时按扩展名兜底
    const byName = await extractAttachmentText({
      content_type: "",
      filename: "PEDRO DARICO - MIDIA KIT.PDF",
      content: pdfBuffer,
    });
    assert.equal(byName.kind, "pdf_text");
    assert.ok(byName.text.includes(MARKER));
    ok("contentType / 扩展名两条判定都命中");
  }

  console.log("[3] 非 PDF/图片附件返回 null（不做无谓解析）");
  {
    const docx = await extractAttachmentText({
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "a.docx",
      content: Buffer.from("PK"),
    });
    assert.equal(docx, null);

    const noContent = await extractAttachmentText({
      content_type: "application/pdf",
      filename: "a.pdf",
      content: null,
    });
    assert.equal(noContent, null);
    ok("无关类型直接跳过");
  }

  console.log("[4] 损坏 PDF 不抛异常，返回 pdf_text_error");
  {
    const broken = await extractAttachmentText({
      content_type: "application/pdf",
      filename: "broken.pdf",
      content: Buffer.from("%PDF-1.7\ngarbage"),
    });
    assert.ok(
      broken === null || broken.kind === "pdf_text_error",
      `期望 null 或 pdf_text_error，实际 ${JSON.stringify(broken)}`
    );
    ok("坏文件降级不崩");
  }

  console.log(`\n全部通过：${passed} 项`);
}

run().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
