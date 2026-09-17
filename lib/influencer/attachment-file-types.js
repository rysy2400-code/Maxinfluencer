/**
 * 聊天附件类型定义（纯函数，前后端共用；禁止引入 Node 内置模块）。
 *
 * 两类用途：
 * 1. 名单导入：仅 Excel / CSV；
 * 2. 随特殊请求邮件发送的资料：PDF / Word / PPT / 图片（png / jpg）。
 * 视频不作为邮件附件发送，改为让用户在正文里提供可公开访问的链接。
 */

/** 名单导入只认这三种。 */
export const IMPORT_LIST_EXTENSIONS = [".xlsx", ".xls", ".csv"];

/** 可随特殊请求邮件发送的资料附件。 */
export const SENDABLE_ATTACHMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
];

export const IMAGE_ATTACHMENT_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/** 视频等大文件不走附件，引导用户改用链接。 */
export const LINK_ONLY_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".wmv",
];

/** 聊天附件上传白名单 = 名单导入 + 资料附件。 */
export const CHAT_UPLOAD_EXTENSIONS = [
  ...SENDABLE_ATTACHMENT_EXTENSIONS,
  ...IMPORT_LIST_EXTENSIONS,
];

/** 单封消息最多携带的附件数量（前后端一致）。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** 单个图片附件上限 20MB（邮件体积考虑）。 */
export const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 单个非图片附件上限 25MB。 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPE_BY_EXT = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv; charset=utf-8",
};

/** 取小写扩展名（含点）；无扩展名返回空串。 */
export function fileExtension(fileName) {
  const name = String(fileName || "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot);
}

export function isPdfFileName(fileName) {
  return fileExtension(fileName) === ".pdf";
}

export function isImageFileName(fileName) {
  return IMAGE_ATTACHMENT_EXTENSIONS.includes(fileExtension(fileName));
}

export function isImportListFileName(fileName) {
  return IMPORT_LIST_EXTENSIONS.includes(fileExtension(fileName));
}

/** 可作为特殊请求资料附件随信发送。 */
export function isSendableAttachmentFileName(fileName) {
  return SENDABLE_ATTACHMENT_EXTENSIONS.includes(fileExtension(fileName));
}

/** 视频类文件：不接受上传，引导改用链接。 */
export function isVideoFileName(fileName) {
  return LINK_ONLY_EXTENSIONS.includes(fileExtension(fileName));
}

export function isChatUploadFileName(fileName) {
  return CHAT_UPLOAD_EXTENSIONS.includes(fileExtension(fileName));
}

/** 上传白名单提示文案（前端 alert / 后端错误信息共用）。 */
export const CHAT_UPLOAD_EXTENSIONS_LABEL = CHAT_UPLOAD_EXTENSIONS.join(" / ");

/** 按扩展名推断 MIME；未知扩展名回退到 fallback。 */
export function contentTypeForFileName(
  fileName,
  fallback = "application/octet-stream"
) {
  return CONTENT_TYPE_BY_EXT[fileExtension(fileName)] || fallback;
}

/**
 * 校正附件 MIME：文件名能识别出类型时以扩展名为准（前端浏览器给的 type 常为空或不准），
 * 无法识别时才用调用方传入的值。
 */
export function normalizeAttachmentContentType(fileName, contentType) {
  const byExt = CONTENT_TYPE_BY_EXT[fileExtension(fileName)];
  if (byExt) return byExt;
  const raw = String(contentType || "").trim();
  return raw || "application/octet-stream";
}

/** 附件展示分类：pdf / image / sheet / doc。 */
export function attachmentKindForFileName(fileName) {
  const ext = fileExtension(fileName);
  if (ext === ".pdf") return "pdf";
  if (IMAGE_ATTACHMENT_EXTENSIONS.includes(ext)) return "image";
  if (IMPORT_LIST_EXTENSIONS.includes(ext)) return "sheet";
  return "doc";
}

/** 单个附件的大小上限：图片 20MB，其余 25MB。 */
export function maxBytesForFileName(fileName) {
  return isImageFileName(fileName)
    ? MAX_IMAGE_ATTACHMENT_BYTES
    : MAX_ATTACHMENT_BYTES;
}
