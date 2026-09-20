"use client";

import React from "react";

export function formatInfluencerLabel(inf) {
  const u = inf?.username && String(inf.username).trim().replace(/^@/, "");
  if (u) return `@${u}`;
  return inf?.displayName || inf?.influencerId || "—";
}

export function formatInfluencerInitials(inf) {
  const label = formatInfluencerLabel(inf);
  const source = label.startsWith("@") ? label.slice(1) : label;
  return (source || "?").slice(0, 2).toUpperCase();
}

/** 前端时间统一按北京时间展示（Asia/Shanghai），与访问者浏览器时区无关 */
const BEIJING_TIME_ZONE = "Asia/Shanghai";

export function formatTime(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("zh-CN", {
      timeZone: BEIJING_TIME_ZONE,
      hour12: false,
    });
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
