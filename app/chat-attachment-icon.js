"use client";

import React from "react";
import { ChatDocFileIcon } from "./chat-doc-file-icon";
import { ChatExcelFileIcon } from "./chat-excel-file-icon";
import { ChatPdfFileIcon } from "./chat-pdf-file-icon";
import { ChatVideoFileIcon } from "./chat-video-file-icon";
import {
  attachmentKindForFileName,
  fileExtension,
} from "../lib/influencer/attachment-file-types.js";

/** 图片附件：有可访问链接时直接显示缩略图，加载失败回退成图标。 */
function AttachmentThumbnail({ fileName, href }) {
  const [failed, setFailed] = React.useState(false);
  if (!href || failed) {
    return (
      <ChatDocFileIcon
        size={36}
        kind="file"
        label={fileExtension(fileName).replace(".", "") || "IMG"}
      />
    );
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

/** 附件图标：PDF / Excel / Word / PPT / 图片缩略图 / 视频。 */
export function ChatAttachmentIcon({ fileName, downloadHref = null }) {
  const name = String(fileName || "");
  const kind = attachmentKindForFileName(name);
  if (kind === "image") {
    return <AttachmentThumbnail fileName={name} href={downloadHref} />;
  }
  if (kind === "pdf") return <ChatPdfFileIcon size={36} />;
  if (kind === "video") return <ChatVideoFileIcon size={36} />;
  if (kind === "sheet") return <ChatExcelFileIcon size={36} />;
  const ext = fileExtension(name).replace(".", "");
  const iconKind =
    ext === "docx" || ext === "doc"
      ? "doc"
      : ext === "pptx" || ext === "ppt"
        ? "ppt"
        : "file";
  return <ChatDocFileIcon size={36} kind={iconKind} label={ext || "FILE"} />;
}
