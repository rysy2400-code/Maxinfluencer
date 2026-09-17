/** 聊天附件展示：扩展名与大小格式化 */

/**
 * 把 input[type=file].files / DataTransfer.files 快照成普通数组。
 *
 * 必须快照后再清空 input.value：`input.files` 是实时列表，一旦清空输入框，
 * 之前拿到的引用也会变空，导致「选完文件没反应」——不报错、不提示、也不上传。
 * 返回的是独立副本，之后源列表怎么变都不受影响。
 *
 * @param {FileList|File[]|null|undefined} fileList
 * @returns {File[]}
 */
export function snapshotPickedFiles(fileList) {
  if (Array.isArray(fileList)) return fileList.filter(Boolean);
  if (!fileList) return [];
  return Array.from(fileList).filter(Boolean);
}

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

/** 聊天记录附件下载 URL（需登录且有权访问该 session） */
export function chatAttachmentDownloadHref(sessionId, attachment) {
  const sid = String(sessionId || "").trim();
  const storageKey = String(attachment?.storageKey || "").trim();
  if (!sid || !storageKey) return null;
  const params = new URLSearchParams({ storageKey });
  const name = String(attachment?.name || "").trim();
  if (name) params.set("fileName", name);
  return `/api/sessions/${encodeURIComponent(sid)}/chat-attachments?${params}`;
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
