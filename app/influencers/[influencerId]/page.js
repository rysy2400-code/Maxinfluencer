"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "next/navigation";
import { useInfluencerInbox } from "../influencer-inbox-context";
import { formatTime, Pill } from "../shared-ui";

export default function InfluencerChatPage() {
  const params = useParams();
  const influencerId = params?.influencerId ? String(params.influencerId) : null;
  const inbox = useInfluencerInbox();

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

  const latestDraft = useMemo(() => {
    const drafts = timelineItems.filter((x) => x.eventType === "draft_outbound");
    return drafts.length ? drafts[drafts.length - 1] : null;
  }, [timelineItems]);

  const latestInbound = useMemo(() => {
    const inb = timelineItems.filter((x) => x.eventType === "email_inbound");
    return inb.length ? inb[inb.length - 1] : null;
  }, [timelineItems]);

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
        await inbox?.refreshConversations?.();
      } catch (e) {
        alert(e?.message || String(e));
      } finally {
        setModeSaving(false);
      }
    },
    [influencerId, inbox]
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
          el != null ? { prevHeight: el.scrollHeight, prevTop: el.scrollTop } : null;
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
      await inbox?.refreshConversations?.({ afterSend: true });
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
    inbox,
    loadOutboundFromEmail,
  ]);

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
    <>
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
            outboundFromEmail || (outboundEmailLoading ? "加载发件邮箱…" : influencerId || "")
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
    </>
  );
}
