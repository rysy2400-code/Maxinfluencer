"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

const AUTO_REFRESH_MS = 30_000;
const COLORS = {
  text: "#111827",
  secondary: "#4B5563",
  muted: "#6B7280",
  hint: "#9CA3AF",
  border: "#E5E7EB",
  surface: "#FFFFFF",
  surfaceMuted: "#F9FAFB",
  normal: "#047857",
  normalBg: "#ECFDF5",
  degraded: "#B45309",
  degradedBg: "#FFFBEB",
  fault: "#B91C1C",
  faultBg: "#FEF2F2",
  idle: "#4B5563",
  idleBg: "#F3F4F6",
  unknown: "#6B7280",
  unknownBg: "#F3F4F6",
  info: "#1D4ED8",
};

const PLATFORM_LABELS = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
const LEVEL_LABELS = { normal: "正常", degraded: "降级", fault: "故障", idle: "空闲", unknown: "未知" };
const REASON_LABELS = {
  HEALTH_MISSING: "健康数据缺失",
  HEARTBEAT_STALE: "心跳超时",
  WORKER_NOT_ALIVE: "Worker 未运行",
  WORKER_LOOP_STALLED: "Worker 循环停滞",
  CDP_RPC_UNAVAILABLE: "CDP RPC 不可用",
  PLATFORM_ROLE_DRIFT: "平台角色漂移",
  PROCESSING_TIMEOUT: "任务执行超时",
  QUEUE_NOT_CONSUMED: "队列未消费",
  QUEUE_CONSUMPTION_SLOW: "队列消费缓慢",
  CONSECUTIVE_FAILURES: "连续失败",
  EFFECTIVE_SUCCESS_RATE_CRITICAL: "有效成功率严重偏低",
  EFFECTIVE_SUCCESS_RATE_LOW: "有效成功率偏低",
  INVALID_SUCCEEDED: "存在无效成功",
};
const ACTIONS = [
  { key: "restart-worker", label: "重启 Worker" },
  { key: "restart-chrome", label: "重启 Chrome" },
  { key: "redeploy", label: "重新部署" },
];

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function shortSha(value) {
  return value ? String(value).slice(0, 8) : "未配置";
}

function rateText(value) {
  return value == null ? "-" : `${Math.round(Number(value) * 100)}%`;
}

function levelStyle(level) {
  const safe = LEVEL_LABELS[level] ? level : "unknown";
  return { color: COLORS[safe], background: COLORS[`${safe}Bg`] };
}

function StatusBadge({ level }) {
  const style = levelStyle(level);
  return (
    <span style={{ ...style, display: "inline-flex", padding: "3px 8px", borderRadius: 5, fontWeight: 700, fontSize: 12 }}>
      {LEVEL_LABELS[level] || LEVEL_LABELS.unknown}
    </span>
  );
}

function EndpointHealthList({ endpoints = [] }) {
  const items = Array.isArray(endpoints) ? endpoints : [];
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 5, display: "grid", gap: 3, minWidth: 150 }}>
      {items.slice(0, 5).map((item) => {
        const label = String(item.endpoint || "").replace(/^https?:\/\/127\.0\.0\.1:/, "");
        const ok = !!item.ok;
        return (
          <div key={item.endpoint || label} style={{ fontSize: 11, lineHeight: 1.35, color: ok ? COLORS.normal : COLORS.fault }}>
            <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{label || "-"}</span>
            <span> {ok ? "可用" : "异常"}</span>
            {item.publicIp ? <span style={{ color: COLORS.muted }}> · {item.publicIp}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function MetricWindow({ value }) {
  const metric = value || {};
  return (
    <div style={{ fontSize: 12, lineHeight: 1.55, whiteSpace: "nowrap" }}>
      <div style={{ color: COLORS.text, fontWeight: 650 }}>
        有效 {metric.effectiveSucceeded || 0} / 失败 {metric.failed || 0}
      </div>
      <div style={{ color: COLORS.secondary }}>
        成功率 {rateText(metric.effectiveSuccessRate)} · 抢占 {metric.claimed || 0}
      </div>
      {Number(metric.invalidSucceeded || 0) > 0 ? (
        <div style={{ color: COLORS.degraded }}>无效成功 {metric.invalidSucceeded}</div>
      ) : null}
    </div>
  );
}

function SummaryStrip({ summary = {}, queues = {} }) {
  const items = [
    ["正常", summary.normal || 0, COLORS.normal],
    ["降级", summary.degraded || 0, COLORS.degraded],
    ["故障", summary.fault || 0, COLORS.fault],
    ["空闲", summary.idle || 0, COLORS.idle],
    ["未知", summary.unknown || 0, COLORS.unknown],
  ];
  return (
    <section style={{ padding: "14px 0", borderBottom: `1px solid ${COLORS.border}`, display: "flex", gap: 26, alignItems: "center", flexWrap: "wrap" }}>
      {items.map(([label, count, color]) => (
        <div key={label} style={{ minWidth: 74 }}>
          <div style={{ fontSize: 11, color: COLORS.muted }}>{label}</div>
          <div style={{ fontSize: 22, lineHeight: 1.2, fontWeight: 750, color }}>{count}</div>
        </div>
      ))}
      <div style={{ width: 1, alignSelf: "stretch", background: COLORS.border }} />
      {Object.entries(PLATFORM_LABELS).map(([platform, label]) => (
        <div key={platform} style={{ minWidth: 145, fontSize: 12, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 700, color: COLORS.text }}>{label} 队列</div>
          <div style={{ color: COLORS.secondary }}>
            pending {queues?.[platform]?.pending || 0} · 最老 {formatTime(queues?.[platform]?.oldestPendingAt)}
          </div>
        </div>
      ))}
    </section>
  );
}

function ReleaseManager({ releases, onActivated }) {
  const activeByPlatform = useMemo(() => {
    const map = {};
    for (const release of releases || []) {
      if (release.status === "active" && !map[release.platform]) map[release.platform] = release;
    }
    return map;
  }, [releases]);
  const [editing, setEditing] = useState(null);
  const [sha, setSha] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function activate(platform) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/ops/crawler-releases", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, sha: sha.trim(), note: note.trim() }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
      setEditing(null);
      setSha("");
      setNote("");
      await onActivated();
    } catch (err) {
      setError(err.message || "设置失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ padding: "14px 0", borderBottom: `1px solid ${COLORS.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 14, color: COLORS.text }}>生产 Release</h2>
        <span style={{ fontSize: 11, color: COLORS.muted }}>重新部署仅使用这里激活的完整 SHA</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 10 }}>
        {Object.entries(PLATFORM_LABELS).map(([platform, label]) => {
          const release = activeByPlatform[platform];
          return (
            <div key={platform} style={{ borderLeft: `3px solid ${release ? COLORS.normal : COLORS.degraded}`, padding: "4px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{label}</strong>
                <button type="button" onClick={() => { setEditing(platform); setSha(""); setNote(""); setError(""); }} style={linkButtonStyle}>
                  设置
                </button>
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 12, color: release ? COLORS.text : COLORS.degraded }}>{release?.sha || "未配置"}</div>
              <div style={{ fontSize: 11, color: COLORS.muted }}>{release ? formatTime(release.releasedAt) : "重新部署已禁用"}</div>
            </div>
          );
        })}
      </div>
      {editing ? (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}`, display: "grid", gridTemplateColumns: "minmax(280px, 2fr) minmax(180px, 1fr) auto", gap: 8 }}>
          <input aria-label="完整 Git SHA" value={sha} onChange={(event) => setSha(event.target.value)} placeholder="40 位生产 Git SHA" style={inputStyle} />
          <input aria-label="发布说明" value={note} onChange={(event) => setNote(event.target.value)} placeholder="发布说明" style={inputStyle} />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" disabled={saving || !/^[0-9a-f]{40}$/i.test(sha.trim())} onClick={() => activate(editing)} style={primaryButtonStyle}>激活</button>
            <button type="button" disabled={saving} onClick={() => setEditing(null)} style={secondaryButtonStyle}>取消</button>
          </div>
        </div>
      ) : null}
      {error ? <div style={{ marginTop: 8, color: COLORS.fault, fontSize: 12 }}>{error}</div> : null}
    </section>
  );
}

function ActionDialog({ target, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  if (!target) return null;
  const actionLabel = ACTIONS.find((item) => item.key === target.action)?.label || target.action;
  const reasonInputId = "crawler-action-reason";

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/ops/crawler-machines/${target.machine.id}/actions/${target.action}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: target.machine.platform, reason: reason.trim() }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
      await onDone(data.action);
    } catch (err) {
      setError(err.message || "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlayStyle} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={actionLabel} style={dialogStyle}>
        <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>{actionLabel}</h2>
        <div style={{ color: COLORS.secondary, fontSize: 13, marginBottom: 12 }}>
          {target.machine.displayName || target.machine.ip} · {PLATFORM_LABELS[target.machine.platform]}
          {target.action === "redeploy" ? ` · ${shortSha(target.machine.activeRelease?.sha)}` : ""}
        </div>
        <label htmlFor={reasonInputId} style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 5 }}>操作原因</label>
        <textarea id={reasonInputId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={4} style={{ ...inputStyle, width: "100%", resize: "vertical" }} autoFocus />
        {error ? <div style={{ color: COLORS.fault, fontSize: 12, marginTop: 8 }}>{error}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" disabled={submitting} onClick={onClose} style={secondaryButtonStyle}>取消</button>
          <button type="button" disabled={submitting || reason.trim().length < 5} onClick={submit} style={{ ...primaryButtonStyle, background: target.action === "redeploy" ? COLORS.fault : COLORS.text }}>
            {submitting ? "执行中" : "确认执行"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ detail, loading, onClose }) {
  if (!detail && !loading) return null;
  const machine = detail?.machine;
  return (
    <div style={detailPanelStyle}>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>机器详情</h2>
          <div style={{ color: COLORS.muted, fontSize: 12 }}>{machine ? `${machine.ip} · ${PLATFORM_LABELS[machine.platform]}` : "加载中"}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭详情" title="关闭" style={{ ...secondaryButtonStyle, width: 34, padding: 0 }}>X</button>
      </div>
      <div style={{ padding: "16px 18px", overflowY: "auto", height: "calc(100vh - 72px)" }}>
        {loading ? <div style={{ color: COLORS.muted }}>加载中...</div> : null}
        {machine ? (
          <>
            <section style={detailSectionStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}><StatusBadge level={machine.operational.level} /><strong>{machine.operational.reasonCodes.map((code) => REASON_LABELS[code] || code).join("、") || "无异常"}</strong></div>
              <div style={{ marginTop: 8, fontSize: 12, color: COLORS.secondary, lineHeight: 1.6 }}>
                心跳 {formatTime(machine.health?.lastSeenAt)}<br />
                最后抢占 {formatTime(machine.operational.lastClaimAt)}<br />
                最后进度 {formatTime(machine.operational.lastProgressAt)}<br />
                最后成功 {formatTime(machine.operational.lastSuccessAt)}
              </div>
            </section>
            <section style={detailSectionStyle}>
              <h3 style={detailHeadingStyle}>近 1 小时错误聚合</h3>
              {detail.errorGroups?.length ? detail.errorGroups.map((row) => (
                <div key={`${row.reason}-${row.lastAt}`} style={{ padding: "7px 0", borderBottom: `1px solid ${COLORS.border}`, fontSize: 12 }}>
                  <strong style={{ color: COLORS.fault }}>{row.count}</strong> · {row.reason}
                  <div style={{ color: COLORS.muted }}>{formatTime(row.lastAt)}</div>
                </div>
              )) : <div style={{ color: COLORS.hint, fontSize: 12 }}>无错误</div>}
            </section>
            <section style={detailSectionStyle}>
              <h3 style={detailHeadingStyle}>最近任务</h3>
              {detail.recentTasks?.map((task) => (
                <div key={task.id} style={{ padding: "8px 0", borderBottom: `1px solid ${COLORS.border}`, fontSize: 12, lineHeight: 1.5 }}>
                  <div><strong style={{ color: task.status === "failed" ? COLORS.fault : task.status === "succeeded" ? COLORS.normal : COLORS.info }}>{task.status}</strong> · #{task.id} · {formatTime(task.finishedAt || task.startedAt)}</div>
                  <div style={{ color: COLORS.secondary, wordBreak: "break-word" }}>{task.keyword || "-"}</div>
                  <div style={{ color: COLORS.muted }}>搜索 {task.searchFoundCount} / 浏览 {task.profileBrowsedCount} / 分析 {task.analyzedCount}</div>
                </div>
              ))}
            </section>
            <section style={detailSectionStyle}>
              <h3 style={detailHeadingStyle}>运维操作</h3>
              {detail.actions?.length ? detail.actions.map((action) => (
                <div key={action.id} style={{ padding: "8px 0", borderBottom: `1px solid ${COLORS.border}`, fontSize: 12 }}>
                  <strong>{action.actionType}</strong> · {action.result} · {formatTime(action.startedAt)}
                  <div style={{ color: COLORS.secondary }}>{action.reason}</div>
                </div>
              )) : <div style={{ color: COLORS.hint, fontSize: 12 }}>无操作记录</div>}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function CrawlerOpsPage() {
  const [me, setMe] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [actionTarget, setActionTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const [snapshotResponse, releaseResponse] = await Promise.all([
        fetch("/api/ops/crawler-fleet-snapshot", { credentials: "include", cache: "no-store" }),
        fetch("/api/ops/crawler-releases", { credentials: "include", cache: "no-store" }),
      ]);
      const [snapshotData, releaseData] = await Promise.all([snapshotResponse.json(), releaseResponse.json()]);
      if (!snapshotResponse.ok || !snapshotData.success) throw new Error(snapshotData.error || "快照加载失败");
      if (!releaseResponse.ok || !releaseData.success) throw new Error(releaseData.error || "Release 加载失败");
      setSnapshot(snapshotData);
      setReleases(releaseData.releases || []);
    } catch (err) {
      setError(err.message || "加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (cancelled) return;
        if (!response.ok || !data.success || !data.user?.isAdmin) throw new Error("仅超级管理员可访问");
        setMe(data.user);
      })
      .catch((err) => { if (!cancelled) { setError(err.message || "认证失败"); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (me) load(); }, [me, load]);
  useEffect(() => {
    if (!me) return undefined;
    const timer = setInterval(() => load({ silent: true }), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [me, load]);

  const machines = useMemo(() => (snapshot?.machines || []).filter((machine) => {
    const level = machine.operational?.level || "unknown";
    return (statusFilter === "all" || level === statusFilter) && (platformFilter === "all" || machine.platform === platformFilter);
  }), [snapshot, statusFilter, platformFilter]);

  async function openDetail(machine) {
    if (!machine.id) return;
    setDetail(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/ops/crawler-machines/${machine.id}?platform=${encodeURIComponent(machine.platform)}`, { credentials: "include", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "详情加载失败");
      setDetail(data);
    } catch (err) {
      setError(err.message || "详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }

  if (!me && !loading) {
    return <main style={{ maxWidth: 720, margin: "0 auto", padding: 32 }}><h1>虚拟机运维台</h1><p style={{ color: COLORS.fault }}>{error || "无权限"}</p><Link href="/">返回 Campaign 工作台</Link></main>;
  }

  return (
    <main style={{ maxWidth: 1680, margin: "0 auto", padding: "20px", color: COLORS.text }}>
      <header style={{ paddingBottom: 14, borderBottom: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>虚拟机运维台</h1>
          <div style={{ color: COLORS.muted, fontSize: 12 }}>机器角色、真实执行健康、生产版本和运维操作</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: COLORS.muted, fontSize: 11 }}>{formatTime(snapshot?.snapshotAt)} · 30s 刷新</span>
          <button type="button" disabled={loading} onClick={() => load()} style={primaryButtonStyle}>{loading ? "加载中" : "刷新"}</button>
          <Link href="/" style={{ color: COLORS.info, fontSize: 12, textDecoration: "none" }}>返回工作台</Link>
        </div>
      </header>

      <nav style={{ display: "flex", gap: 18, borderBottom: `1px solid ${COLORS.border}` }}>
        <span style={{ padding: "11px 0 9px", borderBottom: `2px solid ${COLORS.text}`, fontSize: 12, fontWeight: 750 }}>虚拟机运维</span>
        <Link href="/ops/email" style={{ color: COLORS.info, padding: "11px 0", fontSize: 12, textDecoration: "none" }}>邮箱运维</Link>
        <Link href="/ops/business-profiles" style={{ color: COLORS.info, padding: "11px 0", fontSize: 12, textDecoration: "none" }}>红人合作漏斗</Link>
      </nav>

      {error ? <div style={{ margin: "12px 0", padding: "9px 11px", color: COLORS.fault, background: COLORS.faultBg, border: `1px solid #FECACA`, borderRadius: 5, fontSize: 12 }}>{error}</div> : null}
      {snapshot?.registryBacked === false ? <div style={{ margin: "12px 0", padding: "9px 11px", color: COLORS.degraded, background: COLORS.degradedBg, border: `1px solid #FDE68A`, borderRadius: 5, fontSize: 12 }}>机器注册表尚未迁移，当前为兼容只读模式，运维操作已禁用。</div> : null}

      <SummaryStrip summary={snapshot?.summary} queues={snapshot?.queues} />
      <ReleaseManager releases={releases} onActivated={() => load()} />

      <section style={{ padding: "14px 0 10px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>机器状态</strong>
        <select aria-label="状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={selectStyle}>
          <option value="all">全部状态</option>
          {Object.entries(LEVEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="平台筛选" value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value)} style={selectStyle}>
          <option value="all">全部平台</option>
          {Object.entries(PLATFORM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span style={{ fontSize: 11, color: COLORS.muted }}>{machines.length} 行</span>
      </section>

      <div className="ops-desktop-table" style={{ overflowX: "auto", border: `1px solid ${COLORS.border}`, borderRadius: 6, background: COLORS.surface }}>
        <table style={{ width: "100%", minWidth: 1380, borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ background: COLORS.surfaceMuted, color: COLORS.secondary, textAlign: "left" }}>
            {["机器", "角色", "综合状态", "基础设施", "近 10 分钟", "近 1 小时", "最后活动", "队列", "生产版本", "运维操作"].map((label) => <th key={label} style={thStyle}>{label}</th>)}
          </tr></thead>
          <tbody>
            {machines.map((machine) => {
              const operational = machine.operational || { level: "unknown", reasonCodes: [], tenMinutes: {}, oneHour: {} };
              const health = machine.health || {};
              return (
                <tr key={`${machine.id || machine.ip}:${machine.platform || "legacy"}`} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                  <td style={tdStyle}>
                    <button type="button" disabled={!machine.id} onClick={() => openDetail(machine)} style={{ ...linkButtonStyle, fontWeight: 750, fontSize: 12 }}>{machine.displayName || machine.ip}</button>
                    <div style={{ color: COLORS.muted, marginTop: 2 }}>{machine.ip}</div>
                    <div style={{ color: COLORS.hint }}>{machine.mode || "legacy"}</div>
                  </td>
                  <td style={tdStyle}><strong>{PLATFORM_LABELS[machine.platform] || "-"}</strong>{machine.isPrimary ? <div style={{ color: COLORS.muted }}>主角色</div> : null}</td>
                  <td style={tdStyle}>
                    <StatusBadge level={operational.level} />
                    <div style={{ marginTop: 6, maxWidth: 180, color: levelStyle(operational.level).color, lineHeight: 1.45 }}>{(operational.reasonCodes || []).slice(0, 2).map((code) => REASON_LABELS[code] || code).join("、") || "无异常"}</div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ color: health.workerAlive ? COLORS.normal : COLORS.fault }}>Worker {health.workerAlive ? "在线" : "异常"}</div>
                    <div style={{ color: health.cdpRpcOk ? COLORS.normal : health.cdpRpcOk === false ? COLORS.fault : COLORS.muted }}>CDP RPC {health.cdpRpcOk ? "正常" : health.cdpRpcOk === false ? "异常" : "未知"}</div>
                    {machine.platform === "tiktok" ? <EndpointHealthList endpoints={health.tiktokEndpointHealth} /> : null}
                    <div style={{ color: COLORS.muted }}>心跳 {formatTime(health.lastSeenAt)}</div>
                  </td>
                  <td style={tdStyle}><MetricWindow value={operational.tenMinutes} /></td>
                  <td style={tdStyle}><MetricWindow value={operational.oneHour} /></td>
                  <td style={tdStyle}>
                    <div>成功 {formatTime(operational.lastSuccessAt)}</div>
                    <div style={{ color: COLORS.muted }}>进度 {formatTime(operational.lastProgressAt)}</div>
                    <div style={{ color: COLORS.muted }}>抢占 {formatTime(operational.lastClaimAt)}</div>
                  </td>
                  <td style={tdStyle}><strong>{machine.queue?.pending || 0}</strong> pending<div style={{ color: COLORS.muted }}>最老 {formatTime(machine.queue?.oldestPendingAt)}</div></td>
                  <td style={tdStyle}><div style={{ fontFamily: "monospace" }}>{shortSha(machine.activeRelease?.sha)}</div><div style={{ color: health.reportedReleaseSha && machine.activeRelease?.sha && health.reportedReleaseSha !== machine.activeRelease.sha ? COLORS.degraded : COLORS.muted }}>实际 {shortSha(health.reportedReleaseSha)}</div></td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", maxWidth: 220 }}>
                      {ACTIONS.map((action) => <button key={action.key} type="button" disabled={!snapshot?.registryBacked || !machine.id || (action.key === "redeploy" && !machine.activeRelease?.sha)} onClick={() => setActionTarget({ machine, action: action.key })} style={actionButtonStyle}>{action.label}</button>)}
                    </div>
                    {machine.lastRepair ? <div style={{ marginTop: 6, color: COLORS.muted }}>{machine.lastRepair.actionType} · {machine.lastRepair.result}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && machines.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: COLORS.muted }}>没有符合筛选条件的机器</div> : null}
      </div>

      <div className="ops-mobile-list">
        {machines.map((machine) => {
          const operational = machine.operational || { level: "unknown", reasonCodes: [], tenMinutes: {}, oneHour: {} };
          return (
            <article key={`mobile-${machine.id || machine.ip}:${machine.platform || "legacy"}`} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 6, marginBottom: 10, background: COLORS.surface }}>
              <div style={{ padding: "10px 11px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                <div>
                  <button type="button" disabled={!machine.id} onClick={() => openDetail(machine)} style={{ ...linkButtonStyle, fontWeight: 750 }}>{machine.displayName || machine.ip}</button>
                  <div style={{ marginTop: 3, color: COLORS.secondary, fontSize: 12 }}>{PLATFORM_LABELS[machine.platform] || "-"} · {machine.mode || "legacy"}</div>
                </div>
                <StatusBadge level={operational.level} />
              </div>
              <div style={{ padding: "9px 11px", fontSize: 12 }}>
                <div style={{ color: levelStyle(operational.level).color, marginBottom: 8 }}>{(operational.reasonCodes || []).slice(0, 2).map((code) => REASON_LABELS[code] || code).join("、") || "无异常"}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div><strong>近 10 分钟</strong><MetricWindow value={operational.tenMinutes} /></div>
                  <div><strong>近 1 小时</strong><MetricWindow value={operational.oneHour} /></div>
                </div>
                <div style={{ marginTop: 9, paddingTop: 8, borderTop: `1px solid ${COLORS.border}`, color: COLORS.secondary, lineHeight: 1.55 }}>
                  CDP RPC {machine.health?.cdpRpcOk ? "正常" : machine.health?.cdpRpcOk === false ? "异常" : "未知"} · pending {machine.queue?.pending || 0}<br />
                  {machine.platform === "tiktok" ? <EndpointHealthList endpoints={machine.health?.tiktokEndpointHealth} /> : null}
                  最后成功 {formatTime(operational.lastSuccessAt)} · release {shortSha(machine.activeRelease?.sha)}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
                  {ACTIONS.map((action) => <button key={action.key} type="button" disabled={!snapshot?.registryBacked || !machine.id || (action.key === "redeploy" && !machine.activeRelease?.sha)} onClick={() => setActionTarget({ machine, action: action.key })} style={actionButtonStyle}>{action.label}</button>)}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <ActionDialog target={actionTarget} onClose={() => setActionTarget(null)} onDone={async () => { setActionTarget(null); await load(); }} />
      <DetailPanel detail={detail} loading={detailLoading} onClose={() => { setDetail(null); setDetailLoading(false); }} />
      <style jsx>{`
        .ops-mobile-list { display: none; }
        @media (max-width: 720px) {
          .ops-desktop-table { display: none; }
          .ops-mobile-list { display: block; }
        }
      `}</style>
    </main>
  );
}

const inputStyle = { boxSizing: "border-box", minHeight: 36, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "7px 9px", fontSize: 12, color: COLORS.text, background: COLORS.surface };
const selectStyle = { ...inputStyle, minHeight: 32, padding: "4px 28px 4px 8px" };
const primaryButtonStyle = { border: 0, borderRadius: 5, padding: "8px 12px", background: COLORS.text, color: "#FFFFFF", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const secondaryButtonStyle = { border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "7px 11px", background: COLORS.surface, color: COLORS.text, fontSize: 12, fontWeight: 650, cursor: "pointer" };
const linkButtonStyle = { border: 0, padding: 0, background: "transparent", color: COLORS.info, fontSize: 12, cursor: "pointer", textAlign: "left" };
const actionButtonStyle = { border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: "5px 7px", background: COLORS.surface, color: COLORS.text, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const thStyle = { padding: "9px 10px", fontWeight: 700, borderBottom: `1px solid ${COLORS.border}`, whiteSpace: "nowrap" };
const tdStyle = { padding: "10px", verticalAlign: "top", lineHeight: 1.5 };
const overlayStyle = { position: "fixed", inset: 0, zIndex: 80, background: "rgba(17,24,39,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 };
const dialogStyle = { width: "min(480px, 100%)", background: COLORS.surface, borderRadius: 7, border: `1px solid ${COLORS.border}`, padding: 18, boxShadow: "0 18px 48px rgba(0,0,0,0.18)" };
const detailPanelStyle = { position: "fixed", zIndex: 70, right: 0, top: 0, bottom: 0, width: "min(560px, 100vw)", background: COLORS.surface, borderLeft: `1px solid ${COLORS.border}`, boxShadow: "-12px 0 36px rgba(0,0,0,0.12)" };
const detailSectionStyle = { paddingBottom: 16, marginBottom: 16, borderBottom: `1px solid ${COLORS.border}` };
const detailHeadingStyle = { margin: "0 0 8px", fontSize: 13, color: COLORS.text };
