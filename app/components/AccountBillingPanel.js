"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

const TABS = [
  { id: "overview", label: "账户概览" },
  { id: "ledger", label: "账单明细" },
  { id: "invoices", label: "发票管理" },
];

function fmtUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(x);
}

function fmtDate(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(v);
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, { credentials: "include", cache: "no-store", ...options });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || !data.success) {
    throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

export default function AccountBillingPanel({ open, onClose }) {
  const [tab, setTab] = useState("overview");
  const [err, setErr] = useState("");
  const [accountCtx, setAccountCtx] = useState(null);
  const [summary, setSummary] = useState(null);
  const [issuer, setIssuer] = useState(null);
  const [ledger, setLedger] = useState({ items: [], total: 0, page: 1, pageSize: 20 });
  const [ledgerFrom, setLedgerFrom] = useState("");
  const [ledgerTo, setLedgerTo] = useState("");
  const loadSeqRef = useRef(0);
  const [profile, setProfile] = useState({
    companyLegalName: "",
    companyAddress: "",
    contactName: "",
    contactEmail: "",
    taxId: "",
    country: "",
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [notifyEmails, setNotifyEmails] = useState("");
  const [notifySaving, setNotifySaving] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [eligibleRecharge, setEligibleRecharge] = useState([]);
  const [eligibleConsumption, setEligibleConsumption] = useState([]);
  const [eligibleInfluencer, setEligibleInfluencer] = useState([]);
  const [requestType, setRequestType] = useState("recharge");
  const [selectedLedgerId, setSelectedLedgerId] = useState("");
  const [selectedInfluencerLedgerId, setSelectedInfluencerLedgerId] = useState("");
  const [selectedPeriodYyyymm, setSelectedPeriodYyyymm] = useState("");
  const [requestLoading, setRequestLoading] = useState(false);
  const [invoiceMsg, setInvoiceMsg] = useState("");

  const loadAccountCtx = useCallback(async () => {
    const data = await fetchJson("/api/auth/me");
    setAccountCtx(data.user || null);
  }, []);

  const loadSummary = useCallback(async (seq) => {
    const data = await fetchJson("/api/billing/summary");
    if (seq !== loadSeqRef.current) return;
    setSummary(data.summary || null);
    setIssuer(data.issuer || null);
  }, []);

  const loadLedger = useCallback(async (seq, from, to) => {
    const qs = new URLSearchParams({ page: "1", pageSize: "50" });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const data = await fetchJson(`/api/billing/ledger?${qs}`);
    if (seq !== loadSeqRef.current) return;
    setLedger({
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total) || 0,
      page: Number(data.page) || 1,
      pageSize: Number(data.pageSize) || 50,
    });
  }, []);

  const loadInvoicesTab = useCallback(async (seq) => {
    const [profileData, notifyData, invoicesData, eligibleData] = await Promise.all([
      fetchJson("/api/billing/profile"),
      fetchJson("/api/billing/notification-config"),
      fetchJson("/api/billing/invoices"),
      fetchJson("/api/billing/invoices/eligible"),
    ]);
    if (seq !== loadSeqRef.current) return;
    if (profileData.profile) {
      setProfile({
        companyLegalName: profileData.profile.companyLegalName || "",
        companyAddress: profileData.profile.companyAddress || "",
        contactName: profileData.profile.contactName || "",
        contactEmail: profileData.profile.contactEmail || "",
        taxId: profileData.profile.taxId || "",
        country: profileData.profile.country || "",
      });
    }
    const emails = notifyData.config?.financeNotifyEmails || [];
    setNotifyEmails(emails.join("\n"));
    setInvoices(Array.isArray(invoicesData.invoices) ? invoicesData.invoices : []);
    setEligibleRecharge(Array.isArray(eligibleData.rechargeOptions) ? eligibleData.rechargeOptions : []);
    setEligibleConsumption(
      Array.isArray(eligibleData.consumptionOptions) ? eligibleData.consumptionOptions : []
    );
    setEligibleInfluencer(
      Array.isArray(eligibleData.influencerOptions) ? eligibleData.influencerOptions : []
    );
    const recharge = Array.isArray(eligibleData.rechargeOptions) ? eligibleData.rechargeOptions : [];
    const consumption = Array.isArray(eligibleData.consumptionOptions)
      ? eligibleData.consumptionOptions
      : [];
    const influencer = Array.isArray(eligibleData.influencerOptions)
      ? eligibleData.influencerOptions
      : [];
    setSelectedLedgerId((prev) => prev || (recharge[0] ? String(recharge[0].ledgerId) : ""));
    setSelectedInfluencerLedgerId((prev) =>
      prev || (influencer[0] ? String(influencer[0].ledgerId) : "")
    );
    setSelectedPeriodYyyymm((prev) =>
      prev || (consumption[0] ? String(consumption[0].periodYyyymm) : "")
    );
  }, []);

  const runTabLoad = useCallback(
    async (activeTab, from, to) => {
      const seq = ++loadSeqRef.current;
      setErr("");
      try {
        await loadAccountCtx();
        if (activeTab === "overview") await loadSummary(seq);
        else if (activeTab === "ledger") await loadLedger(seq, from, to);
        else if (activeTab === "invoices") await loadInvoicesTab(seq);
      } catch (e) {
        if (seq === loadSeqRef.current) {
          setErr(e.message || "加载失败");
        }
      }
    },
    [loadAccountCtx, loadSummary, loadLedger, loadInvoicesTab]
  );

  useEffect(() => {
    if (!open) return;
    setLedgerFrom("");
    setLedgerTo("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void runTabLoad(tab, "", "");
  }, [open, tab, runTabLoad]);

  const handleExport = () => {
    const qs = new URLSearchParams();
    if (ledgerFrom) qs.set("from", ledgerFrom);
    if (ledgerTo) qs.set("to", ledgerTo);
    window.open(`/api/billing/ledger/export?${qs.toString()}`, "_blank", "noopener,noreferrer");
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/billing/profile", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "保存失败");
    } catch (e) {
      setErr(e.message || "保存失败");
    } finally {
      setProfileSaving(false);
    }
  };

  const saveNotify = async () => {
    setNotifySaving(true);
    setErr("");
    try {
      const emails = notifyEmails
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/billing/notification-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financeNotifyEmails: emails }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "保存失败");
      const saved = data.config?.financeNotifyEmails || emails;
      setNotifyEmails(saved.join("\n"));
    } catch (e) {
      setErr(e.message || "保存失败");
    } finally {
      setNotifySaving(false);
    }
  };

  const submitInvoiceRequest = async () => {
    setRequestLoading(true);
    setErr("");
    setInvoiceMsg("");
    try {
      const body =
        requestType === "recharge"
          ? { type: "recharge", ledgerId: Number(selectedLedgerId) }
          : requestType === "monthly_consumption"
            ? { type: "monthly_consumption", periodYyyymm: selectedPeriodYyyymm }
            : { type: "influencer_campaign", ledgerId: Number(selectedInfluencerLedgerId) };
      const res = await fetch("/api/billing/invoices/request", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "申请失败");
      setInvoiceMsg(data.message || "发票已生成");
      const seq = ++loadSeqRef.current;
      await loadInvoicesTab(seq);
    } catch (e) {
      setErr(e.message || "申请失败");
    } finally {
      setRequestLoading(false);
    }
  };

  if (!open) return null;

  const panelStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    background: "rgba(255,255,255,0.72)",
    backdropFilter: "blur(10px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
  };

  const cardStyle = {
    width: "100%",
    maxWidth: 920,
    height: "min(720px, 90vh)",
    background: "#FFF",
    color: "#111827",
    border: "1px solid #E5E7EB",
    borderRadius: 14,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 12px 40px rgba(15,23,42,0.1)",
  };

  const tableHeadCell = { padding: "8px 6px", color: "#6B7280" };
  const tableBodyCell = { padding: "8px 6px", color: "#111827" };
  const fieldStyle = {
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #E5E7EB",
    color: "#111827",
    background: "#FFF",
  };
  const sectionCard = {
    border: "1px solid #E5E7EB",
    borderRadius: 10,
    padding: 16,
  };
  const sectionTitle = { fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 10 };
  const sectionHint = { fontSize: 12, color: "#6B7280", margin: "0 0 12px" };
  const primaryBtn = {
    padding: "10px 14px",
    borderRadius: 8,
    border: "none",
    background: "#111827",
    color: "#FFF",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  };

  return (
    <div style={panelStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #E5E7EB",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: "#111827" }}>账户与账单</div>
            <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
              {accountCtx?.companyName || "—"} · {accountCtx?.username || "—"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "#F3F4F6",
              borderRadius: 8,
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            关闭
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "0 16px",
            borderBottom: "1px solid #F3F4F6",
            overflowX: "auto",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                border: "none",
                background: "transparent",
                padding: "12px 10px",
                fontSize: 13,
                fontWeight: tab === t.id ? 600 : 400,
                color: tab === t.id ? "#111827" : "#6B7280",
                borderBottom: tab === t.id ? "2px solid #111827" : "2px solid transparent",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ padding: 20, overflowY: "auto", flex: 1, minHeight: 0 }}>
          {err ? (
            <div
              style={{
                color: "#DC2626",
                fontSize: 13,
                marginBottom: 12,
                padding: "10px 12px",
                background: "#FEF2F2",
                borderRadius: 8,
                border: "1px solid #FECACA",
              }}
            >
              {err}
            </div>
          ) : null}

          {tab === "overview" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 12,
                }}
              >
                {[
                  ["当前余额", summary ? fmtUsd(summary.balance?.amount) : "—"],
                  ["累计充值", summary ? fmtUsd(summary.totalTopUp) : "—"],
                  ["累计消费", summary ? fmtUsd(summary.totalConsumption) : "—"],
                  ["红人合作费", summary ? fmtUsd(summary.totalInfluencerSpend) : "—"],
                  ["平台服务费", summary ? fmtUsd(summary.totalPlatformFee) : "—"],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    style={{
                      border: "1px solid #E5E7EB",
                      borderRadius: 10,
                      padding: "12px 14px",
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#6B7280" }}>{label}</div>
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 600,
                        marginTop: 4,
                        color: "#111827",
                      }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              {issuer ? (
                <div
                  style={{
                    border: "1px solid #E5E7EB",
                    borderRadius: 10,
                    padding: 14,
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "#374151",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>对公转账信息</div>
                  <div>Company Name: {issuer.companyName || issuer.legalName}</div>
                  <div>Product Name: {issuer.productName || issuer.productBrand}</div>
                  <div>Bank Name: {issuer.bankName}</div>
                  <div>Bank Address: {issuer.bankAddress}</div>
                  <div>Bank Account No.: {issuer.accountNo}</div>
                  <div>SWIFT Code: {issuer.swiftCode}</div>
                  <div style={{ marginTop: 10, color: "#6B7280", fontSize: 12 }}>
                    转账后请联系 Maxin AI 客户经理或等待财务入账确认。
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "ledger" ? (
            <div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                <input
                  type="date"
                  value={ledgerFrom}
                  onChange={(e) => setLedgerFrom(e.target.value)}
                  style={{ ...fieldStyle, padding: "6px 8px", borderRadius: 6 }}
                />
                <input
                  type="date"
                  value={ledgerTo}
                  onChange={(e) => setLedgerTo(e.target.value)}
                  style={{ ...fieldStyle, padding: "6px 8px", borderRadius: 6 }}
                />
                <button
                  type="button"
                  onClick={() => void runTabLoad("ledger", ledgerFrom, ledgerTo)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid #E5E7EB",
                    background: "#FFF",
                    color: "#111827",
                    cursor: "pointer",
                  }}
                >
                  筛选
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLedgerFrom("");
                    setLedgerTo("");
                    void runTabLoad("ledger", "", "");
                  }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid #E5E7EB",
                    background: "#FFF",
                    color: "#111827",
                    cursor: "pointer",
                  }}
                >
                  清除筛选
                </button>
                <button
                  type="button"
                  onClick={handleExport}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid #E5E7EB",
                    background: "#FFF",
                    color: "#111827",
                    cursor: "pointer",
                  }}
                >
                  导出 CSV
                </button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#111827" }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={tableHeadCell}>时间</th>
                      <th style={tableHeadCell}>类型</th>
                      <th style={tableHeadCell}>Campaign</th>
                      <th style={tableHeadCell}>红人</th>
                      <th style={tableHeadCell}>红人费</th>
                      <th style={tableHeadCell}>平台费</th>
                      <th style={tableHeadCell}>合计</th>
                      <th style={tableHeadCell}>余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(ledger.items || []).map((row) => {
                      const total =
                        row.type === "quote_approve"
                          ? Math.abs(row.influencerAmount) + Math.abs(row.platformFeeAmount)
                          : Math.abs(row.amount);
                      return (
                        <tr key={row.id} style={{ borderTop: "1px solid #F3F4F6" }}>
                          <td style={tableBodyCell}>{fmtDate(row.createdAt)}</td>
                          <td style={tableBodyCell}>{row.typeLabel || row.type}</td>
                          <td style={tableBodyCell}>{row.campaignName || "—"}</td>
                          <td style={tableBodyCell}>{row.influencerDisplayName || "—"}</td>
                          <td style={tableBodyCell}>
                            {row.type === "quote_approve" ? fmtUsd(Math.abs(row.influencerAmount)) : "—"}
                          </td>
                          <td style={tableBodyCell}>
                            {row.type === "quote_approve" ? fmtUsd(Math.abs(row.platformFeeAmount)) : "—"}
                          </td>
                          <td style={tableBodyCell}>
                            {row.type === "top_up" ? fmtUsd(row.amount) : fmtUsd(-total)}
                          </td>
                          <td style={tableBodyCell}>{fmtUsd(row.balanceAfter)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!ledger.items?.length ? (
                  <div style={{ padding: 16, color: "#9CA3AF", textAlign: "center" }}>
                    暂无账单记录
                    {ledgerFrom || ledgerTo ? "（可尝试「清除筛选」）" : ""}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "invoices" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <section style={sectionCard}>
                <div style={sectionTitle}>通知设置</div>
                <p style={sectionHint}>
                  发票 PDF 将发送至以下邮箱（每行一个，或逗号分隔）。申请开票前请先保存。
                </p>
                <textarea
                  value={notifyEmails}
                  onChange={(e) => setNotifyEmails(e.target.value)}
                  rows={4}
                  placeholder="finance@company.com"
                  style={{ ...fieldStyle, width: "100%", boxSizing: "border-box", fontSize: 13 }}
                />
                <button
                  type="button"
                  disabled={notifySaving}
                  onClick={() => void saveNotify()}
                  style={{
                    ...primaryBtn,
                    marginTop: 10,
                    cursor: notifySaving ? "wait" : "pointer",
                  }}
                >
                  {notifySaving ? "保存中…" : "保存通知邮箱"}
                </button>
              </section>

              <section style={sectionCard}>
                <div style={sectionTitle}>开票抬头</div>
                <p style={sectionHint}>
                  请填写与贵司财务一致的 Bill To 信息，用于 INVOICE PDF。
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520 }}>
                  {[
                    ["companyLegalName", "公司法定名称（英文）"],
                    ["companyAddress", "公司地址"],
                    ["contactName", "联系人"],
                    ["contactEmail", "联系邮箱"],
                    ["taxId", "税号 / VAT（选填）"],
                    ["country", "国家/地区（选填）"],
                  ].map(([key, label]) => (
                    <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                      <span style={{ color: "#374151" }}>{label}</span>
                      {key === "companyAddress" ? (
                        <textarea
                          value={profile[key]}
                          onChange={(e) => setProfile((p) => ({ ...p, [key]: e.target.value }))}
                          rows={3}
                          style={{ ...fieldStyle, width: "100%", boxSizing: "border-box" }}
                        />
                      ) : (
                        <input
                          value={profile[key]}
                          onChange={(e) => setProfile((p) => ({ ...p, [key]: e.target.value }))}
                          style={{ ...fieldStyle, width: "100%", boxSizing: "border-box" }}
                        />
                      )}
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={profileSaving}
                    onClick={() => void saveProfile()}
                    style={{
                      ...primaryBtn,
                      marginTop: 4,
                      cursor: profileSaving ? "wait" : "pointer",
                      alignSelf: "flex-start",
                    }}
                  >
                    {profileSaving ? "保存中…" : "保存开票抬头"}
                  </button>
                </div>
              </section>

              <section style={sectionCard}>
                <div style={sectionTitle}>申请发票</div>
                <p style={sectionHint}>
                  按需申请 INVOICE：充值按笔、消费按月或按红人合作。提交后生成 PDF 并发送至通知邮箱。
                </p>
                {invoiceMsg ? (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: "10px 12px",
                      background: "#ECFDF5",
                      border: "1px solid #A7F3D0",
                      borderRadius: 8,
                      fontSize: 13,
                      color: "#065F46",
                    }}
                  >
                    {invoiceMsg}
                  </div>
                ) : null}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input
                      type="radio"
                      name="invoiceType"
                      checked={requestType === "recharge"}
                      onChange={() => setRequestType("recharge")}
                    />
                    充值发票
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input
                      type="radio"
                      name="invoiceType"
                      checked={requestType === "monthly_consumption"}
                      onChange={() => setRequestType("monthly_consumption")}
                    />
                    消费发票（按月）
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input
                      type="radio"
                      name="invoiceType"
                      checked={requestType === "influencer_campaign"}
                      onChange={() => setRequestType("influencer_campaign")}
                    />
                    消费发票（按红人）
                  </label>
                </div>
                {requestType === "recharge" ? (
                  eligibleRecharge.length ? (
                    <select
                      value={selectedLedgerId}
                      onChange={(e) => setSelectedLedgerId(e.target.value)}
                      style={{ ...fieldStyle, minWidth: 280, marginBottom: 12 }}
                    >
                      {eligibleRecharge.map((opt) => (
                        <option key={opt.ledgerId} value={String(opt.ledgerId)}>
                          {fmtDate(opt.createdAt)} · {fmtUsd(opt.amountUsd)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 12 }}>
                      暂无可开票的充值记录
                    </div>
                  )
                ) : requestType === "monthly_consumption" ? (
                  eligibleConsumption.length ? (
                    <select
                      value={selectedPeriodYyyymm}
                      onChange={(e) => setSelectedPeriodYyyymm(e.target.value)}
                      style={{ ...fieldStyle, minWidth: 280, marginBottom: 12 }}
                    >
                      {eligibleConsumption.map((opt) => (
                        <option key={opt.periodYyyymm} value={opt.periodYyyymm}>
                          {opt.periodLabel} · {fmtUsd(opt.amountUsd)}（{opt.rowCount} 笔）
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 12 }}>
                      暂无可开票的消费月份
                    </div>
                  )
                ) : (
                  eligibleInfluencer.length ? (
                    <select
                      value={selectedInfluencerLedgerId}
                      onChange={(e) => setSelectedInfluencerLedgerId(e.target.value)}
                      style={{ ...fieldStyle, minWidth: 320, marginBottom: 12 }}
                    >
                      {eligibleInfluencer.map((opt) => (
                        <option key={opt.ledgerId} value={String(opt.ledgerId)}>
                          {opt.influencerName} · {opt.campaignName} · {fmtUsd(opt.amountUsd)} ·{" "}
                          {fmtDate(opt.createdAt)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 12 }}>
                      暂无可开票的红人合作记录
                    </div>
                  )
                )}
                <button
                  type="button"
                  disabled={
                    requestLoading ||
                    (requestType === "recharge"
                      ? !eligibleRecharge.length
                      : requestType === "monthly_consumption"
                        ? !eligibleConsumption.length
                        : !eligibleInfluencer.length)
                  }
                  onClick={() => void submitInvoiceRequest()}
                  style={{
                    ...primaryBtn,
                    cursor: requestLoading ? "wait" : "pointer",
                  }}
                >
                  {requestLoading ? "生成中…" : "提交申请"}
                </button>
              </section>

              <section style={sectionCard}>
                <div style={sectionTitle}>发票记录</div>
                {invoices.length === 0 ? (
                  <div style={{ color: "#6B7280", fontSize: 13 }}>
                    暂无发票。申请开票成功后将在此显示并可下载 PDF。
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#111827" }}>
                      <thead>
                        <tr style={{ textAlign: "left" }}>
                          <th style={tableHeadCell}>编号</th>
                          <th style={tableHeadCell}>类型</th>
                          <th style={tableHeadCell}>金额</th>
                          <th style={tableHeadCell}>开具时间</th>
                          <th style={tableHeadCell}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoices.map((inv) => (
                          <tr key={inv.id} style={{ borderTop: "1px solid #F3F4F6" }}>
                            <td style={tableBodyCell}>{inv.invoiceNo}</td>
                            <td style={tableBodyCell}>
                              {inv.typeLabel || inv.documentTitle || inv.invoiceType}
                              {inv.influencerName ? (
                                <div style={{ color: "#6B7280", marginTop: 2, fontWeight: 400 }}>
                                  {inv.influencerName}
                                  {inv.campaignName ? ` · ${inv.campaignName}` : ""}
                                </div>
                              ) : null}
                            </td>
                            <td style={tableBodyCell}>{fmtUsd(inv.amountUsd)}</td>
                            <td style={tableBodyCell}>{fmtDate(inv.issuedAt || inv.createdAt)}</td>
                            <td style={tableBodyCell}>
                              <a
                                href={`/api/billing/invoices/${inv.id}/pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: "#2563EB", textDecoration: "none" }}
                              >
                                下载 PDF
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
