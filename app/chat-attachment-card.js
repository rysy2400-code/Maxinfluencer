"use client";

import React from "react";
import { ChatAttachmentIcon } from "./chat-attachment-icon";
import { buildAttachmentMetaLine } from "./chat-file-utils";
import { attachmentKindForFileName } from "../lib/influencer/attachment-file-types.js";

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
  const isImage = attachmentKindForFileName(fileName) === "image";
  const removable = variant === "composer" && typeof onRemove === "function";
  const clickable = variant === "message" && !!downloadHref;

  const content = (
    <>
      <ChatAttachmentIcon
        fileName={attachment?.name}
        downloadHref={downloadHref}
      />
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

  const cardClassName = [
    "bin-chat-attachment-card",
    `bin-chat-attachment-card--${variant}`,
    isImage ? "bin-chat-attachment-card--image" : "",
    clickable ? "bin-chat-attachment-card--clickable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (clickable) {
    return (
      <a
        href={downloadHref}
        className={cardClassName}
        title={`打开 ${fileName}`}
        target="_blank"
        rel="noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <div className={cardClassName} title={fileName}>
      {content}
    </div>
  );
}
