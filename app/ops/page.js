"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";

function severityStyle(severity) {
  if (severity === "error") {
    return { bg: "#450a0a", border: "#b91c1c", text: "#fecaca" };
  }
  if (severity === "warn") {
    return { bg: "#422006", border: "#d97706", text: "#fde68a" };
  }
  return { bg: "#1e293b", border: "#475569", text: "#cbd5e1" };
}

export default function CrawlerOpsPage() {
  const [me, setMe] = useState(null);
  const [events, setEvents] = useState([]);
  const [warnErrorCount, setWarnErrorCount] = useState(0);
  const [campaignId, setCampaignId] = useState("");
  const [severity, setSeverity] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "100");
      if (campaignId.trim()) qs.set("campaignId", campaignId.trim());
      if (severity) qs.set("severity", severity);
      const res = await fetch(`/api/ops/crawler-self-heal-events?${qs.toString()}`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setEvents(Array.isArray(data.events) ? data.events : []);
      setWarnErrorCount(Number(data.warnErrorCount) || 0);
    } catch (e) {
      setErr(e.message || "加载失败");
      setEvents([]);
      setWarnErrorCount(0);
    } finally {
      setLoading(false);
    }
  }, [campaignId, severity]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mr = await fetch("/api/auth/me", { credentials: "include" });
        const md = await mr.json();
        if (!mr.ok || !md.success || !md.user?.isAdmin) {
          if (!cancelled) setErr("需要管理员账号登录");
          return;
        }
        if (!cancelled) setMe(md.user);
      } catch (e) {
        if (!cancelled) setErr(e.message || "认证失败");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!me) return;
    loadEvents();
  }, [me, loadEvents]);

  if (!me && err) {
    return (
      <div style={{ padding: 32, maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>爬虫运维台</h1>
        <p style={{ color: "#f87171" }}>{err}</p>
        <p style={{ marginTop: 16, fontSize: 14 }}>
          <Link href="/" style={{ color: "#38bdf8" }}>
            返回 Campaign 工作台
          </Link>
        </p>
      </div>
    );
  }

  if (!me) {
    return (
      <div style={{ padding: 32, color: "#94a3b8" }}>验证权限中…</div>
    );
  }

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px", color: "#f8fafc" }}>
              爬虫运维台
            </h1>
            <p style={{ margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>
              导航重试、超时、建议重启等自愈事件。与 Campaign「执行总览」分离，仅管理员可访问。
            </p>
          </div>
          <Link
            href="/"
            style={{
              fontSize: 13,
              color: "#38bdf8",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            ← Campaign 工作台
          </Link>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#64748b" }}>
          登录：{me.companyName} / {me.username}
          {warnErrorCount > 0 ? (
            <span style={{ marginLeft: 12, color: "#fbbf24" }}>
              当前列表 warn/error：{warnErrorCount}
            </span>
          ) : null}
        </p>
      </header>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 16,
          padding: 14,
          background: "#1e293b",
          borderRadius: 10,
          border: "1px solid #334155",
        }}
      >
        <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", flexDirection: "column", gap: 4 }}>
          Campaign ID
          <input
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            placeholder="可选，精确过滤"
            style={{
              width: 280,
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid #475569",
              background: "#0f172a",
              color: "#e2e8f0",
              fontSize: 13,
            }}
          />
        </label>
        <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", flexDirection: "column", gap: 4 }}>
          严重级别
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid #475569",
              background: "#0f172a",
              color: "#e2e8f0",
              fontSize: 13,
              minWidth: 120,
            }}
          >
            <option value="">全部</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
          </select>
        </label>
        <button
          type="button"
          onClick={loadEvents}
          disabled={loading}
          style={{
            alignSelf: "flex-end",
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            background: "#2563eb",
            color: "#fff",
            fontWeight: 600,
            fontSize: 13,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>

      {err ? (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            borderRadius: 8,
            background: "#450a0a",
            border: "1px solid #b91c1c",
            color: "#fecaca",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      ) : null}

      {loading && !events.length ? (
        <div style={{ color: "#94a3b8", fontSize: 14 }}>加载事件…</div>
      ) : events.length === 0 ? (
        <div style={{ color: "#94a3b8", fontSize: 14 }}>暂无自愈事件</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {events.map((ev) => {
            const s = severityStyle(ev.severity);
            return (
              <article
                key={ev.id}
                style={{
                  border: `1px solid ${s.border}`,
                  background: s.bg,
                  color: s.text,
                  borderRadius: 10,
                  padding: "12px 14px",
                  fontSize: 13,
                  lineHeight: 1.55,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  [{ev.severity || "info"}] {ev.eventType || "unknown"}
                  {ev.platform ? ` · ${ev.platform}` : ""}
                </div>
                {ev.reason ? <div>{ev.reason}</div> : null}
                <div style={{ marginTop: 6, fontSize: 11, color: "#94a3b8" }}>
                  {ev.campaignId ? `Campaign: ${ev.campaignId}` : "Campaign: —"}
                  {ev.workerHost || ev.workerIp
                    ? ` · Worker: ${ev.workerHost || "-"}${ev.workerIp ? ` (${ev.workerIp})` : ""}`
                    : ""}
                  {ev.taskId != null ? ` · task #${ev.taskId}` : ""}
                  {ev.runId ? ` · run ${ev.runId}` : ""}
                  {ev.createdAt
                    ? ` · ${new Date(ev.createdAt).toLocaleString("zh-CN")}`
                    : ""}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
