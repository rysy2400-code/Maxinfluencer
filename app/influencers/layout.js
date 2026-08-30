"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { InfluencerInboxProvider } from "./influencer-inbox-context";
import { formatTime, Pill } from "./shared-ui";
import { findSelectionPath, ProjectInboxList } from "./project-inbox-list";

const EXPAND_STORAGE_KEY = "maxinfluencer_inbox_expand_v1";

function useInfluencerIdFromPath() {
  const pathname = usePathname();
  return useMemo(() => {
    const prefix = "/influencers/";
    if (!pathname?.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    const seg = rest.split("/")[0];
    return seg ? decodeURIComponent(seg) : null;
  }, [pathname]);
}

function readExpandTouched() {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(EXPAND_STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function writeExpandTouched(obj) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function InfluencerInboxLoginScreen({ onSuccess }) {
  const [companyName, setCompanyName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/influencers/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: companyName.trim(),
          username: username.trim(),
          password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) {
        setErr(data.error || "登录失败");
        setBusy(false);
        return;
      }
      setPassword("");
      onSuccess(data.user);
    } catch (e2) {
      setErr(e2?.message || "网络错误");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#F3F4F6",
        padding: 24,
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 380,
          background: "#fff",
          borderRadius: 12,
          border: "1px solid #E5E7EB",
          padding: "28px 24px",
          boxShadow: "0 12px 40px rgba(15,23,42,0.08)",
        }}
      >
        <h1 style={{ margin: "0 0 8px", fontSize: 20, color: "#111827" }}>红人收件箱</h1>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6B7280", lineHeight: 1.5 }}>
          请使用管理员账号登录，查看全平台红人对话。
        </p>
        <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 6 }}>公司名</label>
        <input
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          required
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            marginBottom: 12,
            borderRadius: 8,
            border: "1px solid #D1D5DB",
            fontSize: 14,
          }}
        />
        <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 6 }}>用户名</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            marginBottom: 12,
            borderRadius: 8,
            border: "1px solid #D1D5DB",
            fontSize: 14,
          }}
        />
        <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 6 }}>密码（6 位数字）</label>
        <input
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value.replace(/\D/g, "").slice(0, 6))}
          required
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            marginBottom: 12,
            borderRadius: 8,
            border: "1px solid #D1D5DB",
            fontSize: 14,
          }}
        />
        {err ? (
          <div style={{ color: "#DC2626", fontSize: 13, marginBottom: 12 }}>{err}</div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          style={{
            width: "100%",
            padding: "11px 12px",
            borderRadius: 8,
            border: "none",
            background: "#111827",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

export default function InfluencersLayout({ children }) {
  const influencerId = useInfluencerIdFromPath();

  const [inboxAuthChecked, setInboxAuthChecked] = useState(false);
  const [inboxUser, setInboxUser] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/influencers/auth/me", { credentials: "include" });
        const d = await r.json().catch(() => ({}));
        if (!cancelled && d.success && d.user) setInboxUser(d.user);
      } catch {
        /* ignore */
      }
      if (!cancelled) setInboxAuthChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [listView, setListView] = useState("time");
  const [listQ, setListQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  const [conversations, setConversations] = useState([]);
  const [listCursor, setListCursor] = useState(null);
  const [listHasMore, setListHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);

  const [queueItems, setQueueItems] = useState([]);
  const [queueCount, setQueueCount] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [claimInput, setClaimInput] = useState({});

  const [projectData, setProjectData] = useState({
    accounts: [],
    orphans: [],
    accountNextCursor: null,
    hasMoreAccounts: false,
  });
  const [campaignInfluencers, setCampaignInfluencers] = useState({});
  const [listLoadingProject, setListLoadingProject] = useState(false);
  const [listErrorProject, setListErrorProject] = useState(null);
  const [expandTouched, setExpandTouched] = useState({});

  const listScrollRef = useRef(null);
  const pendingScrollListToTopAfterSendRef = useRef(false);
  const pendingScrollProjectAfterSendRef = useRef(false);
  const timeListReqId = useRef(0);
  const projectListReqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(listQ.trim()), 300);
    return () => clearTimeout(t);
  }, [listQ]);

  useEffect(() => {
    if (listView !== "project") return;
    setExpandTouched(readExpandTouched());
  }, [listView]);

  const loadConversations = useCallback(
    async ({ cursor, reset }) => {
      const reqId = ++timeListReqId.current;
      setListLoading(true);
      setListError(null);
      try {
        const qs = new URLSearchParams();
        qs.set("limit", "40");
        if (debouncedQ) qs.set("q", debouncedQ);
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/influencers/conversations?` + qs.toString(), {
          cache: "no-store",
        });
        const data = await res.json();
        if (reqId !== timeListReqId.current) return;
        if (!data?.success) throw new Error(data?.error || "加载失败");
        const items = data.items || [];
        setListHasMore(!!data.hasMore);
        setListCursor(data.nextCursor || null);
        setConversations((prev) => (reset ? items : [...prev, ...items]));
      } catch (e) {
        if (reqId !== timeListReqId.current) return;
        setListError(e?.message || String(e));
      } finally {
        if (reqId === timeListReqId.current) setListLoading(false);
      }
    },
    [debouncedQ]
  );

  const loadAttributionQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const res = await fetch(`/api/influencers/email-attribution-queue?limit=50`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || "加载失败");
      setQueueItems(data.items || []);
      setQueueCount(Number(data.count) || 0);
    } catch (e) {
      console.error("[未归属邮件队列] 加载失败:", e?.message || e);
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const loadProjectTree = useCallback(
    async ({ accountCursor, reset }) => {
      const reqId = ++projectListReqId.current;
      setListLoadingProject(true);
      setListErrorProject(null);
      try {
        const qs = new URLSearchParams();
        qs.set("accountLimit", "50");
        if (debouncedQ) qs.set("q", debouncedQ);
        if (accountCursor) qs.set("accountCursor", accountCursor);
        const res = await fetch(`/api/influencers/conversations/by-project?` + qs.toString(), {
          cache: "no-store",
        });
        const data = await res.json();
        if (reqId !== projectListReqId.current) return;
        if (!data?.success) throw new Error(data?.error || "加载失败");
        if (reset) setCampaignInfluencers({});
        const accounts = data.accounts || [];
        const orphans = data.orphans || [];
        setProjectData((prev) => {
          if (reset) {
            return {
              accounts,
              orphans,
              accountNextCursor: data.accountNextCursor || null,
              hasMoreAccounts: !!data.hasMoreAccounts,
            };
          }
          const mergedAccounts = [...prev.accounts];
          const seen = new Set(mergedAccounts.map((a) => String(a.advertiserUserId)));
          for (const a of accounts) {
            const k = String(a.advertiserUserId);
            if (!seen.has(k)) {
              seen.add(k);
              mergedAccounts.push(a);
            }
          }
          return {
            accounts: mergedAccounts,
            orphans: reset ? orphans : prev.orphans,
            accountNextCursor: data.accountNextCursor || null,
            hasMoreAccounts: !!data.hasMoreAccounts,
          };
        });
      } catch (e) {
        if (reqId !== projectListReqId.current) return;
        setListErrorProject(e?.message || String(e));
      } finally {
        if (reqId === projectListReqId.current) setListLoadingProject(false);
      }
    },
    [debouncedQ]
  );

  const loadCampaignInfluencers = useCallback(
    async (campaignId, advertiserUserId) => {
      setCampaignInfluencers((prev) => {
        const cur = prev[campaignId];
        if (cur && (cur.loading || (cur.items && cur.q === debouncedQ))) return prev;
        return { ...prev, [campaignId]: { loading: true, q: debouncedQ } };
      });
      try {
        const qs = new URLSearchParams();
        qs.set("advertiserUserId", advertiserUserId);
        qs.set("campaignId", campaignId);
        if (debouncedQ) qs.set("q", debouncedQ);
        const res = await fetch(
          `/api/influencers/conversations/by-project/campaign?` + qs.toString(),
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!data?.success) throw new Error(data?.error || "加载失败");
        setCampaignInfluencers((prev) => ({
          ...prev,
          [campaignId]: { items: data.influencers || [], loading: false, q: debouncedQ },
        }));
      } catch (e) {
        console.error("[Campaign Influencers] 加载失败:", e?.message || e);
        setCampaignInfluencers((prev) => ({
          ...prev,
          [campaignId]: { items: [], loading: false, q: debouncedQ, error: e?.message || String(e) },
        }));
      }
    },
    [debouncedQ]
  );

  useEffect(() => {
    if (listView !== "time") return;
    loadConversations({ cursor: null, reset: true });
  }, [debouncedQ, listView, loadConversations]);

  useEffect(() => {
    if (!inboxUser || listView !== "time") return;
    loadAttributionQueue();
  }, [inboxUser, listView, loadAttributionQueue]);

  useEffect(() => {
    if (listView !== "project") return;
    loadProjectTree({ accountCursor: null, reset: true });
  }, [debouncedQ, listView, loadProjectTree]);

  /** 展开状态默认打开（或当前红人所在）的 campaign，自动懒加载其红人列表 */
  useEffect(() => {
    if (listView !== "project") return;
    for (const acc of projectData.accounts || []) {
      for (const st of ["running", "paused", "completed"]) {
        for (const camp of acc[st]?.campaigns || []) {
          const k = `camp:${camp.campaignId}`;
          const onPath =
            selectionPath &&
            selectionPath.type === "campaign" &&
            selectionPath.campaignId === camp.campaignId;
          const open =
            Object.prototype.hasOwnProperty.call(expandTouched, k)
              ? expandTouched[k] === true
              : !!onPath;
          if (!open) continue;
          const cur = campaignInfluencers[camp.campaignId];
          if (cur && (cur.loading || (cur.items && cur.q === debouncedQ))) continue;
          loadCampaignInfluencers(camp.campaignId, acc.advertiserUserId);
        }
      }
    }
  }, [
    listView,
    projectData.accounts,
    selectionPath,
    expandTouched,
    campaignInfluencers,
    loadCampaignInfluencers,
    debouncedQ,
  ]);

  useLayoutEffect(() => {
    if (listView !== "time") return;
    if (listLoading) return;
    if (!pendingScrollListToTopAfterSendRef.current) return;
    pendingScrollListToTopAfterSendRef.current = false;
    const el = listScrollRef.current;
    if (el) el.scrollTop = 0;
  }, [listView, listLoading, conversations]);

  useLayoutEffect(() => {
    if (listView !== "project") return;
    if (listLoadingProject) return;
    if (!pendingScrollProjectAfterSendRef.current) return;
    pendingScrollProjectAfterSendRef.current = false;
    const root = listScrollRef.current;
    if (!root) return;
    const anchor = root.querySelector('[data-send-scroll="1"]');
    anchor?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [
    listView,
    listLoadingProject,
    projectData.accounts,
    projectData.orphans,
    campaignInfluencers,
    influencerId,
  ]);

  const refreshConversations = useCallback(
    async (opts = {}) => {
      if (listView === "project") {
        if (opts.afterSend) pendingScrollProjectAfterSendRef.current = true;
        await loadProjectTree({ accountCursor: null, reset: true });
      } else {
        if (opts.afterSend) pendingScrollListToTopAfterSendRef.current = true;
        await loadConversations({ cursor: null, reset: true });
        await loadAttributionQueue();
      }
    },
    [listView, loadConversations, loadProjectTree, loadAttributionQueue]
  );

  const submitQueueAction = async (item, action) => {
    try {
      const payload =
        action === "claim"
          ? { action: "claim", influencerId: (claimInput[item.id] || "").trim() }
          : { action: "ignore" };
      if (action === "claim" && !payload.influencerId) return;
      const res = await fetch(
        `/api/influencers/email-attribution-queue/${item.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!data?.success) {
        alert(data?.error || "操作失败");
        return;
      }
      setClaimInput((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      await loadAttributionQueue();
      await loadConversations({ cursor: null, reset: true });
    } catch (e) {
      alert(e?.message || String(e));
    }
  };

  const inboxValue = useMemo(() => ({ refreshConversations }), [refreshConversations]);

  const selectionPath = useMemo(
    () =>
      findSelectionPath(
        projectData.accounts,
        projectData.orphans,
        influencerId,
        campaignInfluencers
      ),
    [projectData.accounts, projectData.orphans, influencerId, campaignInfluencers]
  );

  const accountPref = useMemo(() => {
    const out = {};
    for (const acc of projectData.accounts || []) {
      const k = `acc:${acc.advertiserUserId}`;
      const def =
        selectionPath &&
        selectionPath.type === "campaign" &&
        selectionPath.advertiserUserId === acc.advertiserUserId;
      out[k] = expandTouched[k] !== undefined ? !!expandTouched[k] : !!def;
    }
    return out;
  }, [projectData.accounts, selectionPath, expandTouched]);

  const campPref = useMemo(() => {
    const out = {};
    for (const acc of projectData.accounts || []) {
      for (const st of ["running", "paused", "completed"]) {
        for (const camp of acc[st]?.campaigns || []) {
          const k = `camp:${camp.campaignId}`;
          const def =
            selectionPath &&
            selectionPath.type === "campaign" &&
            selectionPath.campaignId === camp.campaignId;
          out[k] = expandTouched[k] !== undefined ? !!expandTouched[k] : !!def;
        }
      }
    }
    return out;
  }, [projectData.accounts, selectionPath, expandTouched]);

  const patchExpandTouched = useCallback((key, value) => {
    setExpandTouched((prev) => {
      const next = { ...prev, [key]: value };
      writeExpandTouched(next);
      return next;
    });
  }, []);

  const onToggleAccount = useCallback(
    (advertiserUserId, nextOpen) => {
      patchExpandTouched(`acc:${advertiserUserId}`, nextOpen);
    },
    [patchExpandTouched]
  );

  const onToggleCampaign = useCallback(
    (campaignId, nextOpen, advertiserUserId) => {
      patchExpandTouched(`camp:${campaignId}`, nextOpen);
      if (nextOpen && advertiserUserId != null) {
        loadCampaignInfluencers(campaignId, advertiserUserId);
      }
    },
    [patchExpandTouched, loadCampaignInfluencers]
  );

  const shellStyle = {
    height: "100vh",
    maxHeight: "100dvh",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    background: "#EDEDED",
    color: "#111",
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
    boxSizing: "border-box",
  };

  const searchPlaceholder =
    listView === "project"
      ? "搜索红人 / 品牌 / 产品 / 公司 / 账户名"
      : "搜索 id / 用户名 / 昵称 / 邮箱";

  if (!inboxAuthChecked) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6B7280",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        加载中…
      </div>
    );
  }

  if (!inboxUser) {
    return <InfluencerInboxLoginScreen onSuccess={setInboxUser} />;
  }

  return (
    <InfluencerInboxProvider value={inboxValue}>
      <div style={shellStyle}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "320px 1fr",
            gap: 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "#F3F3F3",
              borderRight: "1px solid rgba(0,0,0,0.08)",
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                flexShrink: 0,
                padding: 10,
                borderBottom: "1px solid rgba(0,0,0,0.06)",
                boxSizing: "border-box",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>红人收件箱</div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await fetch("/api/influencers/auth/logout", {
                        method: "POST",
                        credentials: "include",
                      });
                    } catch {
                      /* ignore */
                    }
                    setInboxUser(null);
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#6B7280",
                    fontSize: 11,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  退出
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                <button
                  type="button"
                  onClick={() => setListView("time")}
                  style={{
                    flex: 1,
                    padding: "6px 4px",
                    borderRadius: 6,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: listView === "time" ? "#333" : "#fff",
                    color: listView === "time" ? "#fff" : "#111",
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  按时间
                </button>
                <button
                  type="button"
                  onClick={() => setListView("project")}
                  style={{
                    flex: 1,
                    padding: "6px 4px",
                    borderRadius: 6,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: listView === "project" ? "#333" : "#fff",
                    color: listView === "project" ? "#fff" : "#111",
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  按项目
                </button>
              </div>
              <input
                value={listQ}
                onChange={(e) => setListQ(e.target.value)}
                placeholder={searchPlaceholder}
                style={{
                  display: "block",
                  width: "100%",
                  maxWidth: "100%",
                  boxSizing: "border-box",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid rgba(0,0,0,0.12)",
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (listView === "time") loadConversations({ cursor: null, reset: true });
                  else loadProjectTree({ accountCursor: null, reset: true });
                }}
                disabled={listView === "time" ? listLoading : listLoadingProject}
                style={{
                  marginTop: 8,
                  width: "100%",
                  padding: "6px",
                  borderRadius: 6,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "#fff",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                刷新列表
              </button>
            </div>

            {listView === "time" && listError ? (
              <div
                style={{
                  flexShrink: 0,
                  padding: "0 10px 8px",
                  color: "#B91C1C",
                  fontSize: 13,
                }}
              >
                {listError}
              </div>
            ) : null}
            {listView === "project" && listErrorProject ? (
              <div
                style={{
                  flexShrink: 0,
                  padding: "0 10px 8px",
                  color: "#B91C1C",
                  fontSize: 13,
                }}
              >
                {listErrorProject}
              </div>
            ) : null}

            {listView === "time" ? (
              <>
                <div
                  ref={listScrollRef}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    WebkitOverflowScrolling: "touch",
                  }}
                >
                  {queueCount > 0 ? (
                    <div
                      style={{
                        borderBottom: "1px solid rgba(0,0,0,0.06)",
                        background: "#FFF8E6",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setQueueOpen((v) => !v)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: "100%",
                          padding: "9px 12px",
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          textAlign: "left",
                          color: "#7A5B00",
                          fontSize: 13,
                          fontWeight: 700,
                        }}
                      >
                        <span>未归属邮件（{queueCount}）</span>
                        <span style={{ fontSize: 11 }}>{queueOpen ? "收起 ▲" : "展开 ▼"}</span>
                      </button>
                      {queueOpen ? (
                        <div style={{ padding: "0 10px 10px" }}>
                          {queueLoading ? (
                            <div style={{ color: "#8A7A40", fontSize: 12 }}>加载中…</div>
                          ) : queueItems.length === 0 ? (
                            <div style={{ color: "#8A7A40", fontSize: 12 }}>暂无待确认邮件</div>
                          ) : (
                            queueItems.map((item) => (
                              <div
                                key={item.id}
                                style={{
                                  border: "1px solid rgba(122,91,0,0.2)",
                                  borderRadius: 8,
                                  background: "#fff",
                                  padding: 8,
                                  marginBottom: 8,
                                }}
                              >
                                <div style={{ fontSize: 12, color: "#444", lineHeight: 1.4 }}>
                                  <div>
                                    <b>{item.from_email}</b> → {item.to_email}
                                  </div>
                                  <div style={{ color: "#666" }}>
                                    {item.subject || "（无主题）"}
                                    {item.received_at ? ` · ${formatTime(item.received_at)}` : ""}
                                  </div>
                                  <div style={{ color: "#999", fontSize: 11 }}>
                                    未归属原因：{item.reason || "unresolved"}
                                  </div>
                                  {item.body_excerpt ? (
                                    <div
                                      style={{
                                        color: "#777",
                                        fontSize: 11,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        marginTop: 2,
                                      }}
                                    >
                                      {String(item.body_excerpt).replace(/\n/g, " ").slice(0, 120)}
                                    </div>
                                  ) : null}
                                </div>
                                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                  <input
                                    value={claimInput[item.id] || ""}
                                    onChange={(e) =>
                                      setClaimInput((prev) => ({
                                        ...prev,
                                        [item.id]: e.target.value,
                                      }))
                                    }
                                    placeholder="红人 ID / username"
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      padding: "5px 7px",
                                      fontSize: 12,
                                      borderRadius: 5,
                                      border: "1px solid rgba(0,0,0,0.15)",
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => submitQueueAction(item, "claim")}
                                    disabled={!(claimInput[item.id] || "").trim()}
                                    style={{
                                      padding: "5px 9px",
                                      borderRadius: 5,
                                      border: "1px solid rgba(0,0,0,0.2)",
                                      background: "#111",
                                      color: "#fff",
                                      fontSize: 12,
                                      cursor: "pointer",
                                      opacity: (claimInput[item.id] || "").trim() ? 1 : 0.5,
                                    }}
                                  >
                                    认领
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => submitQueueAction(item, "ignore")}
                                    style={{
                                      padding: "5px 9px",
                                      borderRadius: 5,
                                      border: "1px solid rgba(0,0,0,0.2)",
                                      background: "#fff",
                                      color: "#555",
                                      fontSize: 12,
                                      cursor: "pointer",
                                    }}
                                  >
                                    忽略
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {listLoading && !conversations.length ? (
                    <div style={{ padding: 12, color: "#666", fontSize: 13 }}>加载中…</div>
                  ) : null}
                  {conversations.map((inf) => {
                    const active = inf.influencerId === influencerId;
                    return (
                      <Link
                        key={inf.influencerId}
                        href={`/influencers/${encodeURIComponent(inf.influencerId)}`}
                        scroll={false}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "10px 12px",
                          border: "none",
                          borderBottom: "1px solid rgba(0,0,0,0.05)",
                          background: active ? "#D4D4D4" : "transparent",
                          cursor: "pointer",
                          textDecoration: "none",
                          color: "inherit",
                          boxSizing: "border-box",
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 4,
                              background: "#D1D1D1",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontWeight: 800,
                              fontSize: 12,
                              flexShrink: 0,
                            }}
                          >
                            {(inf.displayName || inf.username || inf.influencerId || "?")
                              .slice(0, 2)
                              .toUpperCase()}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>
                              {inf.displayName || inf.username || inf.influencerId}
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: "#666",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {inf.lastEventTime ? formatTime(inf.lastEventTime) : "—"} ·{" "}
                              {(inf.lastPreview?.bodyText || inf.lastPreview?.subject || "").slice(
                                0,
                                36
                              ) || "…"}
                            </div>
                          </div>
                          <Pill tone={inf.handoverMode === "auto" ? "green" : "neutral"}>
                            {inf.handoverMode === "auto" ? "全托管" : "半托管"}
                          </Pill>
                        </div>
                      </Link>
                    );
                  })}
                  {!conversations.length && !listLoading ? (
                    <div style={{ padding: 12, color: "#888", fontSize: 13 }}>暂无会话</div>
                  ) : null}
                </div>

                {listHasMore ? (
                  <div
                    style={{
                      flexShrink: 0,
                      padding: 8,
                      borderTop: "1px solid rgba(0,0,0,0.06)",
                    }}
                  >
                    <button
                      type="button"
                      disabled={listLoading}
                      onClick={() => loadConversations({ cursor: listCursor, reset: false })}
                      style={{
                        width: "100%",
                        padding: "8px",
                        borderRadius: 6,
                        border: "1px solid rgba(0,0,0,0.12)",
                        background: "#fff",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      加载更多
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <ProjectInboxList
                  accounts={projectData.accounts}
                  orphans={projectData.orphans}
                  influencerId={influencerId}
                  campaignInfluencers={campaignInfluencers}
                  listScrollRef={listScrollRef}
                  accountPref={accountPref}
                  campPref={campPref}
                  onToggleAccount={onToggleAccount}
                  onToggleCampaign={onToggleCampaign}
                />
                {projectData.hasMoreAccounts ? (
                  <div
                    style={{
                      flexShrink: 0,
                      padding: 8,
                      borderTop: "1px solid rgba(0,0,0,0.06)",
                    }}
                  >
                    <button
                      type="button"
                      disabled={listLoadingProject}
                      onClick={() =>
                        loadProjectTree({
                          accountCursor: projectData.accountNextCursor,
                          reset: false,
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "8px",
                        borderRadius: 6,
                        border: "1px solid rgba(0,0,0,0.12)",
                        background: "#fff",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      加载更多账户
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
              background: "#EDEDED",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </InfluencerInboxProvider>
  );
}
