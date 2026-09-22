"use client";

/**
 * 聊天附件上传（前端共用）：类型 / 体积校验 + 调用上传接口。
 *
 * 聊天框与「同意合作 · 内容指引」弹窗共用同一套规则，避免两处白名单漂移。
 */

import { formatFileSize } from "./chat-file-utils.js";
import {
  CHAT_UPLOAD_EXTENSIONS_LABEL,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
  isChatUploadFileName,
  maxBytesForFileName,
  totalAttachmentBytes,
} from "../lib/influencer/attachment-file-types.js";

export const MAX_CHAT_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE;
export const CHAT_UPLOAD_HINT = `${CHAT_UPLOAD_EXTENSIONS_LABEL}`;

/**
 * 上传前校验单个文件（类型 / 体积），返回错误文案或 null。
 * @param {{ name?: string, size?: number }} file
 * @returns {string|null}
 */
export function validateChatAttachmentFile(file) {
  const name = String(file?.name || "");
  if (!isChatUploadFileName(name)) {
    return `${name}：仅支持 ${CHAT_UPLOAD_EXTENSIONS_LABEL}`;
  }
  const maxBytes = maxBytesForFileName(name);
  if (typeof file.size === "number" && file.size > maxBytes) {
    return `${name}：文件超过 ${formatFileSize(maxBytes)} 上限`;
  }
  return null;
}

/** 已选附件占用的合计体积（原始字节）。 */
export function attachmentBudgetUsed(attachments) {
  return totalAttachmentBytes(attachments);
}

/**
 * 从候选文件里挑出可接受的：类型、单文件体积、数量、单封合计体积都要合格。
 * 聊天框与同意合作弹窗共用，保证两处规则完全一致。
 *
 * @param {Array<{name?: string, size?: number}>} files
 * @param {Array<{name?: string, sizeBytes?: number}>} existingAttachments
 * @returns {{ accepted: Array<object>, rejected: string[] }}
 */
export function pickAcceptableAttachments(
  files,
  existingAttachments = [],
  maxSlots = MAX_CHAT_ATTACHMENTS
) {
  const existing = Array.isArray(existingAttachments) ? existingAttachments : [];
  const candidates = Array.isArray(files) ? files : [];
  const accepted = [];
  const rejected = [];
  let slots = maxSlots - existing.length;
  let usedBytes = attachmentBudgetUsed(existing);

  for (const file of candidates) {
    const name = String(file?.name || "文件");
    const invalidReason = validateChatAttachmentFile(file);
    if (invalidReason) {
      rejected.push(invalidReason);
      continue;
    }
    if (slots <= 0) {
      rejected.push(`${name}：单封最多 ${maxSlots} 个附件，已超出`);
      continue;
    }
    const size = Number(file?.size) || 0;
    if (usedBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejected.push(
        `${name}：单封附件合计不能超过 ${formatFileSize(
          MAX_TOTAL_ATTACHMENT_BYTES
        )}（已选 ${formatFileSize(usedBytes)}）`
      );
      continue;
    }
    accepted.push(file);
    usedBytes += size;
    slots -= 1;
  }

  return { accepted, rejected };
}

/**
 * 上传单个附件，返回可写入消息 / contentBrief 的附件元数据。
 * @param {string} endpoint
 * @param {{ name?: string, size?: number }} file
 */
async function postAttachmentFile(endpoint, file) {
  const fd = new FormData();
  fd.set("file", file);
  const res = await fetch(endpoint, {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  const data = await res.json();
  if (!data?.success) {
    throw new Error(`${file?.name || "附件"}：${data?.error || "上传失败"}`);
  }
  return {
    type: "chat_attachment",
    name: data.fileName || file?.name || "attachment",
    storageKey: data.storageKey,
    sizeBytes: file?.size ?? data.sizeBytes,
    contentType: data.contentType || file?.type || undefined,
  };
}

/**
 * 聊天框附件：存到会话附件目录。
 * @param {string} sessionId
 * @param {{ name?: string, size?: number }} file
 */
export function uploadChatAttachmentFile(sessionId, file) {
  return postAttachmentFile(
    `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments`,
    file
  );
}

/**
 * 「同意合作 · 严格参考脚本」附件：存到 campaign 附件目录。
 * @param {string} campaignId
 * @param {{ name?: string, size?: number }} file
 */
export function uploadCampaignExecutionAttachment(campaignId, file) {
  return postAttachmentFile(
    `/api/campaigns/${encodeURIComponent(campaignId)}/execution-attachments`,
    file
  );
}
