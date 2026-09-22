import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessCampaign } from "../../../../../lib/auth/campaign-access.js";
import { saveSessionImportFile } from "../../../../../lib/influencer/session-import-storage.js";
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
  maxBytesForFileName,
} from "../../../../../lib/influencer/attachment-file-types.js";

export const dynamic = "force-dynamic";

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0MB";
  return `${Math.round(n / (1024 * 1024))}MB`;
}

/**
 * POST /api/campaigns/[id]/execution-attachments
 *
 * 「同意合作 · 严格参考脚本」卡片里上传的脚本 / 资料附件。
 * 白名单与体积限制和聊天框完全一致（PDF / Word / PPT / 图片 / 视频 / Excel，
 * 单封最多 5 个、单文件 ≤25MB、单封合计 ≤25MB），只是存储目录按 campaign 划分。
 */
export async function POST(req, { params }) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const campaignId = String(params?.id || "").trim();
    if (!campaignId) {
      return NextResponse.json({ success: false, error: "缺少 campaignId" }, { status: 400 });
    }

    const access = await assertUserCanAccessCampaign(campaignId, auth);
    if (!access.ok) {
      return NextResponse.json(
        {
          success: false,
          error: access.status === 403 ? "无权访问该 Campaign" : "Campaign 不存在",
        },
        { status: access.status }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ success: false, error: "请上传文件" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = String(file.name || "").trim();

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
    const { storageKey } = saveSessionImportFile(
      campaignId,
      pendingBatchId,
      buffer,
      fileName
    );

    return NextResponse.json({
      success: true,
      storageKey,
      fileName,
      sizeBytes: buffer.length,
      contentType: contentTypeForFileName(fileName),
    });
  } catch (err) {
    console.error("[execution-attachments]", err);
    return NextResponse.json(
      { success: false, error: err?.message || "上传失败" },
      { status: 500 }
    );
  }
}
