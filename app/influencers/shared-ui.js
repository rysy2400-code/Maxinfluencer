"use client";

import React from "react";

export function formatTime(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  } catch {
    return String(v);
  }
}

export function Pill({ children, tone = "neutral" }) {
  const bg =
    tone === "green"
      ? "#DCFCE7"
      : tone === "red"
        ? "#FEE2E2"
        : tone === "blue"
          ? "#DBEAFE"
          : "#E2E8F0";
  const fg =
    tone === "green"
      ? "#166534"
      : tone === "red"
        ? "#991B1B"
        : tone === "blue"
          ? "#1D4ED8"
          : "#0F172A";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
        border: "1px solid rgba(15, 23, 42, 0.06)",
        whiteSpace: "normal",
        maxWidth: "100%",
      }}
    >
      {children}
    </span>
  );
}
