import { NextResponse } from "next/server";
import { getOutboundAttachmentById } from "../../../../../lib/db/influencer-outbound-attachments-dao.js";

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

    const row = await getOutboundAttachmentById(attachmentId);
    if (!row) {
      return NextResponse.json(
        { success: false, error: "附件不存在" },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(req.url);
    const download = searchParams.get("download") === "1";
    const contentType = row.content_type || "application/octet-stream";
    const filename = row.filename || `attachment-${attachmentId}`;

    const data = Buffer.isBuffer(row.content)
      ? row.content
      : Buffer.from(row.content || []);

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Content-Disposition": buildContentDisposition(filename, download),
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    console.error("[Influencer Attachment API] 下载失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "下载失败" },
      { status: 500 }
    );
  }
}

