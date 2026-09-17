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
  CHAT_UPLOAD_EXTENSIONS_LABEL,
  contentTypeForFileName,
  isChatUploadFileName,
  isImageFileName,
  isPdfFileName,
  isVideoFileName,
  maxBytesForFileName,
} from "../../../../../lib/influencer/attachment-file-types.js";

export const dynamic = "force-dynamic";

function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return (
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46 && // F
    buffer[4] === 0x2d    // -
  );
}

function looksLikePng(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return sig.every((byte, i) => buffer[i] === byte);
}

function looksLikeJpeg(buffer) {
  if (!buffer || buffer.length < 3) return false;
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function extensionLower(fileName) {
  const name = String(fileName || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

/** 图片按扩展名做一次魔数校验，避免改了后缀名的文件混进来。 */
function looksLikeImage(buffer, fileName) {
  const ext = extensionLower(fileName);
  if (ext === ".png") return looksLikePng(buffer);
  if (ext === ".jpg" || ext === ".jpeg") return looksLikeJpeg(buffer);
  return true;
}

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
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForFileName(fileName),
        "Content-Length": String(buffer.length),
        "Content-Disposition": buildContentDisposition(fileName, true),
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

    if (isVideoFileName(fileName)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "视频请改用链接方式：把视频上传到 YouTube / Google Drive / Dropbox 后，将链接粘贴在消息里发给红人。",
        },
        { status: 400 }
      );
    }

    if (!isChatUploadFileName(fileName)) {
      return NextResponse.json(
        { success: false, error: `仅支持 ${CHAT_UPLOAD_EXTENSIONS_LABEL}` },
        { status: 400 }
      );
    }

    const maxBytes = maxBytesForFileName(fileName);
    if (buffer.length > maxBytes) {
      return NextResponse.json(
        {
          success: false,
          error: isImageFileName(fileName)
            ? `图片过大（单张上限 ${formatBytes(maxBytes)}）`
            : `文件过大（上限 ${formatBytes(maxBytes)}）`,
        },
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
