import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../../../lib/auth/session-access.js";
import {
  readSessionImportFile,
  saveSessionImportFile,
  storageKeyBelongsToSession,
} from "../../../../../lib/influencer/session-import-storage.js";
import { resolveChatAttachmentBuffer } from "../../../../../lib/influencer/chat-attachment-resolver.js";
import { buildContentDisposition } from "../../../../../lib/http/content-disposition.js";
import {
  looksLikeImage,
  looksLikePdf,
} from "../../../../../lib/influencer/attachment-content-checks.js";
import {
  CHAT_UPLOAD_EXTENSIONS_LABEL,
  contentTypeForFileName,
  isChatUploadFileName,
  isImageFileName,
  isPdfFileName,
  isVideoFileName,
  maxBytesForFileName,
} from "../../../../../lib/influencer/attachment-file-types.js";

export const dynamic = "force-dynamic";

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0MB";
  return `${Math.round(n / (1024 * 1024))}MB`;
}

function sanitizeDownloadFileName(name, fallback) {
  const raw = String(name || "").trim();
  const base = raw ? raw.split(/[/\\]/).pop() : "";
  const safe = (base || fallback || "attachment").replace(/"/g, "").slice(0, 200);
  return safe || "attachment";
}

export async function GET(req, { params }) {
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

    const { searchParams } = new URL(req.url);
    const storageKey = String(searchParams.get("storageKey") || "").trim();
    if (!storageKey || storageKey.includes("..")) {
      return NextResponse.json({ success: false, error: "缺少或非法 storageKey" }, { status: 400 });
    }
    if (!storageKeyBelongsToSession(storageKey, sessionId)) {
      return NextResponse.json({ success: false, error: "附件不属于该会话" }, { status: 403 });
    }

    const resolved = await resolveChatAttachmentBuffer(sessionId, storageKey);
    if (!resolved?.buffer) {
      return NextResponse.json({ success: false, error: "附件不存在" }, { status: 404 });
    }
    const buffer = resolved.buffer;
    const resolvedStorageKey = resolved.storageKey || storageKey;
    if (!storageKeyBelongsToSession(resolvedStorageKey, sessionId)) {
      return NextResponse.json({ success: false, error: "附件不属于该会话" }, { status: 403 });
    }

    const storageFallback = storageKey.split("/").pop() || "attachment.xlsx";
    const requestedName = searchParams.get("fileName");
    const fileName = sanitizeDownloadFileName(requestedName, storageFallback);
    // 图片 / 视频用 inline：点击即可在浏览器里查看、播放（与微信聊天一致）；
    // 文档类仍强制下载，避免浏览器直接打开 Office / PDF 造成困扰。
    const inlineViewable = isImageFileName(fileName) || isVideoFileName(fileName);
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForFileName(fileName),
        "Content-Length": String(buffer.length),
        "Content-Disposition": buildContentDisposition(fileName, !inlineViewable),
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    console.error("[chat-attachments GET]", err);
    return NextResponse.json(
      { success: false, error: err?.message || "下载失败" },
      { status: 500 }
    );
  }
}

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
    const fileName = String(file.name || "attachment.xlsx");

    if (!isChatUploadFileName(fileName)) {
      return NextResponse.json(
        { success: false, error: `仅支持 ${CHAT_UPLOAD_EXTENSIONS_LABEL}` },
        { status: 400 }
      );
    }

    const maxBytes = maxBytesForFileName(fileName);
    if (buffer.length > maxBytes) {
      return NextResponse.json(
        { success: false, error: `文件过大（单文件上限 ${formatBytes(maxBytes)}）` },
        { status: 400 }
      );
    }

    if (isPdfFileName(fileName) && !looksLikePdf(buffer)) {
      return NextResponse.json(
        { success: false, error: "PDF 文件内容校验失败，请确认文件未损坏" },
        { status: 400 }
      );
    }

    if (isImageFileName(fileName) && !looksLikeImage(buffer, fileName)) {
      return NextResponse.json(
        { success: false, error: "图片文件内容校验失败，请确认文件未损坏" },
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
