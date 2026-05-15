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

export default function InfluencersLayout({ children }) {
  const influencerId = useInfluencerIdFromPath();

  const [listView, setListView] = useState("time");
  const [listQ, setListQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  const [conversations, setConversations] = useState([]);
  const [listCursor, setListCursor] = useState(null);
  const [listHasMore, setListHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);

  const [projectData, setProjectData] = useState({
    accounts: [],
    orphans: [],
    accountNextCursor: null,
    hasMoreAccounts: false,
  });
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

  useEffect(() => {
    if (listView !== "time") return;
    loadConversations({ cursor: null, reset: true });
  }, [debouncedQ, listView, loadConversations]);

  useEffect(() => {
    if (listView !== "project") return;
    loadProjectTree({ accountCursor: null, reset: true });
  }, [debouncedQ, listView, loadProjectTree]);

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
  }, [listView, listLoadingProject, projectData.accounts, projectData.orphans, influencerId]);

  const refreshConversations = useCallback(
    async (opts = {}) => {
      if (listView === "project") {
        if (opts.afterSend) pendingScrollProjectAfterSendRef.current = true;
        await loadProjectTree({ accountCursor: null, reset: true });
      } else {
        if (opts.afterSend) pendingScrollListToTopAfterSendRef.current = true;
        await loadConversations({ cursor: null, reset: true });
      }
    },
    [listView, loadConversations, loadProjectTree]
  );

  const inboxValue = useMemo(() => ({ refreshConversations }), [refreshConversations]);

  const selectionPath = useMemo(
    () => findSelectionPath(projectData.accounts, projectData.orphans, influencerId),
    [projectData.accounts, projectData.orphans, influencerId]
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
    (campaignId, nextOpen) => {
      patchExpandTouched(`camp:${campaignId}`, nextOpen);
    },
    [patchExpandTouched]
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
