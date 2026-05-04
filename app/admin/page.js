"use client";

import React, { useEffect, useState } from "react";

export default function AdminSessionsPage() {
  const [me, setMe] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

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
        const sr = await fetch("/api/admin/sessions?limit=200", { credentials: "include" });
        const sd = await sr.json();
        if (!sr.ok || !sd.success) {
          if (!cancelled) setErr(sd.error || "加载失败");
          return;
        }
        if (!cancelled) setSessions(sd.sessions || []);
      } catch (e) {
        if (!cancelled) setErr(e.message || "错误");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: "#64748b" }}>加载中…</div>
    );
  }

  if (err && !me) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: "#b91c1c" }}>
        {err}
        <div style={{ marginTop: 12 }}>
          <a href="/" style={{ color: "#2563eb" }}>
            返回首页
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#f8fafc", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, color: "#0f172a", marginBottom: 8 }}>会话列表（管理员）</h1>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
        跨用户查看全部 Campaign 会话；普通用户请在首页侧栏只看自己的会话。
      </p>
      <div style={{ overflowX: "auto", background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f1f5f9", textAlign: "left" }}>
              <th style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>公司</th>
              <th style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>用户</th>
              <th style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>标题</th>
              <th style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>状态</th>
              <th style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", color: "#334155" }}>
                  {s.companyName || "—"}
                </td>
                <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", color: "#334155" }}>
                  {s.advertiserUsername || "—"}
                </td>
                <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", color: "#0f172a" }}>
                  {s.title || "—"}
                </td>
                <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>{s.status}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", color: "#64748b", fontSize: 12 }}>
                  {s.updatedAt ? new Date(s.updatedAt).toLocaleString("zh-CN") : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 ? (
          <div style={{ padding: 16, color: "#94a3b8", fontSize: 13 }}>暂无会话</div>
        ) : null}
      </div>
      <p style={{ marginTop: 16 }}>
        <a href="/" style={{ color: "#2563eb", fontSize: 13 }}>
          ← 返回首页
        </a>
      </p>
    </div>
  );
}
