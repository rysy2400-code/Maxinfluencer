/**
 * 附件内容轻量校验（纯函数，前后端可复用）。
 *
 * 只按扩展名做一次魔数校验，避免把改了后缀名的文件当成 PDF / 图片混进来。
 * 聊天附件上传与「同意合作 · 严格参考脚本」附件上传共用同一套规则。
 */

export function extensionLower(fileName) {
  const name = String(fileName || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

export function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return (
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46 && // F
    buffer[4] === 0x2d // -
  );
}

export function looksLikePng(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return sig.every((byte, i) => buffer[i] === byte);
}

export function looksLikeJpeg(buffer) {
  if (!buffer || buffer.length < 3) return false;
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** 图片按扩展名做一次魔数校验；其它扩展名一律放行。 */
export function looksLikeImage(buffer, fileName) {
  const ext = extensionLower(fileName);
  if (ext === ".png") return looksLikePng(buffer);
  if (ext === ".jpg" || ext === ".jpeg") return looksLikeJpeg(buffer);
  return true;
}
