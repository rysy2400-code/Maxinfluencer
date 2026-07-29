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
import {
  inboundAttachmentDownloadUrl,
  inboundAttachmentPreviewUrl,
  isImageAttachment,
} from "../../../lib/influencer/inbound-attachment-urls.js";

function attachmentPreviewHref(att) {
  if (att?.inboundAttachmentId) {
    return inboundAttachmentPreviewUrl(att.inboundAttachmentId);
  }
  if (att?.attachmentId) {
    return `/api/influencers/attachments/${att.attachmentId}`;
  }
  return null;
}

function attachmentDownloadHref(att) {
  if (att?.inboundAttachmentId) {
    return inboundAttachmentDownloadUrl(att.inboundAttachmentId);
  }
  if (att?.attachmentId) {
    return `/api/influencers/attachments/${att.attachmentId}?download=1`;
  }
  return null;
}

function renderTimelineAttachments(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <div style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
      {items.map((att, idx) => {
        const previewHref = attachmentPreviewHref(att);
        const downloadHref = attachmentDownloadHref(att);
        const showImage = isImageAttachment(att?.contentType) && previewHref;
        return (
          <div key={`${att?.inboundAttachmentId || att?.attachmentId || idx}`} style={{ marginTop: 6 }}>
            {showImage ? (
              <a href={previewHref} target="_blank" rel="noreferrer">
                <img
                  src={previewHref}
                  alt={att?.filename || `attachment-${idx + 1}`}
                  loading="lazy"
                  style={{
                    display: "block",
                    maxWidth: 240,
                    maxHeight: 240,
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.08)",
                    objectFit: "contain",
                    background: "#F5F5F5",
                  }}
                />
              </a>
            ) : null}
            <div style={{ marginTop: showImage ? 4 : 0 }}>
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
          </div>
        );
      })}
    </div>
  );
}

function draftTriggerLabel(triggerType) {
  const t = triggerType || "";
  if (t === "first_outreach") return "首封邀约";
  if (t === "inbound_auto_reply") return "红人回复";
  if (t === "ask_influencer_special_request") return "特殊请求";
  if (t.startsWith("advertiser_execution_followup:")) {
    return `执行跟进 · ${t.split(":")[1] || "操作"}`;
  }
  if (t === "outbound_email") return "Agent 回复";
  return "Agent 草稿";
}

function draftStatusLabel(status) {
  if (status === "approved_sent") return "已发送";
  if (status === "discarded") return "已废弃";
  return "待审核";
}

export default function InfluencerChatPage() {
  const params = useParams();
  const influencerId = params?.influencerId ? String(params.influencerId) : null;
  const inbox = useInfluencerInbox();

  const [mode, setMode] = useState("auto");
  const [modeSaving, setModeSaving] = useState(false);

  const [campaignCards, setCampaignCards] = useState([]);

  const [timelineItems, setTimelineItems] = useState([]);
  const [timelineCursor, setTimelineCursor] = useState(null);
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState(null);

  const [composerText, setComposerText] = useState("");
  const [composerFiles, setComposerFiles] = useState([]);
  const [composerDraftId, setComposerDraftId] = useState(null);
  const [sending, setSending] = useState(false);
  const [outboundFromEmail, setOutboundFromEmail] = useState(null);
  const [outboundEmailLoading, setOutboundEmailLoading] = useState(false);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  /** 加载更早一页后恢复滚动位置；为 null 时表示滚到最新消息 */
  const prependAdjustRef = useRef(null);

  const pendingDrafts = useMemo(() => {
    return timelineItems.filter((x) => {
      if (x.eventType !== "draft_outbound") return false;
      const status = x.payloadSafe?.draft?.status || x.payloadSafe?.status || "pending";
      return status === "pending";
    });
  }, [timelineItems]);

  const latestPendingDraft = useMemo(() => {
    return pendingDrafts.length ? pendingDrafts[pendingDrafts.length - 1] : null;
  }, [pendingDrafts]);

  const composerDraft = useMemo(() => {
    if (!composerDraftId) return null;
    return pendingDrafts.find((x) => String(x.id) === String(composerDraftId)) || null;
  }, [composerDraftId, pendingDrafts]);

  const loadMode = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/influencers/${id}/mode`);
      const data = await res.json();
      if (data?.success) setMode(data.mode || "auto");
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
    setComposerDraftId(null);
  }, [influencerId, loadMode, loadCampaignCards, loadOutboundFromEmail, loadTimeline]);

  useEffect(() => {
    if (mode !== "assist") return;
    if (!latestPendingDraft?.bodyText) return;
    if (composerText.trim()) return;
    setComposerDraftId(latestPendingDraft.id);
    setComposerText(latestPendingDraft.bodyText);
  }, [mode, latestPendingDraft, composerText]);

  useEffect(() => {
    if (!composerDraftId) return;
    if (pendingDrafts.some((x) => String(x.id) === String(composerDraftId))) return;
    setComposerDraftId(null);
  }, [composerDraftId, pendingDrafts]);

  const loadDraftIntoComposer = useCallback(
    (draft) => {
      if (!draft?.bodyText) return;
      if (
        composerText.trim() &&
        String(composerDraftId || "") !== String(draft.id) &&
        !window.confirm("输入框已有内容，是否用这条草稿替换？")
      ) {
        return;
      }
      setComposerDraftId(draft.id);
      setComposerText(draft.bodyText);
    },
    [composerDraftId, composerText]
  );

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
      if (composerDraftId) {
        fd.set("draftEventId", String(composerDraftId));
        if (composerDraft?.campaignId) {
          fd.set("campaignId", String(composerDraft.campaignId));
        }
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
      setComposerDraftId(null);
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
    composerDraftId,
    composerDraft,
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
            {item.eventType === "draft_outbound" ? (
              <> · {draftStatusLabel(item.payloadSafe?.draft?.status)}</>
            ) : null}
            <span style={{ marginLeft: 8 }}>{formatTime(item.eventTime)}</span>
          </div>
          {item.subject && item.eventType !== "draft_outbound" ? (
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{item.subject}</div>
          ) : null}
          <div style={{ whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.45 }}>
            {item.bodyText}
          </div>
          {renderTimelineAttachments(item.payloadSafe?.attachments?.items)}
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
        {mode === "assist" && pendingDrafts.length ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 800 }}>待审核草稿</span>
            {pendingDrafts.map((draft) => {
              const active = String(composerDraftId || "") === String(draft.id);
              const label = draftTriggerLabel(draft.payloadSafe?.draft?.triggerType);
              return (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => loadDraftIntoComposer(draft)}
                  title={draft.subject || label}
                  style={{
                    maxWidth: 220,
                    border: active
                      ? "1px solid rgba(180,83,9,0.55)"
                      : "1px solid rgba(0,0,0,0.12)",
                    background: active ? "#FFF7D6" : "#fff",
                    borderRadius: 8,
                    padding: "5px 8px",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label} · {formatTime(draft.eventTime)}
                </button>
              );
            })}
          </div>
        ) : null}
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
