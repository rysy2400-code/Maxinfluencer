import React from "react";

const PALETTE = {
  doc: { bg: "#2B579A", fg: "#FFFFFF", label: "DOC" },
  ppt: { bg: "#D24726", fg: "#FFFFFF", label: "PPT" },
  file: { bg: "#6B7280", fg: "#FFFFFF", label: "FILE" },
};

/**
 * DeepSeek 风格文档文件图标（Word / PPT / 其他）。
 * @param {number} [size]
 * @param {"doc"|"ppt"|"file"} [kind]
 * @param {string} [label] 覆盖默认角标文字
 */
export function ChatDocFileIcon({ size = 36, kind = "file", label }) {
  const s = Number(size) || 36;
  const palette = PALETTE[kind] || PALETTE.file;
  const text = String(label || palette.label).slice(0, 4).toUpperCase();
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, display: "block" }}
    >
      <rect x="2" y="2" width="32" height="32" rx="7" fill={palette.bg} />
      <rect x="10" y="8" width="16" height="20" rx="2" fill={palette.fg} />
      <path
        d="M13 14h10M13 17.5h10M13 21h6"
        stroke={palette.bg}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <text
        x="18"
        y="27"
        textAnchor="middle"
        fill={palette.bg}
        fontSize={text.length > 3 ? 5.5 : 7}
        fontWeight="800"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {text}
      </text>
    </svg>
  );
}
