/**
 * 「同意合作 · 严格参考脚本」附件落库。
 *
 * 为什么必须落库：附件上传发生在 Web 机器（文件写在 Web 的 data/session-imports），
 * 而真正发确认邮件的 influencer agent worker 可能跑在另一台机器上，读不到 Web 的本地文件。
 * 只带 storageKey 的话 worker 会报「附件不存在或读取失败」，邮件发不出去。
 *
 * 这里读不到文件会直接抛错（而不是让事件异步失败），广告主在卡片上立刻看到失败，
 * 不会以为合作已确认、附件已发出。
 */

import {
  readSessionImportFile,
  storageKeyBelongsToNamespace,
} from "../influencer/session-import-storage.js";
import { insertOutboundAttachment } from "../db/influencer-outbound-attachments-dao.js";
import {
  MAX_TOTAL_ATTACHMENT_BYTES,
  totalAttachmentBytes,
} from "../influencer/attachment-file-types.js";

/**
 * @param {object} contentBrief
 * @param {{ campaignId?: string, influencerId?: string, allowedNamespaces?: Array<string|null|undefined> }} opts
 * @returns {Promise<object>} 带 outboundAttachmentId 的 contentBrief
 */
export async function persistContentBriefAttachments(contentBrief, opts = {}) {
  const attachments = Array.isArray(contentBrief?.attachments)
    ? contentBrief.attachments
    : [];
  if (!attachments.length) return contentBrief;

  const campaignId = String(opts.campaignId || "").trim();
  const influencerId = String(opts.influencerId || "").trim();
  const allowedNamespaces = (
    Array.isArray(opts.allowedNamespaces) ? opts.allowedNamespaces : [campaignId]
  )
    .map((ns) => String(ns || "").trim())
    .filter(Boolean);
  const out = [];
  let totalBytes = 0;

  for (let idx = 0; idx < attachments.length; idx++) {
    const att = attachments[idx] || {};
    const fileName = String(att.fileName || "").trim();
    const storageKey = String(att.storageKey || "").trim();
    if (!fileName || !storageKey) continue;
    const allowed = allowedNamespaces.some((ns) =>
      storageKeyBelongsToNamespace(storageKey, ns)
    );
    if (!allowed) {
      throw new Error(`附件「${fileName}」不属于当前 Campaign，请重新上传后再提交`);
    }

    const buffer = readSessionImportFile(storageKey);
    if (!buffer?.length) {
      throw new Error(`附件「${fileName}」在服务器上不存在或读取失败，请重新上传后再提交`);
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `单封邮件附件合计不能超过 ${Math.round(
          MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024
        )}MB，请减少附件或改用链接后再提交`
      );
    }

    const outboundDedupeKey = `brief:${campaignId}:${influencerId}:${idx}`;
    const outboundAttachmentId = await insertOutboundAttachment({
      dedupeKey: outboundDedupeKey,
      filename: fileName,
      contentType: att.contentType,
      sizeBytes: buffer.length,
      content: buffer,
    });

    out.push({
      ...att,
      fileName,
      storageKey,
      sizeBytes: buffer.length,
      outboundDedupeKey,
      ...(outboundAttachmentId ? { outboundAttachmentId } : {}),
    });
  }

  return { ...contentBrief, attachments: out };
}
