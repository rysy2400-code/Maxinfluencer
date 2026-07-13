"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const AUTO_REFRESH_MS = 30_000;

const COLORS = {
  text: "#111827",
  textSecondary: "#374151",
  textMuted: "#6B7280",
  textHint: "#9CA3AF",
  border: "#E5E7EB",
  surface: "#FFFFFF",
  surfaceMuted: "#F9FAFB",
  link: "#3B82F6",
  success: "#047857",
  error: "#DC2626",
  warning: "#B45309",
  info: "#4F46E5",
};

const PLATFORM_LABELS = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

function formatLocalTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function statusColor(status) {
  if (status === "succeeded") return COLORS.success;
  if (status === "failed") return COLORS.error;
  return COLORS.textMuted;
}

function SearchTaskCell({ task }) {
  if (!task) {
    return <span style={{ color: COLORS.textHint, fontSize: 12 }}>无记录</span>;
  }

  const color = statusColor(task.status);
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, color }}>
        {task.status} · {formatLocalTime(task.finishedAt)}
      </div>
      <div style={{ color: COLORS.textSecondary }}>
        Campaign: {task.campaignId || "—"}
        {task.keyword ? ` · ${task.keyword}` : ""}
      </div>
      <div style={{ color: COLORS.textMuted }}>
        搜索 {task.progress.searchFoundCount} / 浏览 {task.progress.profileBrowsedCount} / 分析{" "}
        {task.progress.analyzedCount} / 推荐 {task.progress.recommendedCount}
      </div>
      {task.status === "failed" && task.errorMessage ? (
        <div
          style={{
            color: "#991B1B",
            marginTop: 4,
            wordBreak: "break-word",
            background: "#FEF2F2",
            border: "1px solid #FECACA",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {task.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function ImportTaskCell({ task }) {
  if (!task) {
    return <span style={{ color: COLORS.textHint, fontSize: 12 }}>无记录</span>;
  }

  const color = statusColor(task.status);
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, color }}>
        {task.status} · {formatLocalTime(task.finishedAt)}
      </div>
      <div style={{ color: COLORS.textSecondary }}>
        {task.sourceFileName || "—"} · {task.totalRows} 行
      </div>
      <div style={{ color: COLORS.textMuted }}>
        enrich {task.progress.enrichedCount} / analyze {task.progress.analyzedCount} / recommend{" "}
        {task.progress.recommendedCount}
      </div>
      {task.status === "failed" && task.errorMessage ? (
        <div
          style={{
            color: "#991B1B",
            marginTop: 4,
            wordBreak: "break-word",
            background: "#FEF2F2",
            border: "1px solid #FECACA",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {task.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function HealthCell({ health }) {
  const onlineColor = health.online ? COLORS.success : COLORS.error;
  const cdpColor = health.cdp9222Ok ? COLORS.success : COLORS.warning;

  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, color: onlineColor }}>
        {health.online ? "在线" : "离线"}
        {health.workerHost ? ` · ${health.workerHost}` : ""}
      </div>
      <div style={{ color: COLORS.textSecondary }}>
        CDP 9222: <span style={{ color: cdpColor }}>{health.cdp9222Ok ? "正常" : "异常"}</span>
        {health.cdp9222FailStreak > 0 ? ` (连续失败 ${health.cdp9222FailStreak})` : ""}
      </div>
      <div style={{ color: COLORS.textMuted }}>心跳: {formatLocalTime(health.lastSeenAt)}</div>
      {health.processingSearchTotal > 0 || health.processingImportTotal > 0 ? (
        <div style={{ color: COLORS.info }}>
          进行中: 搜索 {health.processingSearchTotal} / 导入 {health.processingImportTotal}
        </div>
      ) : null}
      {health.lastError ? (
        <div
          style={{
            color: COLORS.warning,
            marginTop: 4,
            wordBreak: "break-word",
            background: "#FFFBEB",
            border: "1px solid #FDE68A",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {health.lastError}
        </div>
      ) : null}
      {health.lastRepair ? (
        <div style={{ color: COLORS.textMuted, marginTop: 4 }}>
          最近修复: {health.lastRepair.actionType} ({health.lastRepair.result}) ·{" "}
          {formatLocalTime(health.lastRepair.startedAt)}
        </div>
      ) : null}
    </div>
  );
}

export default function CrawlerOpsPage() {
  const [me, setMe] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const loadSnapshot = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/ops/crawler-fleet-snapshot", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSnapshot(data);
    } catch (e) {
      setErr(e.message || "加载失败");
      if (!silent) setSnapshot(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

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
    loadSnapshot();
  }, [me, loadSnapshot]);

  useEffect(() => {
    if (!me) return undefined;
    const timer = setInterval(() => {
      loadSnapshot({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [me, loadSnapshot]);

  if (!me && err) {
    return (
      <div
        style={{
          padding: 32,
          maxWidth: 720,
          margin: "0 auto",
          background: COLORS.surface,
          minHeight: "100vh",
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 8, color: COLORS.text }}>虚拟机运维台</h1>
        <p style={{ color: COLORS.error }}>{err}</p>
        <p style={{ marginTop: 16, fontSize: 14 }}>
          <Link href="/" style={{ color: COLORS.link }}>
            返回 Campaign 工作台
          </Link>
        </p>
      </div>
    );
  }

  if (!me) {
    return (
      <div style={{ padding: 32, color: COLORS.textMuted, background: COLORS.surface, minHeight: "100vh" }}>
        验证权限中…
      </div>
    );
  }

  const machines = snapshot?.machines || [];
  const summary = snapshot?.summary;

  return (
    <div
      style={{
        padding: "24px 20px",
        maxWidth: 1600,
        margin: "0 auto",
        minHeight: "100vh",
      }}
    >
      <header
        style={{
          marginBottom: 20,
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: "16px 18px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px", color: COLORS.text }}>
              虚拟机运维台
            </h1>
            <p style={{ margin: 0, fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5 }}>
              14 台机器矩阵：健康状态 + 各平台最近完成搜索任务 + 最近导入任务（按 finished_at）。
            </p>
          </div>
          <Link
            href="/"
            style={{
              fontSize: 13,
              color: COLORS.link,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            ← Campaign 工作台
          </Link>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: COLORS.textHint }}>
          登录：{me.companyName} / {me.username}
          {summary ? (
            <span style={{ marginLeft: 12, color: COLORS.textMuted }}>
              在线 {summary.onlineCount} / 离线 {summary.offlineCount} / 共 {summary.machineCount} 台
            </span>
          ) : null}
          {snapshot?.snapshotAt ? (
            <span style={{ marginLeft: 12 }}>快照: {formatLocalTime(snapshot.snapshotAt)}</span>
          ) : null}
          <span style={{ marginLeft: 12 }}>每 30s 自动刷新</span>
        </p>
      </header>

      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 16,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => loadSnapshot()}
          disabled={loading}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: COLORS.text,
            color: "#FFFFFF",
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
            background: "#FEF2F2",
            border: "1px solid #FECACA",
            color: "#991B1B",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      ) : null}

      {loading && !machines.length ? (
        <div style={{ color: COLORS.textMuted, fontSize: 14 }}>加载机器矩阵…</div>
      ) : (
        <div
          style={{
            overflowX: "auto",
            borderRadius: 10,
            border: `1px solid ${COLORS.border}`,
            background: COLORS.surface,
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <table
            style={{
              width: "100%",
              minWidth: 1200,
              borderCollapse: "collapse",
              fontSize: 13,
              background: COLORS.surface,
            }}
          >
            <thead>
              <tr style={{ background: COLORS.surfaceMuted, color: COLORS.textMuted, textAlign: "left" }}>
                <th
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${COLORS.border}`,
                    width: 130,
                    fontWeight: 600,
                  }}
                >
                  机器 IP
                </th>
                <th
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${COLORS.border}`,
                    width: 200,
                    fontWeight: 600,
                  }}
                >
                  健康
                </th>
                {Object.entries(PLATFORM_LABELS).map(([slug, label]) => (
                  <th
                    key={slug}
                    style={{
                      padding: "10px 12px",
                      borderBottom: `1px solid ${COLORS.border}`,
                      minWidth: 220,
                      fontWeight: 600,
                    }}
                  >
                    {label} 搜索
                  </th>
                ))}
                <th
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${COLORS.border}`,
                    minWidth: 220,
                    fontWeight: 600,
                  }}
                >
                  导入任务
                </th>
              </tr>
            </thead>
            <tbody>
              {machines.map((machine, index) => (
                <tr
                  key={machine.ip}
                  style={{
                    borderBottom: `1px solid ${COLORS.border}`,
                    background: index % 2 === 0 ? COLORS.surface : COLORS.surfaceMuted,
                  }}
                >
                  <td
                    style={{
                      padding: "12px",
                      verticalAlign: "top",
                      fontWeight: 700,
                      color: COLORS.text,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {machine.ip}
                  </td>
                  <td style={{ padding: "12px", verticalAlign: "top" }}>
                    <HealthCell health={machine.health} />
                  </td>
                  {Object.keys(PLATFORM_LABELS).map((platform) => (
                    <td key={platform} style={{ padding: "12px", verticalAlign: "top" }}>
                      <SearchTaskCell task={machine.searchTasks?.[platform]} />
                    </td>
                  ))}
                  <td style={{ padding: "12px", verticalAlign: "top" }}>
                    <ImportTaskCell task={machine.importTask} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
