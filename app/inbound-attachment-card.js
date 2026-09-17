"use client";

import React from "react";
import { ChatAttachmentIcon } from "./chat-attachment-icon";
import { buildAttachmentMetaLine } from "./chat-file-utils";
import {
  inboundAttachmentDownloadUrl,
  inboundAttachmentPreviewUrl,
} from "../lib/influencer/inbound-attachment-urls.js";

/**
 * 红人邮件附件卡片（广告主侧）。
 * 「打开」在新窗口预览/播放，「下载」带 Content-Disposition 落盘。
 * @param {{ inboundAttachmentId?: number, filename?: string|null, contentType?: string|null, sizeBytes?: number|null }} attachment
 */
export function InboundAttachmentCard({ attachment }) {
  const id = attachment?.inboundAttachmentId;
  const previewHref = inboundAttachmentPreviewUrl(id);
  const downloadHref = inboundAttachmentDownloadUrl(id);
  if (!previewHref) return null;

  const fileName = String(attachment?.filename || "").trim() || `附件 ${id}`;
  const meta = buildAttachmentMetaLine({
    name: fileName,
    sizeBytes: attachment?.sizeBytes,
  });

  return (
    <div
      className="bin-chat-attachment-card bin-chat-attachment-card--message bin-inbound-attachment-card"
      title={fileName}
    >
      <ChatAttachmentIcon fileName={fileName} downloadHref={previewHref} />
      <div className="bin-chat-attachment-card__text">
        <div className="bin-chat-attachment-card__name">{fileName}</div>
        <div className="bin-chat-attachment-card__meta">{meta}</div>
        <div className="bin-inbound-attachment-card__actions">
          <a href={previewHref} target="_blank" rel="noreferrer">
            打开
          </a>
          <a href={downloadHref}>下载</a>
        </div>
      </div>
    </div>
  );
}
