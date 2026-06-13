import React from "react";

/** DeepSeek 风格 Excel 文件图标（绿色底 + 白色 X） */
export function ChatExcelFileIcon({ size = 36 }) {
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
      <rect x="2" y="2" width="32" height="32" rx="7" fill="#1F9D5C" />
      <rect x="10" y="9" width="16" height="18" rx="2" fill="#fff" />
      <path
        d="M13 14h10M13 17.5h10M13 21h6"
        stroke="#1F9D5C"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <text
        x="23"
        y="22"
        textAnchor="middle"
        fill="#1F9D5C"
        fontSize="8"
        fontWeight="800"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        X
      </text>
    </svg>
  );
}
