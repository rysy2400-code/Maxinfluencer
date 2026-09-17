// 回归测试：红人邮件附件的展示过滤与聊天标记生成。
//
// 覆盖：
// 1. 4 类系统附件（转发邮件本体 / 退信 / S-MIME 签名 / winmail.dat）必须被过滤
// 2. 图片 -> [IMAGE:url]；视频 -> [VIDEO:url|name]；其它 -> [FILE:url|name]
// 3. 单条消息最多 10 个附件
// 4. 标记里的文件名要清洗（换行 / 竖线 / 方括号）
// 5. 补写幂等：已含该附件链接的正文不再追加
//
// 运行：node scripts/test-inbound-attachment-markers.mjs

import assert from "node:assert/strict";
import {
  appendMissingInboundAttachmentMarkers,
  buildInboundAttachmentMarkers,
  inboundAttachmentDownloadUrl,
  inboundAttachmentKind,
  inboundAttachmentPreviewUrl,
  isHiddenInboundAttachment,
  selectDisplayableInboundAttachments,
} from "../lib/influencer/inbound-attachment-urls.js";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok ${name}`);
}

function att(id, contentType, filename) {
  return { inboundAttachmentId: id, contentType, filename };
}

async function run() {
  console.log("[1] 黑名单：系统附件不展示");
  {
    const hidden = att(1, "message/rfc822", "FW original.eml");
    const dsn = att(2, "message/delivery-status", null);
    const sig = att(3, "application/pkcs7-signature", "smime.p7s");
    const sigX = att(4, "application/x-pkcs7-signature", "smime.p7s");
    const tnef = att(5, "application/ms-tnef", "winmail.dat");
    const pdf = att(6, "application/pdf", "brief.pdf");

    for (const a of [hidden, dsn, sig, sigX, tnef]) {
      assert.equal(isHiddenInboundAttachment(a.contentType), true, a.contentType);
    }
    assert.equal(isHiddenInboundAttachment("application/pdf"), false);
    assert.equal(isHiddenInboundAttachment("IMAGE/PNG; name=x"), false);

    const selected = selectDisplayableInboundAttachments([
      hidden,
      dsn,
      sig,
      sigX,
      tnef,
      pdf,
    ]);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].inboundAttachmentId, 6);
    ok("4 类系统附件被过滤，业务附件保留");
  }

  console.log("[2] 标记格式：图片 / 视频 / 文件");
  {
    const items = [
      att(11, "image/png", "shot.png"),
      att(12, "video/mp4", "clip.mp4"),
      att(13, "application/pdf", "Media Kit.pdf"),
      att(
        14,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "notes.docx"
      ),
      att(15, "application/octet-stream", null),
    ];
    const markers = buildInboundAttachmentMarkers(items);
    assert.ok(markers.includes("[IMAGE:/api/influencers/inbound-attachments/11]"));
    assert.ok(
      markers.includes("[VIDEO:/api/influencers/inbound-attachments/12|clip.mp4]")
    );
    assert.ok(
      markers.includes("[FILE:/api/influencers/inbound-attachments/13|Media Kit.pdf]")
    );
    assert.ok(
      markers.includes("[FILE:/api/influencers/inbound-attachments/14|notes.docx]")
    );
    assert.ok(markers.includes("[FILE:/api/influencers/inbound-attachments/15]"));
    assert.equal(inboundAttachmentKind("VIDEO/MP4"), "video");
    assert.equal(inboundAttachmentKind("image/jpeg"), "image");
    assert.equal(inboundAttachmentKind("application/pdf"), "file");
    assert.equal(
      inboundAttachmentDownloadUrl(11),
      "/api/influencers/inbound-attachments/11?download=1"
    );
    assert.equal(inboundAttachmentPreviewUrl("x"), null);
    ok("三类标记格式正确");
  }

  console.log("[3] 单条消息最多 10 个附件");
  {
    const many = Array.from({ length: 25 }, (_, i) =>
      att(100 + i, "application/pdf", `f${i}.pdf`)
    );
    const markers = buildInboundAttachmentMarkers(many);
    assert.equal(markers.split("[FILE:").length - 1, 10);
    assert.equal(selectDisplayableInboundAttachments(many).length, 10);
    ok("附件数量上限 10");
  }

  console.log("[4] 标记文件名清洗");
  {
    const markers = buildInboundAttachmentMarkers([
      att(201, "application/pdf", "a]b|c\nd.pdf"),
    ]);
    const line = markers.trim();
    assert.ok(line.startsWith("[FILE:/api/influencers/inbound-attachments/201|"));
    assert.ok(line.endsWith("]"));
    const name = line.slice(line.indexOf("|") + 1, -1);
    assert.equal(/[\r\n|[\]]/.test(name), false, `文件名仍含非法字符: ${name}`);
    assert.equal(name, "a b c d.pdf");
    ok("文件名清洗（去掉换行/竖线/方括号）");
  }

  console.log("[5] 补写幂等");
  {
    const items = [
      att(301, "image/png", "a.png"),
      att(302, "application/pdf", "b.pdf"),
    ];
    const base = "特殊请求 待您决策\n\n红人回复：see attached";
    const once = appendMissingInboundAttachmentMarkers(base, items);
    assert.ok(once.includes("/inbound-attachments/301"));
    assert.ok(once.includes("/inbound-attachments/302"));
    const twice = appendMissingInboundAttachmentMarkers(once, items);
    assert.equal(twice, once);

    const partial = appendMissingInboundAttachmentMarkers(once, [
      att(301, "image/png", "a.png"),
      att(303, "video/mp4", "c.mp4"),
    ]);
    assert.equal(partial.split("/inbound-attachments/301").length - 1, 1);
    assert.ok(partial.includes("/inbound-attachments/303"));
    ok("补写幂等 + 只补缺失的");
  }

  console.log(`\n全部通过：${passed} 项`);
}

run().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
