import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../../../lib/auth/session-access.js";
import { saveSessionImportFile } from "../../../../../lib/influencer/session-import-storage.js";

export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req, { params }) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const sessionId = String(params?.id || "").trim();
    if (!sessionId) {
      return NextResponse.json({ success: false, error: "缺少 sessionId" }, { status: 400 });
    }

    const access = await assertUserCanAccessSession(sessionId, auth);
    if (!access.ok) {
      return NextResponse.json(
        { success: false, error: access.status === 403 ? "无权访问该会话" : "会话不存在" },
        { status: access.status }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ success: false, error: "请上传文件" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return NextResponse.json({ success: false, error: "文件过大（上限 15MB）" }, { status: 400 });
    }

    const fileName = String(file.name || "attachment.xlsx");
    const lower = fileName.toLowerCase();
    if (
      !lower.endsWith(".xlsx") &&
      !lower.endsWith(".xls") &&
      !lower.endsWith(".csv")
    ) {
      return NextResponse.json(
        { success: false, error: "仅支持 .xlsx / .xls / .csv" },
        { status: 400 }
      );
    }

    const pendingBatchId = `PENDING-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const { storageKey } = saveSessionImportFile(sessionId, pendingBatchId, buffer, fileName);

    return NextResponse.json({
      success: true,
      storageKey,
      fileName,
      sizeBytes: buffer.length,
      type: "chat_attachment",
    });
  } catch (err) {
    console.error("[chat-attachments]", err);
    return NextResponse.json(
      { success: false, error: err?.message || "上传失败" },
      { status: 500 }
    );
  }
}
