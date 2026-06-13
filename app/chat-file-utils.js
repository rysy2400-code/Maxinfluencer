/** 聊天附件展示：扩展名与大小格式化 */

export function getFileExtensionLabel(fileName) {
  const name = String(fileName || "").trim();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "FILE";
  return name.slice(dot + 1).toUpperCase() || "FILE";
}

export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

export function buildAttachmentMetaLine(att) {
  const ext = getFileExtensionLabel(att?.name);
  const size = formatFileSize(att?.sizeBytes);
  return size ? `${ext} ${size}` : ext;
}

/** 用户仅上传附件、无自定义文字时的占位正文 */
export function isAttachmentOnlyUserMessage(msg) {
  if (!msg || msg.role !== "user") return false;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (!attachments.length) return false;
  const content = String(msg.content || "").trim();
  if (!content) return true;
  const names = attachments.map((a) => a?.name || "文件").join("、");
  return content === `上传附件：${names}`;
}
