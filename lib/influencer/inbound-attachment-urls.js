export function inboundAttachmentPreviewUrl(inboundAttachmentId) {
  const id = Number(inboundAttachmentId);
  if (!id || Number.isNaN(id)) return null;
  return `/api/influencers/inbound-attachments/${id}`;
}

export function inboundAttachmentDownloadUrl(inboundAttachmentId) {
  const base = inboundAttachmentPreviewUrl(inboundAttachmentId);
  return base ? `${base}?download=1` : null;
}

/** @param {Array<{ inboundAttachmentId?: number, contentType?: string|null }>} items */
export function buildInboundImageMarkers(items) {
  if (!Array.isArray(items) || !items.length) return "";
  const lines = [];
  for (const att of items) {
    const id = att?.inboundAttachmentId;
    const ct = String(att?.contentType || "").toLowerCase();
    if (!id || !ct.startsWith("image/")) continue;
    const url = inboundAttachmentPreviewUrl(id);
    if (url) lines.push(`[IMAGE:${url}]`);
  }
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

/** 为已有正文追加尚未包含的收件图片标记 */
export function appendMissingInboundImageMarkers(content, items) {
  const text = String(content || "");
  const imageItems = (items || []).filter((att) =>
    isImageAttachment(att?.contentType)
  );
  if (!imageItems.length) return text;

  const missing = imageItems.filter((att) => {
    const id = att?.inboundAttachmentId;
    return id && !text.includes(`/api/influencers/inbound-attachments/${id}`);
  });
  if (!missing.length) return text;
  return text + buildInboundImageMarkers(missing);
}

export function isImageAttachment(contentType) {
  return String(contentType || "").toLowerCase().startsWith("image/");
}
