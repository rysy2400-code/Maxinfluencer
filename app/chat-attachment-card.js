"use client";

import React from "react";
import { ChatExcelFileIcon } from "./chat-excel-file-icon";
import { ChatPdfFileIcon } from "./chat-pdf-file-icon";
import { ChatDocFileIcon } from "./chat-doc-file-icon";
import { buildAttachmentMetaLine } from "./chat-file-utils";
import {
  attachmentKindForFileName,
  fileExtension,
} from "../lib/influencer/attachment-file-types.js";

/** 图片附件：有可访问链接时直接显示缩略图。 */
function AttachmentThumbnail({ fileName, href }) {
  const [failed, setFailed] = React.useState(false);
  if (!href || failed) {
    return <ChatDocFileIcon size={36} kind="file" label={fileExtension(fileName).replace(".", "") || "IMG"} />;
  }
  return (
    <img
      className="bin-chat-attachment-card__thumb"
      src={href}
      alt={fileName}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 附件图标：PDF / Excel / Word / PPT / 图片缩略图。 */
function AttachmentIcon({ attachment, downloadHref }) {
  const fileName = String(attachment?.name || "");
  const kind = attachmentKindForFileName(fileName);
  if (kind === "image") {
    return <AttachmentThumbnail fileName={fileName} href={downloadHref} />;
  }
  if (kind === "pdf") return <ChatPdfFileIcon size={36} />;
  if (kind === "sheet") return <ChatExcelFileIcon size={36} />;
  const ext = fileExtension(fileName).replace(".", "");
  const iconKind = ext === "docx" || ext === "doc" ? "doc" : ext === "pptx" || ext === "ppt" ? "ppt" : "file";
  return <ChatDocFileIcon size={36} kind={iconKind} label={ext || "FILE"} />;
}

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
      <AttachmentIcon attachment={attachment} downloadHref={downloadHref} />
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
