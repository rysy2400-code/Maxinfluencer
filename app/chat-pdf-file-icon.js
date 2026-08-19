import React from "react";

/** DeepSeek 风格 PDF 文件图标（红色底 + 白色 PDF 字样） */
export function ChatPdfFileIcon({ size = 36 }) {
  const s = Number(size) || 36;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, display: "block" }}
    >
      <rect x="2" y="2" width="32" height="32" rx="7" fill="#E5484D" />
      <rect x="10" y="9" width="16" height="18" rx="2" fill="#fff" />
      <text
        x="18"
        y="18.5"
        textAnchor="middle"
        fill="#E5484D"
        fontSize="7"
        fontWeight="800"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        PDF
      </text>
      <text
        x="18"
        y="25"
        textAnchor="middle"
        fill="#E5484D"
        fontSize="4.5"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        .pdf
      </text>
    </svg>
  );
}
