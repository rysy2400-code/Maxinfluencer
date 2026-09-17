/**
 * 收件附件（红人邮件附件）在广告主侧的统一定义与渲染标记。
 *
 * 三类展示形态：
 * - image：聊天框内联缩略图（沿用 [IMAGE:url] 旧格式，保持历史消息兼容）
 * - video：聊天框内嵌播放器（[VIDEO:url|filename]）
 * - file ：可点击的附件卡片（[FILE:url|filename]）
 *
 * 非业务附件（转发邮件本体、退信通知、S/MIME 签名、winmail.dat）不展示。
 * 本模块是纯函数，前端与 worker 共用。
 */

/** 不展示的收件附件类型：都是邮件系统产物，不是红人想给你的资料。 */
export const HIDDEN_INBOUND_ATTACHMENT_TYPES = [
  // 「转发为附件」时挂上的整封原邮件
  "message/rfc822",
  // 退信 / 投递状态通知
  "message/delivery-status",
  // S/MIME 数字签名（企业邮箱自动附带）
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  // Outlook 富文本封装（winmail.dat）
  "application/ms-tnef",
];

/** 单条消息最多展示的附件数（超出部分不生成标记）。 */
export const MAX_INBOUND_ATTACHMENT_MARKERS = 10;

/** 取主类型：去参数、转小写。 */
export function normalizeAttachmentContentType(contentType) {
  return String(contentType || "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
}

export function isHiddenInboundAttachment(contentType) {
  const ct = normalizeAttachmentContentType(contentType);
  if (!ct) return false;
  return HIDDEN_INBOUND_ATTACHMENT_TYPES.includes(ct);
}

export function isImageAttachment(contentType) {
  return normalizeAttachmentContentType(contentType).startsWith("image/");
}

export function isVideoAttachment(contentType) {
  return normalizeAttachmentContentType(contentType).startsWith("video/");
}

/** 展示形态：image / video / file。 */
export function inboundAttachmentKind(contentType) {
  if (isImageAttachment(contentType)) return "image";
  if (isVideoAttachment(contentType)) return "video";
  return "file";
}

/**
 * 筛出要展示给广告主的附件：去掉黑名单类型，保持原顺序，最多 limit 个。
 * @param {Array<{inboundAttachmentId?: number, contentType?: string|null}>} items
 */
export function selectDisplayableInboundAttachments(
  items,
  { limit = MAX_INBOUND_ATTACHMENT_MARKERS } = {}
) {
  if (!Array.isArray(items) || !items.length) return [];
  return items
    .filter(
      (att) =>
        att?.inboundAttachmentId && !isHiddenInboundAttachment(att?.contentType)
    )
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function inboundAttachmentPreviewUrl(inboundAttachmentId) {
  const id = Number(inboundAttachmentId);
  if (!id || Number.isNaN(id)) return null;
  return `/api/influencers/inbound-attachments/${id}`;
}

export function inboundAttachmentDownloadUrl(inboundAttachmentId) {
  const base = inboundAttachmentPreviewUrl(inboundAttachmentId);
  return base ? `${base}?download=1` : null;
}

/** 标记里的文件名不能带换行 / 竖线 / 方括号，避免破坏解析。 */
function sanitizeMarkerFileName(name) {
  return String(name || "")
    .replace(/[\r\n|[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function buildMarker(kind, url, filename) {
  const safeName = sanitizeMarkerFileName(filename);
  if (kind === "image") return `[IMAGE:${url}]`;
  const tag = kind === "video" ? "VIDEO" : "FILE";
  return safeName ? `[${tag}:${url}|${safeName}]` : `[${tag}:${url}]`;
}

/**
 * 生成收件附件标记（图片 / 视频 / 文件，已过滤黑名单并限制数量）。
 * @param {Array<{inboundAttachmentId?: number, contentType?: string|null, filename?: string|null}>} items
 */
export function buildInboundAttachmentMarkers(
  items,
  { limit = MAX_INBOUND_ATTACHMENT_MARKERS } = {}
) {
  const displayable = selectDisplayableInboundAttachments(items, { limit });
  if (!displayable.length) return "";
  const lines = [];
  for (const att of displayable) {
    const url = inboundAttachmentPreviewUrl(att.inboundAttachmentId);
    if (!url) continue;
    lines.push(
      buildMarker(inboundAttachmentKind(att.contentType), url, att.filename)
    );
  }
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

/** @deprecated 兼容旧调用：只输出图片标记，等价于 buildInboundAttachmentMarkers 的图片子集。 */
export function buildInboundImageMarkers(items) {
  if (!Array.isArray(items) || !items.length) return "";
  const images = items.filter((att) => isImageAttachment(att?.contentType));
  return buildInboundAttachmentMarkers(images);
}

/** 正文里是否已经包含该附件的链接（用于幂等补写）。 */
function contentHasAttachmentLink(content, id) {
  return String(content || "").includes(
    `/api/influencers/inbound-attachments/${id}`
  );
}

/**
 * 为已有正文补齐尚未包含的附件标记（幂等：已存在的跳过）。
 */
export function appendMissingInboundAttachmentMarkers(
  content,
  items,
  { limit = MAX_INBOUND_ATTACHMENT_MARKERS } = {}
) {
  const text = String(content || "");
  const displayable = selectDisplayableInboundAttachments(items, { limit });
  if (!displayable.length) return text;
  const missing = displayable.filter(
    (att) => !contentHasAttachmentLink(text, att.inboundAttachmentId)
  );
  if (!missing.length) return text;
  return text + buildInboundAttachmentMarkers(missing, { limit });
}

/** @deprecated 兼容旧调用：只补图片标记。 */
export function appendMissingInboundImageMarkers(content, items) {
  const images = (Array.isArray(items) ? items : []).filter((att) =>
    isImageAttachment(att?.contentType)
  );
  return appendMissingInboundAttachmentMarkers(content, images);
}
