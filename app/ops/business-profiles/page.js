"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SafeMarkdown } from "../../components/SafeMarkdown.js";

const C = { text: "#111827", secondary: "#4B5563", muted: "#6B7280", border: "#E5E7EB", surface: "#FFFFFF", mutedBg: "#F9FAFB", blue: "#1D4ED8", green: "#047857", greenBg: "#ECFDF5", red: "#B91C1C", redBg: "#FEF2F2" };

function localDate(offsetDays = 0) {
  const now = new Date();
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  shanghai.setUTCDate(shanghai.getUTCDate() + offsetDays);
  return shanghai.toISOString().slice(0, 10);
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function formatRate(value) {
  return value == null ? "-" : `${(Number(value) * 100).toFixed(1)}%`;
}

function Metric({ label, value, rate, rateLabel }) {
  return <div style={metric}><div style={{ color: C.muted, fontSize: 12 }}>{label}</div><div style={{ color: C.text, fontSize: 26, lineHeight: 1.25, fontWeight: 750 }}>{value || 0}</div>{rateLabel ? <div style={{ color: C.secondary, fontSize: 11 }}>{rateLabel} {formatRate(rate)}</div> : <div style={{ height: 17 }} />}</div>;
}

function ProfileDetails({ item }) {
  return <details><summary style={{ color: C.blue, cursor: "pointer", fontWeight: 700, listStylePosition: "inside" }}>查看商务资料</summary><div style={{ width: "min(720px, 75vw)", maxHeight: 420, overflow: "auto", marginTop: 8, padding: "10px 12px", border: `1px solid ${C.border}`, background: C.mutedBg }}><SafeMarkdown>{item.businessProfileMarkdown}</SafeMarkdown></div><div style={{ marginTop: 5, color: C.muted, fontSize: 11 }}>更新于 {formatTime(item.businessProfileUpdatedAt)}</div></details>;
}

export default function BusinessProfilesOpsPage() {
  const [start, setStart] = useState(() => localDate(-29));
  const [end, setEnd] = useState(() => localDate());
  const [appliedRange, setAppliedRange] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (range = null) => {
    const next = range || appliedRange || { start, end };
    setLoading(true);
    try {
      const qs = new URLSearchParams(next);
      const response = await fetch(`/api/ops/business-profile-funnel?${qs}`, { credentials: "include", cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "红人合作漏斗加载失败");
      setData(body); setAppliedRange({ start: body.range.start, end: body.range.end }); setError("");
    } catch (err) { setError(err.message || "加载失败"); } finally { setLoading(false); }
  }, [appliedRange, start, end]);

  useEffect(() => { load({ start, end }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const influencers = useMemo(() => data?.influencers || [], [data]);
  const acquisition = data?.acquisition || {};
  const cooperation = data?.cooperation || {};

  function applyPreset(days) {
    const range = { start: localDate(-(days - 1)), end: localDate() };
    setStart(range.start); setEnd(range.end); load(range);
  }

  return <main style={{ maxWidth: 1680, margin: "0 auto", padding: 20, color: C.text }}>
    <header style={{ paddingBottom: 14, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div><h1 style={{ margin: "0 0 4px", fontSize: 22 }}>红人合作漏斗</h1><div style={{ color: C.muted, fontSize: 12 }}>新触达红人的商务资料沉淀与合作转化</div></div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><span style={{ color: C.muted, fontSize: 11 }}>更新于 {formatTime(data?.snapshotAt)} · 北京时间</span><button type="button" disabled={loading} onClick={() => load()} style={primaryButton}>{loading ? "加载中" : "刷新"}</button><Link href="/" style={link}>返回工作台</Link></div>
    </header>
    <nav style={{ display: "flex", gap: 18, borderBottom: `1px solid ${C.border}` }}><Link href="/ops" style={navLink}>虚拟机运维</Link><Link href="/ops/email" style={navLink}>邮箱运维</Link><span style={activeNav}>红人合作漏斗</span></nav>

    {error ? <div style={{ marginTop: 12, padding: 10, color: C.red, background: C.redBg, border: "1px solid #FECACA", borderRadius: 5 }}>{error}</div> : null}

    <section style={{ padding: "14px 0", display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${C.border}` }}>
      <label style={label}>首次触达开始<input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} style={input}/></label>
      <label style={label}>首次触达结束<input type="date" value={end} min={start} max={localDate()} onChange={(event) => setEnd(event.target.value)} style={input}/></label>
      <button type="button" disabled={loading || !start || !end || start > end} onClick={() => load({ start, end })} style={primaryButton}>查询</button>
      <button type="button" disabled={loading} onClick={() => applyPreset(30)} style={secondaryButton}>最近 30 天</button>
      <button type="button" disabled={loading} onClick={() => applyPreset(90)} style={secondaryButton}>最近 90 天</button>
      <span style={{ color: C.muted, fontSize: 11, marginLeft: 4 }}>仅包含历史首次成功发信日期落在区间内的红人，后续结果统计至当前</span>
    </section>

    <section style={section}><div style={sectionHeading}><h2 style={h2}>红人沉淀</h2><span style={sectionUnit}>单位：唯一红人数</span></div><div style={metricGrid}><Metric label="首次触达红人数" value={acquisition.touched}/><Metric label="回复红人数" value={acquisition.replied} rate={acquisition.replyRate} rateLabel="回复率"/><Metric label="有商务资料红人数" value={acquisition.profiles} rate={acquisition.profileRate} rateLabel="沉淀比例"/></div></section>

    <section style={section}><div style={sectionHeading}><h2 style={h2}>合作转化</h2><span style={sectionUnit}>单位：红人 × Campaign 机会数</span></div><div style={metricGrid}><Metric label="系统推荐机会数" value={cooperation.recommendations}/><Metric label="广告主同意机会数" value={cooperation.advertiserApproved} rate={cooperation.advertiserApprovalRate} rateLabel="广告主通过率"/><Metric label="红人确认合作机会数" value={cooperation.creatorConfirmed} rate={cooperation.creatorConfirmationRate} rateLabel="红人确认合作率"/></div></section>

    <section style={{ paddingTop: 16 }}><div style={sectionHeading}><h2 style={h2}>红人明细</h2><span style={sectionUnit}>{influencers.length} 位有商务资料的红人</span></div><div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 6, background: C.surface }}><table style={{ width: "100%", minWidth: 1120, borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ textAlign: "left", color: C.secondary, background: C.mutedBg }}>{["红人", "商务资料", "系统推荐", "广告主同意", "广告主通过率", "红人确认", "红人确认合作率"].map((text) => <th key={text} style={th}>{text}</th>)}</tr></thead><tbody>{influencers.map((item) => <tr key={item.influencerId} style={{ borderTop: `1px solid ${C.border}` }}><td style={td}><Link href={`/influencers/${encodeURIComponent(item.influencerId)}`} style={{ ...link, fontWeight: 750 }}>{item.displayName || item.username || item.influencerId}</Link>{item.username ? <div style={{ color: C.secondary }}>@{String(item.username).replace(/^@/, "")}</div> : null}<div style={{ color: C.muted, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{item.influencerId}</div></td><td style={{ ...td, minWidth: 210 }}><ProfileDetails item={item}/></td><td style={numberTd}>{item.recommendationCount}</td><td style={numberTd}>{item.advertiserApprovedCount}</td><td style={numberTd}>{formatRate(item.advertiserApprovalRate)}</td><td style={numberTd}>{item.creatorConfirmedCount}</td><td style={numberTd}>{formatRate(item.creatorConfirmationRate)}</td></tr>)}</tbody></table>{!loading && !influencers.length ? <div style={{ padding: 32, textAlign: "center", color: C.muted }}>该 Cohort 暂无已沉淀商务资料的红人</div> : null}</div></section>
  </main>;
}

const section = { padding: "16px 0", borderBottom: `1px solid ${C.border}` };
const sectionHeading = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 };
const sectionUnit = { color: C.muted, fontSize: 11 };
const h2 = { margin: 0, fontSize: 14 };
const metricGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 1, background: C.border, border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" };
const metric = { minHeight: 92, boxSizing: "border-box", padding: "13px 15px", background: C.surface };
const label = { display: "grid", gap: 4, color: C.secondary, fontSize: 11 };
const input = { minHeight: 34, boxSizing: "border-box", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, padding: "6px 9px", color: C.text, fontSize: 12 };
const primaryButton = { minHeight: 34, border: 0, borderRadius: 5, padding: "8px 12px", color: "#fff", background: C.text, fontSize: 12, fontWeight: 700, cursor: "pointer" };
const secondaryButton = { minHeight: 34, border: `1px solid ${C.border}`, borderRadius: 5, padding: "7px 10px", color: C.secondary, background: C.surface, fontSize: 12, fontWeight: 650, cursor: "pointer" };
const link = { color: C.blue, fontSize: 12, textDecoration: "none" };
const navLink = { ...link, padding: "11px 0" };
const activeNav = { padding: "11px 0 9px", borderBottom: `2px solid ${C.text}`, fontSize: 12, fontWeight: 750 };
const th = { padding: "9px 10px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
const td = { padding: 10, verticalAlign: "top", lineHeight: 1.5 };
const numberTd = { ...td, fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" };
