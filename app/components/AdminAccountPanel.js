"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const inputStyle = {
  width: "100%", boxSizing: "border-box", height: 38, padding: "8px 10px",
  border: "1px solid #D1D5DB", borderRadius: 6, background: "#FFF", color: "#111827", fontSize: 13,
};
const labelStyle = { display: "block", fontSize: 12, color: "#4B5563", marginBottom: 5, fontWeight: 500 };
const primaryButton = {
  height: 38, border: "none", borderRadius: 6, padding: "0 16px", background: "#111827",
  color: "#FFF", fontSize: 13, fontWeight: 600, cursor: "pointer",
};

function Field({ label, children }) {
  return <label style={{ display: "block" }}><span style={labelStyle}>{label}</span>{children}</label>;
}

function Message({ value }) {
  if (!value?.text) return null;
  return <div style={{ padding: "9px 10px", borderRadius: 6, fontSize: 12, background: value.ok ? "#ECFDF5" : "#FEF2F2", color: value.ok ? "#047857" : "#B91C1C" }}>{value.text}</div>;
}

function money(value) {
  return `$${(Number(value) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function todayLocal() {
  const now = new Date();
  const shifted = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
}

export default function AdminAccountPanel({ open, initialTab = "create", onClose, onAccountCreated, onBalanceChanged }) {
  const [tab, setTab] = useState(initialTab);
  const [companies, setCompanies] = useState([]);
  const [companyQuery, setCompanyQuery] = useState("");
  const [companiesLoading, setCompaniesLoading] = useState(false);

  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  const loadCompanies = useCallback(async (q = "") => {
    setCompaniesLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (q.trim()) params.set("q", q.trim());
      const response = await fetch(`/api/ops/accounts?${params}`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || "公司加载失败");
      setCompanies(data.companies || []);
    } catch {
      setCompanies([]);
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void loadCompanies(companyQuery), companyQuery.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [open, companyQuery, loadCompanies]);

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 11000, background: "rgba(17,24,39,.36)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="超级管理员账户管理" onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(860px, 100%)", height: "min(680px, calc(100vh - 32px))", background: "#FFF", border: "1px solid #D1D5DB", borderRadius: 8, boxShadow: "0 20px 55px rgba(0,0,0,.2)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ height: 54, padding: "0 18px", borderBottom: "1px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 650, color: "#111827" }}>账户与资金管理</div>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose} style={{ width: 32, height: 32, border: "none", background: "transparent", color: "#6B7280", fontSize: 22, cursor: "pointer" }}>×</button>
        </div>
        <div role="tablist" style={{ display: "flex", gap: 4, padding: "10px 18px 0", borderBottom: "1px solid #E5E7EB", flexShrink: 0 }}>
          {[['create', '创建账户'], ['topup', '充值入账'], ['history', '充值历史']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} style={{ padding: "9px 12px", border: "none", borderBottom: tab === key ? "2px solid #111827" : "2px solid transparent", background: "transparent", color: tab === key ? "#111827" : "#6B7280", fontSize: 13, fontWeight: tab === key ? 600 : 500, cursor: "pointer" }}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 18 }}>
          {tab === "create" ? <CreateAccount onCreated={(account) => { onAccountCreated?.(account); void loadCompanies(); }} /> : null}
          {tab === "topup" ? <TopUp companies={companies} companyQuery={companyQuery} onCompanyQuery={setCompanyQuery} loading={companiesLoading} onCompleted={(result) => { onBalanceChanged?.(result); void loadCompanies(companyQuery); }} /> : null}
          {tab === "history" ? <TopUpHistory companies={companies} /> : null}
        </div>
      </div>
    </div>
  );
}

function CreateAccount({ onCreated }) {
  const [form, setForm] = useState({ companyName: "", username: "", password: "", role: "member" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const set = (key) => (event) => setForm((old) => ({ ...old, [key]: event.target.value }));
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/ops/accounts", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || "创建失败");
      setMessage({ ok: true, text: `${data.account.companyName} / ${data.account.username} 创建成功` });
      setForm({ companyName: "", username: "", password: "", role: "member" });
      onCreated?.(data.account);
    } catch (error) { setMessage({ ok: false, text: error.message }); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} style={{ maxWidth: 520, display: "grid", gap: 15 }}>
    <div><div style={{ fontSize: 15, fontWeight: 600, color: "#111827" }}>创建账户</div><div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>公司已存在时新增用户；新公司初始余额为 0 USD。</div></div>
    <Field label="公司名"><input style={inputStyle} value={form.companyName} onChange={set("companyName")} maxLength={255} required autoFocus /></Field>
    <Field label="用户名"><input style={inputStyle} value={form.username} onChange={set("username")} maxLength={64} required /></Field>
    <Field label="密码（6 位数字）"><input style={inputStyle} value={form.password} onChange={set("password")} inputMode="numeric" pattern="\d{6}" maxLength={6} type="password" required /></Field>
    <Field label="账户类型"><select style={inputStyle} value={form.role} onChange={set("role")}><option value="member">普通账户</option><option value="company_admin">公司管理员</option></select></Field>
    <Message value={message} />
    <div><button type="submit" disabled={busy} style={{ ...primaryButton, opacity: busy ? .55 : 1 }}>{busy ? "创建中..." : "创建账户"}</button></div>
  </form>;
}

function CompanySelect({ companies, query, onQuery, selectedId, onSelect, loading }) {
  return <div style={{ display: "grid", gap: 6 }}>
    <input style={inputStyle} type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="搜索公司" />
    <select style={inputStyle} value={selectedId} onChange={(e) => onSelect(e.target.value)} required>
      <option value="">{loading ? "加载中..." : "请选择公司"}</option>
      {companies.map((company) => <option key={company.advertiserId} value={company.advertiserId}>{company.companyName} · {money(company.balance)}</option>)}
    </select>
  </div>;
}

function TopUp({ companies, companyQuery, onCompanyQuery, loading, onCompleted }) {
  const [form, setForm] = useState({ advertiserId: "", amountUsd: "", receivedAt: todayLocal(), bankReference: "", noBankReference: false, note: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const selected = companies.find((c) => String(c.advertiserId) === String(form.advertiserId));
  const amount = /^\d+(?:\.\d{0,2})?$/.test(form.amountUsd) ? Number(form.amountUsd) : 0;
  const after = (selected?.balance || 0) + amount;
  const set = (key) => (event) => setForm((old) => ({ ...old, [key]: event.target.value }));
  async function submit(event) {
    event.preventDefault();
    const summary = `${selected?.companyName}\n当前余额：${money(selected?.balance)}\n本次充值：${money(amount)}\n入账后余额：${money(after)}`;
    if (!window.confirm(`确认充值入账？\n\n${summary}`)) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/ops/billing/top-up", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || "充值入账失败");
      setMessage({ ok: true, text: `入账成功，最新余额 ${money(data.topUp.balanceAfter)}，编号 ${data.topUp.bankReference}` });
      setForm((old) => ({ ...old, amountUsd: "", bankReference: "", noBankReference: false, note: "" }));
      onCompleted?.(data.topUp);
    } catch (error) { setMessage({ ok: false, text: error.message }); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} style={{ maxWidth: 620, display: "grid", gap: 14 }}>
    <div><div style={{ fontSize: 15, fontWeight: 600, color: "#111827" }}>充值入账</div><div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>仅支持 USD。提交后不可编辑或删除。</div></div>
    <Field label="公司"><CompanySelect companies={companies} query={companyQuery} onQuery={onCompanyQuery} selectedId={form.advertiserId} onSelect={(value) => setForm((old) => ({ ...old, advertiserId: value }))} loading={loading} /></Field>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
      <Field label="到账金额（USD）"><input style={inputStyle} value={form.amountUsd} onChange={set("amountUsd")} inputMode="decimal" placeholder="0.00" required /></Field>
      <Field label="到账日期"><input style={inputStyle} type="date" value={form.receivedAt} onChange={set("receivedAt")} required /></Field>
    </div>
    <Field label="银行流水号"><input style={{ ...inputStyle, background: form.noBankReference ? "#F3F4F6" : "#FFF" }} value={form.bankReference} onChange={set("bankReference")} disabled={form.noBankReference} maxLength={255} required={!form.noBankReference} /></Field>
    <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#374151", fontSize: 12 }}><input type="checkbox" checked={form.noBankReference} onChange={(e) => setForm((old) => ({ ...old, noBankReference: e.target.checked, bankReference: "" }))} />无银行流水号，由系统生成内部编号</label>
    <Field label="备注（选填）"><textarea style={{ ...inputStyle, height: 72, resize: "vertical" }} value={form.note} onChange={set("note")} maxLength={2000} /></Field>
    {selected ? <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: "1px solid #E5E7EB", borderRadius: 6, overflow: "hidden" }}>{[["当前余额", money(selected.balance)], ["本次充值", money(amount)], ["入账后余额", money(after)]].map(([label, value]) => <div key={label} style={{ padding: 10, borderRight: label === "入账后余额" ? "none" : "1px solid #E5E7EB" }}><div style={{ fontSize: 11, color: "#6B7280" }}>{label}</div><div style={{ fontSize: 14, color: "#111827", fontWeight: 600, marginTop: 3 }}>{value}</div></div>)}</div> : null}
    <Message value={message} />
    <div><button type="submit" disabled={busy || !selected} style={{ ...primaryButton, opacity: busy || !selected ? .55 : 1 }}>{busy ? "入账中..." : "确认充值入账"}</button></div>
  </form>;
}

function TopUpHistory({ companies }) {
  const [filters, setFilters] = useState({ advertiserId: "", from: "", to: "", reference: "" });
  const [result, setResult] = useState({ items: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const queryString = useMemo(() => { const p = new URLSearchParams({ page: String(result.page), pageSize: "20" }); Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); }); return p.toString(); }, [filters, result.page]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/ops/billing/top-ups?${queryString}`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || "查询失败");
      setResult((old) => ({ ...old, items: data.items || [], total: data.total || 0, pageSize: data.pageSize || 20 }));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [queryString]);
  useEffect(() => { void load(); }, [load]);
  const setFilter = (key) => (e) => { setFilters((old) => ({ ...old, [key]: e.target.value })); setResult((old) => ({ ...old, page: 1 })); };
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  return <div style={{ display: "grid", gap: 14 }}>
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.5fr", gap: 8 }}>
      <select style={inputStyle} value={filters.advertiserId} onChange={setFilter("advertiserId")}><option value="">全部公司</option>{companies.map((c) => <option key={c.advertiserId} value={c.advertiserId}>{c.companyName}</option>)}</select>
      <input aria-label="开始日期" title="开始日期" style={inputStyle} type="date" value={filters.from} onChange={setFilter("from")} />
      <input aria-label="结束日期" title="结束日期" style={inputStyle} type="date" value={filters.to} onChange={setFilter("to")} />
      <input aria-label="流水号" style={inputStyle} type="search" placeholder="搜索流水号" value={filters.reference} onChange={setFilter("reference")} />
    </div>
    {error ? <Message value={{ ok: false, text: error }} /> : null}
    <div style={{ border: "1px solid #E5E7EB", borderRadius: 6, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900, fontSize: 12 }}><thead><tr style={{ background: "#F9FAFB", color: "#4B5563", textAlign: "left" }}>{["到账日期", "公司", "金额", "充值前", "充值后", "流水号", "操作人", "备注"].map((h) => <th key={h} style={{ padding: "9px 10px", borderBottom: "1px solid #E5E7EB", fontWeight: 600 }}>{h}</th>)}</tr></thead>
      <tbody>{loading ? <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "#6B7280" }}>加载中...</td></tr> : result.items.length === 0 ? <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "#6B7280" }}>暂无充值记录</td></tr> : result.items.map((item) => <tr key={item.id} style={{ color: "#374151" }}><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6", whiteSpace: "nowrap" }}>{String(item.receivedAt).slice(0, 10)}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6" }}>{item.companyName}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6", fontWeight: 600 }}>{money(item.amountUsd)}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6" }}>{money(item.balanceBefore)}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6" }}>{money(item.balanceAfter)}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6" }}><div>{item.bankReference}</div>{item.referenceType === "internal" ? <div style={{ color: "#9CA3AF", fontSize: 10 }}>内部编号</div> : null}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6" }}>{item.createdByUsername}</td><td style={{ padding: 10, borderBottom: "1px solid #F3F4F6", maxWidth: 180 }}>{item.note || "—"}</td></tr>)}</tbody></table>
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "#6B7280", fontSize: 12 }}><span>共 {result.total} 条</span><div style={{ display: "flex", gap: 8, alignItems: "center" }}><button type="button" disabled={result.page <= 1} onClick={() => setResult((old) => ({ ...old, page: old.page - 1 }))}>上一页</button><span>{result.page} / {pages}</span><button type="button" disabled={result.page >= pages} onClick={() => setResult((old) => ({ ...old, page: old.page + 1 }))}>下一页</button></div></div>
  </div>;
}
