/**
 * 生成安全的 Content-Disposition 响应头。
 *
 * HTTP 头的 ByteString 只允许 Latin-1 字符，直接把含 Unicode（如弯引号
 * “ ”、中文）的附件名放进 header 会抛 undici 的
 * "Cannot convert argument to a ByteString ... greater than 255" 错误。
 * 这里用 ASCII 文件名作为兼容兜底，并附加 RFC 5987 的 filename* 保留原文件名。
 */
export function buildContentDisposition(filename, download) {
  const raw = String(filename ?? "attachment")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  const fallback =
    raw
      .replace(/["\\;]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .slice(0, 200) || "attachment";
  const encoded = encodeURIComponent(raw).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  const type = download ? "attachment" : "inline";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
