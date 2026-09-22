/**
 * 聊天附件类型定义（纯函数，前后端共用；禁止引入 Node 内置模块）。
 *
 * 两类用途：
 * 1. 名单导入：仅 Excel / CSV；
 * 2. 随邮件（特殊请求 / 合作确认）发给红人的资料：PDF / Word / PPT / 图片 / 视频。
 * 视频与其它资料一样可随信发送，单文件上限受邮件体积约束；超过上限请改用公开链接。
 */

/** 名单导入只认这三种。 */
export const IMPORT_LIST_EXTENSIONS = [".xlsx", ".xls", ".csv"];

/** 视频附件：可随信发送，单文件上限与普通附件一致（见 maxBytesForFileName）。 */
export const VIDEO_ATTACHMENT_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".wmv",
];

/** 可随邮件发送的资料附件（PDF / Word / PPT / 图片 / 视频）。 */
export const SENDABLE_ATTACHMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ...VIDEO_ATTACHMENT_EXTENSIONS,
];

export const IMAGE_ATTACHMENT_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/** 聊天附件上传白名单 = 名单导入 + 资料附件。 */
export const CHAT_UPLOAD_EXTENSIONS = [
  ...SENDABLE_ATTACHMENT_EXTENSIONS,
  ...IMPORT_LIST_EXTENSIONS,
];

/** 单封消息最多携带的附件数量（前后端一致）。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** 单个附件统一上限 25MB（含图片、视频；受邮件体积约束）。 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 兼容旧引用：图片附件上限已与普通附件统一为 25MB。 */
export const MAX_IMAGE_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;

/**
 * 单封邮件附件合计上限（原始字节，base64 前）。
 *
 * 为什么是 25MB：附件 base64 后膨胀约 4/3，25MB 原始 ≈ 33MB 编码体积。
 * 再大就会出问题——实测发信服务器 global-mail.cn 的 SMTP SIZE 上限为
 * 125829120 字节（120MB），5 × 25MB（约 153MB 编码）会被直接拒：
 * 「552 5.3.4 Error: message file too big」。
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPE_BY_EXT = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
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

/** 视频类文件：可上传、可随信发送，但受单文件大小上限约束。 */
export function isVideoFileName(fileName) {
  return VIDEO_ATTACHMENT_EXTENSIONS.includes(fileExtension(fileName));
}

export function isChatUploadFileName(fileName) {
  return CHAT_UPLOAD_EXTENSIONS.includes(fileExtension(fileName));
}

/** 上传白名单提示文案（前端 alert / 后端错误信息共用）。 */
export const CHAT_UPLOAD_EXTENSIONS_LABEL = CHAT_UPLOAD_EXTENSIONS.join(" / ");

/** 界面提示用文案（按大类归纳，避免把十几个扩展名铺满按钮 title）。 */
export const CHAT_UPLOAD_FRIENDLY_LABEL =
  "PDF / Word / PPT / 图片 / 视频 / Excel";

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

/** 附件展示分类：pdf / image / video / sheet / doc。 */
export function attachmentKindForFileName(fileName) {
  const ext = fileExtension(fileName);
  if (ext === ".pdf") return "pdf";
  if (IMAGE_ATTACHMENT_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_ATTACHMENT_EXTENSIONS.includes(ext)) return "video";
  if (IMPORT_LIST_EXTENSIONS.includes(ext)) return "sheet";
  return "doc";
}

/** 单个附件的大小上限：所有类型统一 25MB。 */
export function maxBytesForFileName(fileName) {
  return MAX_ATTACHMENT_BYTES;
}

/**
 * 计算一组附件的合计字节数（原始体积）。
 * 同时兼容已上传的元数据（sizeBytes）和待上传的 File（size）。
 */
export function totalAttachmentBytes(list) {
  return (Array.isArray(list) ? list : []).reduce((sum, item) => {
    const raw = Number(item?.sizeBytes ?? item?.size);
    return sum + (Number.isFinite(raw) && raw > 0 ? raw : 0);
  }, 0);
}

/** 单封附件体积提示文案（前后端共用）。 */
export const ATTACHMENT_SIZE_RULE_LABEL =
  "单个文件≤25MB，单封附件合计≤25MB，单封最多 5 个";
