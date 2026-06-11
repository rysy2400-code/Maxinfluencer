import { NextResponse } from "next/server";
import { getInboundAttachmentById } from "../../../../../lib/db/influencer-inbound-attachments-dao.js";
import { requireInboxAdmin } from "../../../../../lib/auth/influencer-inbox-auth-http.js";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { canAccessInboundAttachment } from "../../../../../lib/auth/inbound-attachment-access.js";

function buildContentDisposition(filename, download) {
  const safe = (filename || "attachment").replace(/"/g, "");
  const type = download ? "attachment" : "inline";
  return `${type}; filename="${safe}"`;
}

export async function GET(req, { params }) {
  try {
    const attachmentId = Number(params?.attachmentId);
    if (!attachmentId || Number.isNaN(attachmentId)) {
      return NextResponse.json(
        { success: false, error: "attachmentId 非法" },
        { status: 400 }
      );
    }

    const inboxGate = await requireInboxAdmin(req);
    const advertiserAuth = inboxGate.ok
      ? null
      : await getAuthenticatedAdvertiserUser(req);

    const allowed = await canAccessInboundAttachment(attachmentId, {
      inboxAdmin: inboxGate.ok ? inboxGate.admin : null,
      advertiserAuth,
    });
    if (!allowed) {
      return NextResponse.json(
        { success: false, error: "无权访问该附件" },
        { status: 403 }
      );
    }

    const row = await getInboundAttachmentById(attachmentId);
    if (!row) {
      return NextResponse.json(
        { success: false, error: "附件不存在" },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(req.url);
    const download = searchParams.get("download") === "1";
    const contentType = row.contentType || "application/octet-stream";
    const filename = row.filename || `inbound-attachment-${attachmentId}`;

    const data = Buffer.isBuffer(row.content)
      ? row.content
      : Buffer.from(row.content || []);

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Content-Disposition": buildContentDisposition(filename, download),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("[Inbound Attachment API] 下载失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "下载失败" },
      { status: 500 }
    );
  }
}
