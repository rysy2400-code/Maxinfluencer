import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../../../lib/auth/session-access.js";
import {
  readSessionImportFile,
  saveSessionImportFile,
  storageKeyBelongsToSession,
} from "../../../../../lib/influencer/session-import-storage.js";
import { buildContentDisposition } from "../../../../../lib/http/content-disposition.js";

export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = [".pdf", ".xlsx", ".xls", ".csv"];

function isSupportedFileName(fileName) {
  const lower = String(fileName || "").toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isPdfFileName(fileName) {
  return String(fileName || "").toLowerCase().endsWith(".pdf");
}

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

function contentTypeForFileName(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
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

    const buffer = readSessionImportFile(storageKey);
    if (!buffer) {
      return NextResponse.json({ success: false, error: "附件不存在" }, { status: 404 });
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
    if (buffer.length > MAX_BYTES) {
      return NextResponse.json({ success: false, error: "文件过大（上限 15MB）" }, { status: 400 });
    }

    const fileName = String(file.name || "attachment.xlsx");
    const lower = fileName.toLowerCase();
    if (!isSupportedFileName(fileName)) {
      return NextResponse.json(
        { success: false, error: "仅支持 .pdf / .xlsx / .xls / .csv" },
        { status: 400 }
      );
    }

    if (isPdfFileName(fileName) && !looksLikePdf(buffer)) {
      return NextResponse.json(
        { success: false, error: "PDF 文件内容校验失败，请确认文件未损坏" },
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
