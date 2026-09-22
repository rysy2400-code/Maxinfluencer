import React from "react";

/**
 * 视频附件图标：深色圆角方块 + 播放三角，与 PDF / Word 图标同尺寸。
 * @param {number} [size]
 */
export function ChatVideoFileIcon({ size = 36 }) {
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
      <rect x="2" y="2" width="32" height="32" rx="7" fill="#111827" />
      <rect
        x="7.5"
        y="10"
        width="21"
        height="16"
        rx="3"
        fill="#FFFFFF"
        fillOpacity="0.92"
      />
      <path d="M15.6 13.6v8.8l7.4-4.4-7.4-4.4Z" fill="#111827" />
    </svg>
  );
}
