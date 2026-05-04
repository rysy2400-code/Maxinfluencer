import React from "react";

/** 聊天发送按钮：实心向上箭头（全站聊天框统一） */
export function ChatSendUpIcon({ size = 16, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <path d="M12 4L5 13h4.5v8h5v-8H19L12 4z" />
    </svg>
  );
}
