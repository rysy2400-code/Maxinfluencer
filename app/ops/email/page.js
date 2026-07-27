"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

const REFRESH_MS = 30_000;
const C = { text: "#111827", secondary: "#4B5563", muted: "#6B7280", border: "#E5E7EB", surface: "#FFFFFF", mutedBg: "#F9FAFB", blue: "#1D4ED8", green: "#047857", greenBg: "#ECFDF5", amber: "#B45309", amberBg: "#FFFBEB", red: "#B91C1C", redBg: "#FEF2F2" };

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function metricText(metric) {
  const denominator = Number(metric?.denominator || 0);
  const numerator = Number(metric?.numerator || 0);
  if (!denominator) return { rate: "-", count: "0 / 0" };
  return { rate: `${(Number(metric.rate || 0) * 100).toFixed(1)}%`, count: `${numerator} / ${denominator}` };
}

function MetricCell({ value }) {
  const text = metricText(value);
  return <div style={{ minWidth: 70 }}><strong style={{ color: C.text }}>{text.rate}</strong><div style={{ color: C.muted, fontSize: 11 }}>{text.count}</div></div>;
}

function sumMetric(items, key) {
  const denominator = items.reduce((sum, item) => sum + Number(item.metrics?.[key]?.denominator || 0), 0);
  const numerator = items.reduce((sum, item) => sum + Number(item.metrics?.[key]?.numerator || 0), 0);
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function domainSummary(domain) {
  const items = domain.mailboxes || [];
  return {
    metrics: Object.fromEntries(["hours24", "hours48", "hours72", "days30", "historical", "bounce"].map((key) => [key, sumMetric(items, key)])),
    unattributedReplies: items.reduce((sum, item) => sum + Number(item.unattributedReplies || 0), 0),
    poolCount: items.filter((item) => item.inOutreachPool).length,
  };
}

function Badge({ kind, children }) {
  const style = kind === "good" ? { color: C.green, background: C.greenBg } : kind === "bad" ? { color: C.red, background: C.redBg } : { color: C.amber, background: C.amberBg };
  return <span style={{ ...style, display: "inline-flex", borderRadius: 4, padding: "2px 6px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{children}</span>;
}

function MailboxDetail({ mailbox, onClose }) {
  if (!mailbox) return null;
  const rows = [["近 24 小时", "hours24"], ["近 48 小时", "hours48"], ["近 72 小时", "hours72"], ["近 30 天基线", "days30"], ["历史总计", "historical"], ["历史退信率", "bounce"]];
  return <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(17,24,39,.25)" }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "min(480px, 100vw)", background: C.surface, borderLeft: `1px solid ${C.border}`, padding: 20, boxSizing: "border-box", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><h2 style={{ margin: 0, fontSize: 18 }}>{mailbox.email}</h2><div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{mailbox.domain}</div></div><button type="button" onClick={onClose} aria-label="关闭" title="关闭" style={iconButton}>×</button></div>
      <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
        <Badge kind={mailbox.inOutreachPool ? "good" : "neutral"}>{mailbox.inOutreachPool ? "首邀池" : "非首邀池"}</Badge>
        <Badge kind={mailbox.smtpConfigured ? "good" : "bad"}>SMTP {mailbox.smtpConfigured ? "正常" : "未配置"}</Badge>
        <Badge kind={mailbox.imapConfigured ? "good" : "bad"}>IMAP {mailbox.imapConfigured ? "正常" : "未配置"}</Badge>
      </div>
      <div style={{ marginTop: 18, borderTop: `1px solid ${C.border}` }}>{rows.map(([label, key]) => <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ color: C.secondary, fontSize: 13 }}>{label}</span><MetricCell value={mailbox.metrics[key]} /></div>)}</div>
      <dl style={{ fontSize: 12, lineHeight: 1.8, marginTop: 16 }}><dt style={dt}>未归属回复</dt><dd style={dd}>{mailbox.unattributedReplies}（近 30 天 {mailbox.unattributedReplies30d}）</dd><dt style={dt}>最近首邀</dt><dd style={dd}>{formatTime(mailbox.lastSentAt)}</dd><dt style={dt}>最近已归属回复</dt><dd style={dd}>{formatTime(mailbox.lastReplyAt)}</dd><dt style={dt}>最近入站邮件</dt><dd style={dd}>{formatTime(mailbox.lastInboundAt)}</dd></dl>
    </aside>
  </div>;
}

export default function EmailOpsPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [pool, setPool] = useState("all");
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/ops/email-health", { credentials: "include", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "邮箱指标加载失败");
      setSnapshot(data); setError("");
    } catch (err) { setError(err.message || "加载失败"); } finally { if (!silent) setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = setInterval(() => load({ silent: true }), REFRESH_MS); return () => clearInterval(timer); }, [load]);

  const domains = useMemo(() => (snapshot?.domains || []).map((domain) => ({ ...domain, mailboxes: domain.mailboxes.filter((mailbox) => {
    const matchesQuery = !query.trim() || mailbox.email.includes(query.trim().toLowerCase()) || mailbox.domain.includes(query.trim().toLowerCase());
    const matchesPool = pool === "all" || (pool === "outreach" ? mailbox.inOutreachPool : !mailbox.inOutreachPool);
    return matchesQuery && matchesPool;
  }) })).filter((domain) => domain.mailboxes.length), [snapshot, query, pool]);

  function toggle(domain) { setExpanded((current) => { const next = new Set(current); if (next.has(domain)) next.delete(domain); else next.add(domain); return next; }); }

  return <main style={{ maxWidth: 1680, margin: "0 auto", padding: 20, color: C.text }}>
    <header style={{ paddingBottom: 14, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div><h1 style={{ margin: "0 0 4px", fontSize: 22 }}>邮箱运维台</h1><div style={{ color: C.muted, fontSize: 12 }}>首邀投递回复、退信和入站归因监控</div></div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><span style={{ color: C.muted, fontSize: 11 }}>{formatTime(snapshot?.snapshotAt)} · 北京时间 · 30s 刷新</span><button type="button" disabled={loading} onClick={() => load()} style={primaryButton}>{loading ? "加载中" : "刷新"}</button><Link href="/" style={link}>返回工作台</Link></div>
    </header>
    <nav style={{ display: "flex", gap: 18, borderBottom: `1px solid ${C.border}` }}><Link href="/ops" style={navLink}>虚拟机运维</Link><span style={activeNav}>邮箱运维</span><Link href="/ops/business-profiles" style={navLink}>红人合作漏斗</Link></nav>
    {error ? <div style={{ marginTop: 12, padding: 10, color: C.red, background: C.redBg, border: "1px solid #FECACA", borderRadius: 5 }}>{error}</div> : null}
    <section style={{ padding: "14px 0 10px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><input aria-label="搜索邮箱或域名" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱或域名" style={input}/><select aria-label="邮箱池筛选" value={pool} onChange={(event) => setPool(event.target.value)} style={input}><option value="all">全部邮箱</option><option value="outreach">首邀池</option><option value="other">非首邀池</option></select><button type="button" onClick={() => setExpanded(new Set(domains.map((item) => item.domain)))} style={secondaryButton}>全部展开</button><button type="button" onClick={() => setExpanded(new Set())} style={secondaryButton}>全部折叠</button><span style={{ color: C.muted, fontSize: 11 }}>{domains.reduce((sum, item) => sum + item.mailboxes.length, 0)} 个邮箱</span></section>
    <div style={{ overflowX: "auto", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6 }}><table style={{ width: "100%", minWidth: 1320, borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ textAlign: "left", color: C.secondary, background: C.mutedBg }}>{["域名 / 邮箱", "邮箱用途", "配置", "近 24h", "近 48h", "近 72h", "近 30 天基线", "历史总计", "退信率", "未归属回复", "最近入站"].map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead><tbody>
      {domains.map((domain) => { const summary = domainSummary(domain); const open = Boolean(query.trim()) || expanded.has(domain.domain); return [<tr key={domain.domain} style={{ borderTop: `1px solid ${C.border}`, background: C.mutedBg, cursor: "pointer" }} onClick={() => toggle(domain.domain)}><td style={td}><strong>{open ? "▾" : "▸"} {domain.domain}</strong><div style={{ color: C.muted }}>{domain.mailboxes.length} 个邮箱</div></td><td style={td}>{summary.poolCount} 个首邀池</td><td style={td}>-</td>{["hours24", "hours48", "hours72", "days30", "historical", "bounce"].map((key) => <td key={key} style={td}><MetricCell value={summary.metrics[key]}/></td>)}<td style={td}>{summary.unattributedReplies}</td><td style={td}>-</td></tr>, open && domain.mailboxes.map((mailbox) => <tr key={mailbox.email} style={{ borderTop: `1px solid ${C.border}` }}><td style={{ ...td, paddingLeft: 30 }}><button type="button" onClick={() => setSelected(mailbox)} style={mailButton}>{mailbox.email}</button></td><td style={td}><Badge kind={mailbox.inOutreachPool ? "good" : "neutral"}>{mailbox.inOutreachPool ? "首邀池" : "非首邀池"}</Badge></td><td style={td}><div style={{ color: mailbox.smtpConfigured ? C.green : C.red }}>SMTP {mailbox.smtpConfigured ? "正常" : "缺失"}</div><div style={{ color: mailbox.imapConfigured ? C.green : C.red }}>IMAP {mailbox.imapConfigured ? "正常" : "缺失"}</div></td>{["hours24", "hours48", "hours72", "days30", "historical", "bounce"].map((key) => <td key={key} style={td}><MetricCell value={mailbox.metrics[key]}/></td>)}<td style={td}><strong>{mailbox.unattributedReplies}</strong><div style={{ color: C.muted }}>30d {mailbox.unattributedReplies30d}</div></td><td style={td}>{formatTime(mailbox.lastInboundAt)}</td></tr>)]; })}
    </tbody></table>{!loading && !domains.length ? <div style={{ padding: 28, textAlign: "center", color: C.muted }}>没有符合条件的邮箱</div> : null}</div>
    <p style={{ color: C.muted, fontSize: 11, lineHeight: 1.6 }}>窗口指标按后端 UTC 滚动时间计算；自动回复和休假通知计为回复，仅退信被排除。未能可靠关联至 Campaign 首邀的来信不进入回复率。</p>
    <MailboxDetail mailbox={selected} onClose={() => setSelected(null)}/>
  </main>;
}

const th = { padding: "9px 10px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
const td = { padding: "10px", verticalAlign: "top", lineHeight: 1.5 };
const input = { minHeight: 34, boxSizing: "border-box", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, padding: "6px 9px", fontSize: 12 };
const primaryButton = { border: 0, borderRadius: 5, padding: "8px 12px", color: "#fff", background: C.text, fontSize: 12, fontWeight: 700 };
const secondaryButton = { border: `1px solid ${C.border}`, borderRadius: 5, padding: "7px 10px", color: C.secondary, background: C.surface, fontSize: 12, fontWeight: 650, cursor: "pointer" };
const iconButton = { width: 32, height: 32, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, fontSize: 22, lineHeight: 1 };
const mailButton = { border: 0, padding: 0, background: "transparent", color: C.blue, fontWeight: 700, cursor: "pointer" };
const link = { color: C.blue, fontSize: 12, textDecoration: "none" };
const navLink = { ...link, padding: "11px 0" };
const activeNav = { padding: "11px 0 9px", borderBottom: `2px solid ${C.text}`, fontSize: 12, fontWeight: 750 };
const dt = { color: C.muted, float: "left", clear: "left", width: 125 };
const dd = { marginLeft: 130, color: C.text };
