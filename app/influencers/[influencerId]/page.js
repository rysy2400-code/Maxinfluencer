"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter } from "next/navigation";

function formatTime(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  } catch {
    return String(v);
  }
}

function Pill({ children, tone = "neutral" }) {
  const bg =
    tone === "green"
      ? "#DCFCE7"
      : tone === "red"
        ? "#FEE2E2"
        : tone === "blue"
          ? "#DBEAFE"
          : "#E2E8F0";
  const fg =
    tone === "green"
      ? "#166534"
      : tone === "red"
        ? "#991B1B"
        : tone === "blue"
          ? "#1D4ED8"
          : "#0F172A";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
        border: "1px solid rgba(15, 23, 42, 0.06)",
        whiteSpace: "normal",
        maxWidth: "100%",
      }}
    >
      {children}
    </span>
  );
}

export default function InfluencerChatPage() {
  const params = useParams();
  const router = useRouter();
  const influencerId = params?.influencerId ? String(params.influencerId) : null;

  const [listQ, setListQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [conversations, setConversations] = useState([]);
  const [listCursor, setListCursor] = useState(null);
  const [listHasMore, setListHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);

  const [mode, setMode] = useState("assist");
  const [modeSaving, setModeSaving] = useState(false);

  const [campaignCards, setCampaignCards] = useState([]);

  const [timelineItems, setTimelineItems] = useState([]);
  const [timelineCursor, setTimelineCursor] = useState(null);
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState(null);

  const [composerText, setComposerText] = useState("");
  const [composerFiles, setComposerFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [outboundFromEmail, setOutboundFromEmail] = useState(null);
  const [outboundEmailLoading, setOutboundEmailLoading] = useState(false);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  /** 加载更早一页后恢复滚动位置；为 null 时表示滚到最新消息 */
  const prependAdjustRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(listQ.trim()), 300);
    return () => clearTimeout(t);
  }, [listQ]);

  const latestDraft = useMemo(() => {
    const drafts = timelineItems.filter((x) => x.eventType === "draft_outbound");
    return drafts.length ? drafts[drafts.length - 1] : null;
  }, [timelineItems]);

  const latestInbound = useMemo(() => {
    const inb = timelineItems.filter((x) => x.eventType === "email_inbound");
    return inb.length ? inb[inb.length - 1] : null;
  }, [timelineItems]);

  const loadConversations = useCallback(
    async ({ cursor, reset }) => {
      setListLoading(true);
      setListError(null);
      try {
        const qs = new URLSearchParams();
        qs.set("limit", "40");
        if (debouncedQ) qs.set("q", debouncedQ);
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/influencers/conversations?` + qs.toString());
        const data = await res.json();
        if (!data?.success) throw new Error(data?.error || "加载失败");
        const items = data.items || [];
        setListHasMore(!!data.hasMore);
        setListCursor(data.nextCursor || null);
        setConversations((prev) => (reset ? items : [...prev, ...items]));
      } catch (e) {
        setListError(e?.message || String(e));
      } finally {
        setListLoading(false);
      }
    },
    [debouncedQ]
  );

  useEffect(() => {
    setConversations([]);
    setListCursor(null);
    setListHasMore(false);
    loadConversations({ cursor: null, reset: true });
  }, [debouncedQ, loadConversations]);

  const loadMode = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/influencers/${id}/mode`);
      const data = await res.json();
      if (data?.success) setMode(data.mode || "assist");
    } catch {
      // ignore
    }
  }, []);

  const saveMode = useCallback(
    async (nextMode) => {
      if (!influencerId) return;
      setModeSaving(true);
      try {
        const res = await fetch(`/api/influencers/${influencerId}/mode`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: nextMode }),
        });
        const data = await res.json();
        if (!data?.success) throw new Error(data?.error || "保存失败");
        setMode(data.mode || nextMode);
        await loadConversations({ cursor: null, reset: true });
      } catch (e) {
        alert(e?.message || String(e));
      } finally {
        setModeSaving(false);
      }
    },
    [influencerId, loadConversations]
  );

  const loadCampaignCards = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/influencers/${id}/active-campaigns?limit=50`);
      const data = await res.json();
      if (data?.success) setCampaignCards(data.items || []);
    } catch {
      setCampaignCards([]);
    }
  }, []);

  const loadOutboundFromEmail = useCallback(async (id) => {
    if (!id) {
      setOutboundFromEmail(null);
      return;
    }
    setOutboundEmailLoading(true);
    try {
      const res = await fetch(`/api/influencers/${encodeURIComponent(id)}/thread-mail`);
      const data = await res.json();
      if (data?.success && data.outboundEmail) {
        setOutboundFromEmail(String(data.outboundEmail));
      } else {
        setOutboundFromEmail(null);
      }
    } catch {
      setOutboundFromEmail(null);
    } finally {
      setOutboundEmailLoading(false);
    }
  }, []);

  const loadTimeline = useCallback(async ({ id, cursor, reset }) => {
    if (!id) return;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "30");
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`/api/influencers/${id}/timeline?` + qs.toString());
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || "加载失败");
      const items = data.items || [];
      const chronological = [...items].reverse();
      setTimelineHasMore(!!data.hasMore);
      setTimelineCursor(data.nextCursor || null);
      if (reset) {
        prependAdjustRef.current = null;
        setTimelineItems(chronological);
      } else {
        const el = scrollRef.current;
        prependAdjustRef.current =
          el != null
            ? { prevHeight: el.scrollHeight, prevTop: el.scrollTop }
            : null;
        setTimelineItems((prev) => [...chronological, ...prev]);
      }
    } catch (e) {
      setTimelineError(e?.message || String(e));
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!influencerId) return;
    loadMode(influencerId);
    loadCampaignCards(influencerId);
    loadOutboundFromEmail(influencerId);
    setTimelineItems([]);
    setTimelineCursor(null);
    setTimelineHasMore(false);
    loadTimeline({ id: influencerId, cursor: null, reset: true });
    setComposerText("");
    setComposerFiles([]);
  }, [influencerId, loadMode, loadCampaignCards, loadOutboundFromEmail, loadTimeline]);

  useEffect(() => {
    if (mode !== "assist") return;
    if (!latestDraft?.bodyText) return;
    setComposerText((prev) => (prev && prev.trim() ? prev : latestDraft.bodyText));
  }, [mode, latestDraft]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const adj = prependAdjustRef.current;
    prependAdjustRef.current = null;
    if (adj) {
      const delta = el.scrollHeight - adj.prevHeight;
      el.scrollTop = adj.prevTop + delta;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [timelineItems]);

  const onPickFiles = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    setComposerFiles(files);
  }, []);

  const removeFileAt = useCallback((idx) => {
    setComposerFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const onSend = useCallback(async () => {
    if (!influencerId) return;
    if (!composerText.trim()) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.set("text", composerText);
      if (mode === "assist" && latestInbound?.messageId) {
        fd.set("sendMode", "human_approved");
        fd.set("contentOrigin", "human_edited_agent");
      } else {
        fd.set("sendMode", "human_manual_send");
        fd.set("contentOrigin", "human_written");
      }
      for (const f of composerFiles) {
        fd.append("attachments", f);
      }

      const res = await fetch(`/api/influencers/${influencerId}/messages/send`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!data?.success) {
        throw new Error(data?.error || "发送失败");
      }

      setComposerText("");
      setComposerFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadTimeline({ id: influencerId, cursor: null, reset: true });
      await loadConversations({ cursor: null, reset: true });
      await loadOutboundFromEmail(influencerId);
    } catch (e) {
      alert(e?.message || String(e));
    } finally {
      setSending(false);
    }
  }, [
    influencerId,
    composerText,
    composerFiles,
    mode,
    latestInbound,
    loadTimeline,
    loadConversations,
    loadOutboundFromEmail,
  ]);

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

  const renderBubble = (item) => {
    const isInbound = item.eventType === "email_inbound";
    const isOutbound =
      item.eventType === "email_outbound" || item.eventType === "draft_outbound";
    const isAction =
      item.eventType === "agent_action" || item.eventType === "campaign_update";

    if (isAction) {
      return (
        <div key={item.id} style={{ display: "flex", justifyContent: "center", margin: "10px 0" }}>
          <div
            style={{
              maxWidth: "85%",
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(0,0,0,0.06)",
              fontSize: 12,
              color: "#555",
            }}
          >
            <span style={{ fontWeight: 700 }}>{item.eventType}</span>
            <span style={{ margin: "0 6px" }}>·</span>
            <span>{formatTime(item.eventTime)}</span>
            {item.bodyText ? (
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{item.bodyText}</div>
            ) : null}
          </div>
        </div>
      );
    }

    const alignRight = isOutbound && !isInbound;
    const bubbleBg = alignRight
      ? item.eventType === "draft_outbound"
        ? "#FFF9E6"
        : item.actorType === "human"
          ? "#95EC69"
          : "#E5E5EA"
      : "#FFFFFF";
    const border = alignRight ? "none" : "1px solid rgba(0,0,0,0.06)";

    return (
      <div
        key={item.id}
        style={{
          display: "flex",
          justifyContent: alignRight ? "flex-end" : "flex-start",
          margin: "8px 12px",
        }}
      >
        <div
          style={{
            maxWidth: "72%",
            padding: "10px 12px",
            borderRadius: alignRight ? "12px 4px 12px 12px" : "4px 12px 12px 12px",
            background: bubbleBg,
            border,
            boxShadow: "0 1px 1px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
            {item.eventType}
            {item.actorType ? ` · ${item.actorType}` : ""}
            <span style={{ marginLeft: 8 }}>{formatTime(item.eventTime)}</span>
          </div>
          {item.subject && item.eventType !== "draft_outbound" ? (
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{item.subject}</div>
          ) : null}
          <div style={{ whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.45 }}>
            {item.bodyText}
          </div>
          {item.payloadSafe?.attachments?.items?.length ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
              {item.payloadSafe.attachments.items.map((att, idx) => {
                const aid = att?.attachmentId;
                const previewHref = aid ? `/api/influencers/attachments/${aid}` : null;
                const downloadHref = aid ? `/api/influencers/attachments/${aid}?download=1` : null;
                return (
                  <div key={`${aid || idx}`} style={{ marginTop: 4 }}>
                    {att?.filename || `file-${idx + 1}`}
                    {previewHref ? (
                      <a
                        href={previewHref}
                        target="_blank"
                        rel="noreferrer"
                        style={{ marginLeft: 8, color: "#576B95" }}
                      >
                        预览
                      </a>
                    ) : null}
                    {downloadHref ? (
                      <a
                        href={downloadHref}
                        target="_blank"
                        rel="noreferrer"
                        style={{ marginLeft: 6, color: "#576B95" }}
                      >
                        下载
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
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
            <input
              value={listQ}
              onChange={(e) => setListQ(e.target.value)}
              placeholder="搜索 id / 用户名 / 昵称 / 邮箱"
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
              onClick={() => loadConversations({ cursor: null, reset: true })}
              disabled={listLoading}
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

          {listError ? (
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

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
            {conversations.map((inf) => {
              const active = inf.influencerId === influencerId;
              return (
                <button
                  key={inf.influencerId}
                  type="button"
                  onClick={() => router.push(`/influencers/${encodeURIComponent(inf.influencerId)}`)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 12px",
                    border: "none",
                    borderBottom: "1px solid rgba(0,0,0,0.05)",
                    background: active ? "#D4D4D4" : "transparent",
                    cursor: "pointer",
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
                      <div style={{ fontSize: 12, color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {inf.lastEventTime ? formatTime(inf.lastEventTime) : "—"} ·{" "}
                        {(inf.lastPreview?.bodyText || inf.lastPreview?.subject || "").slice(0, 36) ||
                          "…"}
                      </div>
                    </div>
                    <Pill tone={inf.handoverMode === "auto" ? "green" : "neutral"}>
                      {inf.handoverMode === "auto" ? "全托管" : "半托管"}
                    </Pill>
                  </div>
                </button>
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
          <div
            style={{
              flexShrink: 0,
              padding: "10px 14px",
              background: "#F7F7F7",
              borderBottom: "1px solid rgba(0,0,0,0.08)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                minWidth: 0,
                flex: "1 1 auto",
                fontWeight: 800,
                fontSize: 15,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={
                outboundFromEmail ||
                (outboundEmailLoading ? "加载发件邮箱…" : influencerId || "")
              }
            >
              {outboundEmailLoading
                ? "加载发件邮箱…"
                : outboundFromEmail || influencerId || "未选择"}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={modeSaving || !influencerId}
                onClick={() => saveMode(mode === "auto" ? "assist" : "auto")}
                style={{
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "#fff",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                模式：{mode === "auto" ? "全托管" : "半托管"}（点击切换）
              </button>
              <button
                type="button"
                disabled={timelineLoading || !influencerId}
                onClick={() => {
                  void loadTimeline({ id: influencerId, cursor: null, reset: true });
                  void loadOutboundFromEmail(influencerId);
                }}
                style={{
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "#fff",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                刷新对话
              </button>
            </div>
          </div>

          <div
            style={{
              flexShrink: 0,
              maxHeight: 120,
              overflowY: "auto",
              padding: "8px 14px",
              background: "#EFEFEF",
              borderBottom: "1px solid rgba(0,0,0,0.06)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 800 }}>Active campaigns</span>
            {campaignCards.map((c) => {
              const brandProduct = [c.brandName, c.productName].filter(Boolean).join(" · ");
              const stagePrice = `${c.stage || "—"} · ${c.price == null ? "—" : `$${c.price}`}`;
              const label = brandProduct ? `${brandProduct} · ${stagePrice}` : stagePrice;
              return (
                <Pill key={c.campaignId} tone="blue">
                  {label}
                </Pill>
              );
            })}
            {!campaignCards.length ? <span style={{ color: "#888" }}>暂无</span> : null}
          </div>

          <div
            ref={scrollRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              padding: "8px 0 16px",
            }}
          >
            {timelineError ? (
              <div style={{ padding: 12, color: "#B91C1C" }}>{timelineError}</div>
            ) : null}
            {timelineHasMore ? (
              <div style={{ textAlign: "center", marginBottom: 8 }}>
                <button
                  type="button"
                  disabled={timelineLoading}
                  onClick={() =>
                    loadTimeline({ id: influencerId, cursor: timelineCursor, reset: false })
                  }
                  style={{
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "#fff",
                    borderRadius: 8,
                    padding: "6px 12px",
                    fontWeight: 700,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  更早消息
                </button>
              </div>
            ) : null}
            {timelineItems.map(renderBubble)}
            {!timelineItems.length && !timelineLoading ? (
              <div style={{ padding: 24, textAlign: "center", color: "#888" }}>暂无消息</div>
            ) : null}
          </div>

          <div
            style={{
              flexShrink: 0,
              background: "#F7F7F7",
              borderTop: "1px solid rgba(0,0,0,0.1)",
              padding: "10px 12px",
            }}
          >
            <textarea
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey) return;
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (sending || !influencerId) return;
                void onSend();
              }}
              placeholder="输入消息…（Enter 发送，Shift+Enter 换行；主题与收件人由服务器按邮件线程自动匹配）"
              style={{
                width: "100%",
                minHeight: 72,
                maxHeight: 200,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.12)",
                resize: "vertical",
                fontFamily: "inherit",
                fontSize: 15,
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
              <input ref={fileInputRef} type="file" multiple onChange={onPickFiles} />
              {sending ? (
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>发送中…</span>
              ) : null}
            </div>
            {composerFiles.length ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#444" }}>
                {composerFiles.map((f, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{f.name}</span>
                    <button type="button" onClick={() => removeFileAt(idx)} style={{ fontSize: 12 }}>
                      移除
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
