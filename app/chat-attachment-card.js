"use client";

import React from "react";
import { ChatExcelFileIcon } from "./chat-excel-file-icon";
import { ChatPdfFileIcon } from "./chat-pdf-file-icon";
import { buildAttachmentMetaLine } from "./chat-file-utils";

/**
 * DeepSeek 风格附件卡片
 * @param {{ name?: string, sizeBytes?: number }} attachment
 * @param {"composer"|"message"} [variant]
 * @param {() => void} [onRemove]
 * @param {string|null} [downloadHref] 有值时可点击下载/打开
 */
export function ChatAttachmentCard({
  attachment,
  variant = "message",
  onRemove,
  downloadHref = null,
}) {
  const fileName = String(attachment?.name || "附件").trim() || "附件";
  const meta = buildAttachmentMetaLine(attachment);
  const isPdf = String(attachment?.name || "").toLowerCase().endsWith(".pdf");
  const removable = variant === "composer" && typeof onRemove === "function";
  const clickable = variant === "message" && !!downloadHref;

  const content = (
    <>
      {isPdf ? <ChatPdfFileIcon size={36} /> : <ChatExcelFileIcon size={36} />}
      <div className="bin-chat-attachment-card__text">
        <div className="bin-chat-attachment-card__name">{fileName}</div>
        <div className="bin-chat-attachment-card__meta">{meta}</div>
      </div>
      {removable && (
        <button
          type="button"
          className="bin-chat-attachment-card__remove"
          onClick={onRemove}
          aria-label="移除附件"
        >
          ×
        </button>
      )}
    </>
  );

  if (clickable) {
    return (
      <a
        href={downloadHref}
        className={`bin-chat-attachment-card bin-chat-attachment-card--${variant} bin-chat-attachment-card--clickable`}
        title={`打开 ${fileName}`}
        target="_blank"
        rel="noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <div
      className={`bin-chat-attachment-card bin-chat-attachment-card--${variant}`}
      title={fileName}
    >
      {content}
    </div>
  );
}
