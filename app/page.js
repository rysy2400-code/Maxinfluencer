"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ChatSendUpIcon } from "./chat-send-up-icon";

// Bin Logo 组件 - 使用创始人名字 "Bin"，纯 CSS 圆形徽标，避免 SVG 抗锯齿导致的未完全填充问题
function BinLogo({ size = 24 }) {
  const fontSize = Math.round(size * 0.45);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: "#0F172A",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#FFFFFF",
        fontSize,
        fontWeight: 600,
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        lineHeight: 1
      }}
    >
      Bin
    </div>
  );
}

// 自适应高度的 textarea Hook：根据内容自动调整高度，最多不超过 maxHeight
function useAutoResizeTextArea(value, maxHeight = 220) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
  }, [value, maxHeight]);

  return ref;
}

/** 侧栏会话行「⋯」更多菜单（悬停显隐由父级控制），对齐 DeepSeek 式交互 */
function CampaignSessionRowMenu({ sessionId, showTrigger, menuOpen, onToggleMenu, onRename, onDelete }) {
  return (
    <div
      data-session-menu-root={sessionId}
      style={{
        position: "relative",
        flexShrink: 0,
        alignSelf: "center",
        opacity: showTrigger ? 1 : 0,
        pointerEvents: showTrigger ? "auto" : "none",
        transition: "opacity 0.12s ease",
      }}
    >
      <button
        type="button"
        aria-label="更多操作"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMenu(e);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "2px 6px",
          color: "#6B7280",
          fontSize: 15,
          lineHeight: 1,
          borderRadius: 6,
        }}
      >
        …
      </button>
      {menuOpen ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            minWidth: 128,
            background: "#FFFFFF",
            border: "1px solid #E5E7EB",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 80,
            padding: "4px 0",
            fontSize: 13,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "8px 12px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              color: "#111827",
              fontSize: 13,
            }}
          >
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "8px 12px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              color: "#DC2626",
              fontSize: 13,
            }}
          >
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}

const STORAGE_KEY_MESSAGES = "maxinfluencer_chat_messages";
const STORAGE_KEY_CONTEXT = "maxinfluencer_chat_context";
const STORAGE_KEY_CURRENT_SESSION_ID = "maxinfluencer_current_session_id";
const STORAGE_KEY_VERSION = "maxinfluencer_message_version";
const MESSAGE_VERSION = "v2.0"; // 修改 defaultMessage 时更新此版本号

function cloneWelcomeMessages() {
  return [
    {
      role: "assistant",
      name: "Bin",
      content:
        "您好，我是Bin，告诉我您想推广的产品链接，我来帮您发布campaign！",
    },
  ];
}

/** 清除本机持久化的聊天状态（换账号登录 / 会话 id 无效时避免沿用他人超长对话导致 POST 创建会话失败） */
function clearChatPersistenceKeys() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY_MESSAGES);
    localStorage.removeItem(STORAGE_KEY_CONTEXT);
    localStorage.removeItem(STORAGE_KEY_CURRENT_SESSION_ID);
  } catch {
    /* ignore */
  }
}

/** 工作笔记条目去重键：优先 taskId；缺失时勿仅用 keyword（多轮同词会误合并） */
function workNoteMergeKey(note) {
  if (!note || typeof note !== "object") return "";
  const tid = note.taskId ?? note.task_id;
  if (tid != null && String(tid).trim() !== "") {
    const n = Number(tid);
    if (!Number.isNaN(n)) return `id:${n}`;
  }
  const kw = String(note.keyword ?? "").trim();
  const t = String(note.time ?? "");
  return `kw:${kw}@${t}`;
}

function buildTikTokProfileUrl(handle) {
  const u = String(handle || "")
    .trim()
    .replace(/^@/, "");
  if (!u) return "#";
  return `https://www.tiktok.com/@${encodeURIComponent(u)}`;
}

function formatAnalysisSnippet(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v.length > 900 ? `${v.slice(0, 900)}…` : v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 900 ? `${s.slice(0, 900)}…` : s;
  } catch {
    return String(v);
  }
}

/** 粉丝/播放等指标：抓取链路常为 { count, display }，不可直接作为 React 子节点渲染 */
function formatInfluencerStat(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    if (typeof v.display === "string" && v.display.trim()) return v.display.trim();
    if (typeof v.count === "number" && Number.isFinite(v.count)) {
      return v.count.toLocaleString();
    }
    return "—";
  }
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString();
  return String(v);
}

/** eCPM 用数值播放量：优先 views.count */
function getNumericViewsForEcpm(item) {
  const v = item.avg_views ?? item.avgViews ?? item.views;
  if (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof v.count === "number" &&
    Number.isFinite(v.count) &&
    v.count > 0
  ) {
    return v.count;
  }
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

function formatEcpmFromFlatAndViews(flatAmt, viewsNum, currencyCode) {
  if (
    flatAmt == null ||
    !Number.isFinite(Number(flatAmt)) ||
    viewsNum == null ||
    viewsNum <= 0
  ) {
    return "—";
  }
  const v = Number(flatAmt) / (viewsNum / 1000);
  return `${v.toFixed(2)} ${currencyCode || "USD"} / 千次播放`;
}

/** 执行进度 Tab 下单条红人卡片（按阶段展示字段） */
function ExecutionProgressRow({
  stageKey,
  item,
  needSample,
  execPatchingId,
  patchExecution,
}) {
  const [draftExpanded, setDraftExpanded] = React.useState(false);
  const [negExpanded, setNegExpanded] = React.useState(false);
  const [counterAmount, setCounterAmount] = React.useState("");
  const [counterCurrency, setCounterCurrency] = React.useState("USD");
  const [counterReason, setCounterReason] = React.useState("");
  const username = item.id || "";

  React.useEffect(() => {
    setCounterCurrency((item.currency || "USD").toString().toUpperCase().slice(0, 8) || "USD");
  }, [item.id, item.currency]);
  const profileUrl = buildTikTokProfileUrl(username);
  const busy = execPatchingId === username;

  const followers = formatInfluencerStat(
    item.followers ?? item.followerCount ?? item.follower_count
  );
  const views = formatInfluencerStat(
    item.avg_views ?? item.avgViews ?? item.views
  );
  const recommendReasonRaw =
    item.analysisSummary ||
    item.reason ||
    item.analysis_summary ||
    item.match_analysis_summary ||
    "";
  const recommendReason =
    typeof recommendReasonRaw === "string"
      ? recommendReasonRaw
      : recommendReasonRaw != null
      ? formatAnalysisSnippet(recommendReasonRaw)
      : "";
  const matchObj =
    item.matchAnalysis && typeof item.matchAnalysis === "object"
      ? item.matchAnalysis
      : null;
  const profileAnalysis =
    (matchObj && matchObj.analysis) ||
    item.analysis ||
    item.profile_analysis ||
    "";

  const shippingRaw =
    item.executionShippingInfo ||
    item.shippingAddress ||
    item.shipping_info ||
    {};
  const shipping =
    typeof shippingRaw === "object" && shippingRaw !== null
      ? shippingRaw
      : {};

  const flatUsd =
    item.flatFeeUsd ??
    item.flat_fee ??
    item.flatFeeUSD ??
    item.campaignAgentDecision?.flatFeeUSD ??
    null;
  const viewsNumForEcpm = getNumericViewsForEcpm(item);
  const ecpmDisplay =
    item.ecpm != null && item.ecpm !== ""
      ? String(item.ecpm)
      : formatEcpmFromFlatAndViews(
          flatUsd,
          viewsNumForEcpm,
          item.currency || "USD"
        );

  const quoteNegotiation = Array.isArray(item.quoteNegotiation)
    ? item.quoteNegotiation
    : [];
  const canApproveReject = item.stage === "quote_submitted";
  const canReopenRejected = item.stage === "quote_rejected";

  let draftLink = item.draftLink || item.videoDraftLink;
  const vd = item.executionVideoDraft;
  if (!draftLink && Array.isArray(vd) && vd.length) {
    const last = vd[vd.length - 1];
    draftLink = last?.draftLink || last?.link || last?.url;
  }
  if (!draftLink && vd && typeof vd === "object" && !Array.isArray(vd)) {
    draftLink = vd.draftLink || vd.link || vd.url;
  }

  const revisionHistory = Array.isArray(item.revisionHistory)
    ? item.revisionHistory
    : [];

  const publishedLink =
    item.videoLink || item.executionVideoLink || item.video_link;

  const cardStyle = {
    padding: "10px 12px",
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    border: "1px solid #E5E7EB",
    fontSize: 12,
    color: "#374151",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const labelRow = (k, v) => (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#6B7280", minWidth: 86, flexShrink: 0 }}>{k}</span>
      <span style={{ flex: 1, wordBreak: "break-word" }}>{v ?? "—"}</span>
    </div>
  );

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <a
          href={profileUrl}
          target="_blank"
          rel="noreferrer"
          style={{ fontWeight: 600, color: "#4F46E5", textDecoration: "none" }}
        >
          @{username}
        </a>
        {item.stage === "quote_rejected" && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              backgroundColor: "#FEE2E2",
              color: "#B91C1C",
              whiteSpace: "nowrap",
            }}
          >
            已拒绝报价
          </span>
        )}
      </div>

      {(stageKey === "contacted" ||
        stageKey === "pendingPrice" ||
        stageKey === "published") && (
        <div style={{ fontSize: 11, color: "#6B7280" }}>
          粉丝 {followers} · 播放 {views}
        </div>
      )}

      {stageKey === "contacted" && (
        <>
          {labelRow("画像分析", formatAnalysisSnippet(profileAnalysis))}
          {labelRow("推荐理由", recommendReason || "—")}
        </>
      )}

      {stageKey === "pendingPrice" && (
        <>
          {labelRow("推荐理由", recommendReason || "—")}
          {labelRow(
            `报价 (${item.currency || "USD"})`,
            flatUsd != null && flatUsd !== ""
              ? `${Number(flatUsd)} ${item.currency || "USD"}`
              : "—"
          )}
          {labelRow("eCPM", ecpmDisplay)}

          {quoteNegotiation.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setNegExpanded(!negExpanded)}
                style={{
                  fontSize: 11,
                  color: "#4F46E5",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {negExpanded ? "收起砍价记录" : `展开砍价记录（${quoteNegotiation.length}）`}
              </button>
              {negExpanded && (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {[...quoteNegotiation].reverse().map((entry, idx) => {
                    const roleLabel =
                      entry.role === "advertiser"
                        ? "广告主"
                        : entry.role === "influencer"
                        ? "红人"
                        : entry.role || "—";
                    const typeLabel =
                      entry.type === "counter"
                        ? "还价"
                        : entry.type === "quote_rejected"
                        ? "拒绝报价"
                        : entry.type === "reopen"
                        ? "撤销拒绝"
                        : entry.type || "";
                    return (
                      <div
                        key={idx}
                        style={{
                          fontSize: 11,
                          borderLeft: "2px solid #E5E7EB",
                          paddingLeft: 8,
                          color: "#4B5563",
                        }}
                      >
                        <div style={{ fontWeight: 600, color: "#374151" }}>
                          {roleLabel}
                          {typeLabel ? ` · ${typeLabel}` : ""}
                          {entry.amount != null && Number.isFinite(Number(entry.amount))
                            ? ` · ${Number(entry.amount)} ${entry.currency || item.currency || "USD"}`
                            : ""}
                        </div>
                        {entry.at ? (
                          <div style={{ fontSize: 10, color: "#9CA3AF" }}>
                            {new Date(entry.at).toLocaleString("zh-CN")}
                          </div>
                        ) : null}
                        {entry.reason ? (
                          <div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>
                            {entry.reason}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {canApproveReject && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                backgroundColor: "#F9FAFB",
                borderRadius: 8,
                border: "1px solid #E5E7EB",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  marginBottom: 6,
                  color: "#6B7280",
                }}
              >
                广告主还价
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="金额"
                  value={counterAmount}
                  onChange={(e) => setCounterAmount(e.target.value)}
                  style={{
                    width: 100,
                    padding: "4px 8px",
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid #D1D5DB",
                  }}
                />
                <input
                  type="text"
                  placeholder="币种"
                  value={counterCurrency}
                  onChange={(e) =>
                    setCounterCurrency(e.target.value.toUpperCase().slice(0, 8))
                  }
                  style={{
                    width: 72,
                    padding: "4px 8px",
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid #D1D5DB",
                  }}
                />
                <input
                  type="text"
                  placeholder="原因（可选）"
                  value={counterReason}
                  onChange={(e) => setCounterReason(e.target.value.slice(0, 2000))}
                  style={{
                    flex: 1,
                    minWidth: 140,
                    padding: "4px 8px",
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid #D1D5DB",
                  }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const amt = parseFloat(counterAmount, 10);
                    if (!Number.isFinite(amt) || amt <= 0) {
                      window.alert("请输入有效正数金额");
                      return;
                    }
                    patchExecution("submitQuote", username, {
                      amount: amt,
                      currency: counterCurrency.trim() || "USD",
                      reason: counterReason.trim() || undefined,
                    });
                    setCounterAmount("");
                    setCounterReason("");
                  }}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "1px solid #4F46E5",
                    backgroundColor: "#EEF2FF",
                    color: "#3730A3",
                    fontSize: 12,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  提交还价
                </button>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
            {canApproveReject && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => patchExecution("approveQuote", username, {})}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 8,
                    border: "1px solid #10B981",
                    backgroundColor: "#ECFDF5",
                    color: "#047857",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  {busy ? "处理中…" : "同意"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const r = window.prompt("拒绝原因（必填，最多 2000 字）");
                    if (r == null) return;
                    const t = r.trim();
                    if (!t) {
                      window.alert("请填写拒绝原因");
                      return;
                    }
                    if (!window.confirm("确认拒绝与该红人合作？")) return;
                    patchExecution("rejectQuote", username, {
                      rejectReason: t.slice(0, 2000),
                    });
                  }}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 8,
                    border: "1px solid #F87171",
                    backgroundColor: "#FEF2F2",
                    color: "#B91C1C",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  拒绝
                </button>
              </>
            )}
            {canReopenRejected && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const r = window.prompt("撤销拒绝的原因（必填，最多 2000 字）");
                  if (r == null) return;
                  const t = r.trim();
                  if (!t) {
                    window.alert("请填写撤销原因");
                    return;
                  }
                  patchExecution("reopenQuote", username, {
                    reopenReason: t.slice(0, 2000),
                  });
                }}
                style={{
                  padding: "4px 12px",
                  borderRadius: 8,
                  border: "1px solid #6366F1",
                  backgroundColor: "#EEF2FF",
                  color: "#4338CA",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                撤销拒绝
              </button>
            )}
          </div>
          {item.stage === "quote_rejected" && (
            <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>
              当前为已拒绝报价；可点击「撤销拒绝」恢复为待审核价格。
              {item.quoteRejectedAt ? (
                <span> 拒绝时间：{String(item.quoteRejectedAt)}</span>
              ) : null}
            </div>
          )}
        </>
      )}

      {stageKey === "pendingSample" && needSample && (
        <>
          {labelRow("Full Name", shipping.fullName || shipping.name)}
          {labelRow("Country", shipping.country)}
          {labelRow("State/Province", shipping.state || shipping.province)}
          {labelRow("City", shipping.city)}
          {labelRow(
            "Address Line",
            shipping.addressLine || shipping.addressLine1 || shipping.address
          )}
          {labelRow("Post/Zip Code", shipping.postalCode || shipping.zip)}
          {labelRow("Telephone", shipping.phone || shipping.telephone)}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              patchExecution("confirmShip", username, {
                shippingAddress: shipping,
              })
            }
            style={{
              alignSelf: "flex-start",
              marginTop: 4,
              padding: "4px 12px",
              borderRadius: 8,
              border: "1px solid #4F46E5",
              backgroundColor: "#EEF2FF",
              color: "#3730A3",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "处理中…" : "确认已寄出样品"}
          </button>
        </>
      )}

      {stageKey === "pendingDraft" && (
        <>
          {labelRow(
            "草稿链接",
            draftLink ? (
              <a href={draftLink} target="_blank" rel="noreferrer" style={{ color: "#4F46E5" }}>
                打开链接
              </a>
            ) : (
              "—"
            )
          )}
          {labelRow("修改建议", item.draftFeedback || item.feedback || "—")}
          {revisionHistory.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setDraftExpanded(!draftExpanded)}
                style={{
                  alignSelf: "flex-start",
                  fontSize: 11,
                  color: "#4F46E5",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {draftExpanded ? "收起修订记录" : `展开修订记录 (${revisionHistory.length})`}
              </button>
              {draftExpanded &&
                revisionHistory.map((rev, idx) => (
                  <div
                    key={idx}
                    style={{
                      borderLeft: "2px solid #E5E7EB",
                      paddingLeft: 8,
                      fontSize: 11,
                      color: "#4B5563",
                    }}
                  >
                    {labelRow(
                      "链接",
                      rev.draftLink ? (
                        <a href={rev.draftLink} target="_blank" rel="noreferrer">
                          {rev.draftLink}
                        </a>
                      ) : (
                        "—"
                      )
                    )}
                    {labelRow("建议", rev.feedback || "—")}
                  </div>
                ))}
            </>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                patchExecution("approveDraft", username, {
                  draftLink,
                })
              }
              style={{
                padding: "4px 12px",
                borderRadius: 8,
                border: "1px solid #10B981",
                backgroundColor: "#ECFDF5",
                color: "#047857",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              同意草稿
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const feedback = window.prompt("修改建议（可选）") ?? "";
                patchExecution("rejectDraft", username, {
                  draftLink,
                  feedback,
                });
              }}
              style={{
                padding: "4px 12px",
                borderRadius: 8,
                border: "1px solid #F59E0B",
                backgroundColor: "#FFFBEB",
                color: "#B45309",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              不同意并反馈
            </button>
          </div>
        </>
      )}

      {stageKey === "published" && (
        <>
          {labelRow(
            "视频",
            publishedLink ? (
              <a href={publishedLink} target="_blank" rel="noreferrer" style={{ color: "#4F46E5" }}>
                {publishedLink}
              </a>
            ) : (
              "—"
            )
          )}
          {labelRow(
            "播放 / 赞 / 评",
            `${formatInfluencerStat(item.views)} / ${formatInfluencerStat(item.likes)} / ${formatInfluencerStat(item.comments)}`
          )}
          {labelRow("CPM", item.cpm != null ? String(item.cpm) : "—")}
        </>
      )}
    </div>
  );
}

export default function HomePage() {
  // 统一的初始状态（服务端和客户端一致）
  const defaultMessage = cloneWelcomeMessages();


  const [messages, setMessages] = useState(defaultMessage);
  // 初始化 context，包含 workflowState
  const [context, setContext] = useState({
    workflowState: "idle", // 初始状态为空闲
  });
  const [mounted, setMounted] = useState(false);
  const [imageErrors, setImageErrors] = useState({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState({}); // 记录哪些消息的思考过程已展开
  const [thinkingMode, setThinkingMode] = useState({}); // 记录每个消息的思考模式：'simple' | 'detailed'
  const isDevelopment = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'); // 开发环境标识
  const messagesEndRef = useRef(null);
  const shouldAutoScrollRef = useRef(true); // 是否应该自动滚动
  const chatContainerRef = useRef(null); // 聊天容器的引用
  const localStorageSaveTimerRef = useRef(null); // localStorage 保存节流定时器（避免流式更新时频繁 JSON.stringify 卡顿）
  const sseDebugRef = useRef({ influencerCount: 0, analyzing: null, lastDetailLen: 0 }); // SSE 调试用（仅本地）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false); // 左侧菜单栏是否收起
  const [middlePanelWidth, setMiddlePanelWidth] = useState(50); // 中间面板宽度百分比（默认50%）
  const isResizingRef = useRef(false); // 是否正在左右调整大小
  const resizeStartXRef = useRef(0); // 开始调整时的鼠标X坐标
  const resizeStartWidthRef = useRef(50); // 开始调整时的中间面板宽度
  const [rightPanelSplit, setRightPanelSplit] = useState(50); // 右侧面板上下区域划分百分比
  const isVerticalResizingRef = useRef(false); // 是否正在上下拖拽
  const verticalResizeStartYRef = useRef(0); // 上下拖拽开始的 Y 坐标
  const verticalResizeStartSplitRef = useRef(50); // 上下拖拽开始时的百分比
  const [executionStatus, setExecutionStatus] = useState(null); // 执行阶段右侧「执行进度」数据
  const [executionLoading, setExecutionLoading] = useState(false);
  const [executionError, setExecutionError] = useState(null);
  const [executionConfig, setExecutionConfig] = useState(null); // 执行阶段右侧「工作笔记」用到的执行节奏 & 汇报配置
  const [executionConfigError, setExecutionConfigError] = useState(null);
  const [execPatchingId, setExecPatchingId] = useState(null); // 执行进度 PATCH 中的红人 id
  const [keywordWorkNotes, setKeywordWorkNotes] = useState([]); // 执行阶段关键词任务简版工作笔记
  const [activeExecutionStage, setActiveExecutionStage] = useState("pendingPrice"); // 执行进度当前选中的阶段
  const [binComputerView, setBinComputerView] = useState("overview"); // 执行阶段：执行总览 / 工作实况
  const [workLiveUnreadCount, setWorkLiveUnreadCount] = useState(0); // 工作实况页签未读提醒
  const binComputerViewRef = useRef("overview");
  const workLiveAutoSwitchedRef = useRef(false); // 本轮是否已自动切到工作实况
  const workLiveUserPinnedOverviewRef = useRef(false); // 本轮用户是否手动切回执行总览
  const workLiveEventSourceRef = useRef(null); // 执行阶段工作实况 SSE（对齐 /api/chat 事件）
  const [campaignSessions, setCampaignSessions] = useState([]); // Campaign 草稿列表
  const [publishedSessions, setPublishedSessions] = useState([]); // 已发布 Campaign 列表
  const [currentSessionId, setCurrentSessionId] = useState(null); // 当前会话 ID
  const [loadingSessions, setLoadingSessions] = useState(false); // 加载草稿列表状态
  const [sessionsError, setSessionsError] = useState(null); // 加载草稿列表的错误信息
  const [sessionRowHoverId, setSessionRowHoverId] = useState(null);
  const [sessionRowMenuId, setSessionRowMenuId] = useState(null);
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [renameInputValue, setRenameInputValue] = useState("");
  const renameInputRef = useRef(null);
  const renameBaselineRef = useRef({ id: null, title: "" });
  const renameValueRef = useRef("");
  const renamingSessionIdRef = useRef(null);
  const ignoreRenameBlurRef = useRef(false);

  const [authUser, setAuthUser] = useState(null); // { companyName, username, isAdmin } | null
  const [authChecked, setAuthChecked] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginCompany, setLoginCompany] = useState("");
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const pendingSendRef = useRef(null); // 未登录拦截发送后，登录成功自动重试
  /** 已登录即显示左侧栏（退出 / 管理员入口在侧栏底部，不再使用顶栏） */
  const showCampaignSidebar = Boolean(authUser);
  const prevSidForSidebarRef = useRef(null);

  // 从「无会话」进入「有会话」时左侧栏默认展开
  useEffect(() => {
    if (authUser && currentSessionId != null && prevSidForSidebarRef.current == null) {
      setSidebarCollapsed(false);
    }
    prevSidForSidebarRef.current = currentSessionId;
  }, [authUser, currentSessionId]);

  useEffect(() => {
    if (!sessionRowMenuId) return;
    const onDown = (e) => {
      const root = document.querySelector(`[data-session-menu-root="${sessionRowMenuId}"]`);
      if (root && !root.contains(e.target)) {
        setSessionRowMenuId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [sessionRowMenuId]);

  useEffect(() => {
    renamingSessionIdRef.current = renamingSessionId;
  }, [renamingSessionId]);

  useEffect(() => {
    if (!renamingSessionId) return;
    const id = requestAnimationFrame(() => {
      const el = renameInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [renamingSessionId]);

  // 输入框自适应高度（欢迎页大输入框 + 底部输入框共用同一输入值）
  const inputTextAreaRefMain = useAutoResizeTextArea(input, 220);
  const inputTextAreaRefFooter = useAutoResizeTextArea(input, 220);
  const isExecutionPhaseGlobal =
    context?.workflowState === "published" || context?.published === true;

  useEffect(() => {
    binComputerViewRef.current = binComputerView;
  }, [binComputerView]);

  useEffect(() => {
    if (!isExecutionPhaseGlobal) {
      setBinComputerView("overview");
      setWorkLiveUnreadCount(0);
      setKeywordWorkNotes([]);
      workLiveAutoSwitchedRef.current = false;
      workLiveUserPinnedOverviewRef.current = false;
    }
  }, [isExecutionPhaseGlobal]);

  // 已发布 campaign：订阅工作实况 SSE（与红人画像阶段 /api/chat 相同：thinking + screenshot）
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!isExecutionPhaseGlobal || !currentSessionId) {
      if (workLiveEventSourceRef.current) {
        workLiveEventSourceRef.current.close();
        workLiveEventSourceRef.current = null;
      }
      setKeywordWorkNotes([]);
      return;
    }

    const url = `/api/sessions/${currentSessionId}/work-live`;
    const es = new EventSource(url);
    workLiveEventSourceRef.current = es;

    let pendingThinking = null;
    let flushTimer = null;

    const applyThinking = (d) => {
      setMessages((prev) => {
        const updated = [...prev];
        let idx = updated.length - 1;
        if (idx < 0 || updated[idx].role !== "assistant") {
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === "assistant") {
              idx = i;
              break;
            }
          }
        }
        if (idx < 0 || updated[idx].role !== "assistant") return prev;
        const currentThinking = updated[idx].thinking || {};
        const newThinking = {
          ...currentThinking,
          ...d,
          browserSteps:
            d.browserSteps !== undefined
              ? d.browserSteps
              : currentThinking.browserSteps || [],
          screenshots:
            d.screenshots !== undefined
              ? d.screenshots
              : currentThinking.screenshots || [],
          influencerAnalyses:
            d.influencerAnalyses !== undefined
              ? (Array.isArray(d.influencerAnalyses)
                  ? d.influencerAnalyses.slice(-1)
                  : d.influencerAnalyses)
              : (Array.isArray(currentThinking.influencerAnalyses)
                  ? currentThinking.influencerAnalyses.slice(-1)
                  : currentThinking.influencerAnalyses || []),
          workNotes:
            d.workNotes !== undefined
              ? d.workNotes
              : currentThinking.workNotes || [],
        };
        updated[idx] = { ...updated[idx], thinking: newThinking };
        return updated;
      });

      if (binComputerViewRef.current !== "live") {
        setWorkLiveUnreadCount((c) => Math.min(c + 1, 99));
      }
      if (
        !workLiveAutoSwitchedRef.current &&
        !workLiveUserPinnedOverviewRef.current
      ) {
        setBinComputerView("live");
        setWorkLiveUnreadCount(0);
        workLiveAutoSwitchedRef.current = true;
      }
    };

    const scheduleThinkingFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (pendingThinking) {
          const current = pendingThinking;
          pendingThinking = null;
          applyThinking(current);
        }
      }, 1200);
    };

    es.addEventListener("message", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "ready" || data.type === "heartbeat") return;

        if (data.type === "thinking") {
          pendingThinking = data.data || {};
          scheduleThinkingFlush();
        } else if (data.type === "work_note_keyword_summary" && data.data) {
          const note = data.data;
          setKeywordWorkNotes((prev) => {
            const merged = [...(Array.isArray(prev) ? prev : [])];
            const key = workNoteMergeKey(note);
            const idx = merged.findIndex((x) => workNoteMergeKey(x) === key);
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], ...note };
            } else {
              merged.push(note);
            }
            merged.sort(
              (a, b) =>
                new Date(a?.time || 0).getTime() - new Date(b?.time || 0).getTime()
            );
            return merged.slice(-60);
          });
          setMessages((prev) => {
            const updated = [...prev];
            let idx = updated.length - 1;
            if (idx < 0 || updated[idx].role !== "assistant") {
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].role === "assistant") {
                  idx = i;
                  break;
                }
              }
            }
            if (idx < 0 || updated[idx].role !== "assistant") return prev;
            const currentThinking = updated[idx].thinking || {};
            const existing = Array.isArray(currentThinking.workNotes) ? currentThinking.workNotes : [];
            const merged = [...existing];
            const key = workNoteMergeKey(note);
            const foundIdx = merged.findIndex((x) => workNoteMergeKey(x) === key);
            if (foundIdx >= 0) {
              merged[foundIdx] = { ...merged[foundIdx], ...note };
            } else {
              merged.push(note);
            }
            merged.sort((a, b) => new Date(a?.time || 0).getTime() - new Date(b?.time || 0).getTime());
            updated[idx] = {
              ...updated[idx],
              thinking: {
                ...currentThinking,
                workNotes: merged.slice(-60),
              },
            };
            return updated;
          });
        } else if (data.type === "screenshot" && data.data) {
          const newShot = data.data;
          setMessages((prev) => {
            const updated = [...prev];
            let idx = updated.length - 1;
            if (idx < 0 || updated[idx].role !== "assistant") {
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].role === "assistant") {
                  idx = i;
                  break;
                }
              }
            }
            if (idx < 0 || updated[idx].role !== "assistant") return prev;
            const currentThinking = updated[idx].thinking || {};
            updated[idx] = {
              ...updated[idx],
              thinking: {
                ...currentThinking,
                screenshots: [newShot],
              },
            };
            return updated;
          });
        }
      } catch {
        // ignore malformed SSE payloads
      }
    });

    es.onerror = () => {
      try {
        es.close();
      } catch {
        // ignore
      }
      if (workLiveEventSourceRef.current === es) {
        workLiveEventSourceRef.current = null;
      }
    };

    return () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      try {
        es.close();
      } catch {
        // ignore
      }
      if (workLiveEventSourceRef.current === es) {
        workLiveEventSourceRef.current = null;
      }
    };
  }, [isExecutionPhaseGlobal, currentSessionId]);

  const handleBinComputerViewChange = (nextView, manual = true) => {
    setBinComputerView(nextView);
    if (nextView === "live") {
      setWorkLiveUnreadCount(0);
      // 用户主动打开工作实况后，允许后续新一轮继续自动切换
      if (manual) {
        workLiveUserPinnedOverviewRef.current = false;
      }
    }
    if (manual && nextView === "overview") {
      // 用户本轮明确想看执行总览，不再强制自动切换
      workLiveUserPinnedOverviewRef.current = true;
    }
  };

  // 加载 Campaign 会话列表（草稿 + 已发布）；成功时返回最新列表供删除后切换会话等逻辑使用
  const loadCampaignSessions = async ({ silent = false } = {}) => {
    const fail = { ok: false, drafts: [], published: [] };
    try {
      if (!silent) {
        setLoadingSessions(true);
        setSessionsError(null);
      }

      // 1）加载草稿
      const draftResponse = await fetch('/api/sessions?status=draft&limit=50', {
        credentials: 'include',
      });
      if (draftResponse.status === 401) {
        setCampaignSessions([]);
        setPublishedSessions([]);
        setAuthUser(null);
        setCurrentSessionId(null);
        try {
          if (typeof window !== "undefined") {
            localStorage.removeItem(STORAGE_KEY_CURRENT_SESSION_ID);
          }
        } catch (_) {
          /* ignore */
        }
        if (!silent) setLoadingSessions(false);
        return { ...fail, loggedOut: true };
      }
      if (!draftResponse.ok) {
        const errorData = await draftResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${draftResponse.status}: ${draftResponse.statusText}`);
      }
      const draftData = await draftResponse.json();

      // 2）加载已发布（出错不影响草稿展示）
      let publishedData = { success: false, sessions: [] };
      try {
        const publishedResponse = await fetch('/api/sessions?status=published&limit=50', {
          credentials: 'include',
        });
        if (publishedResponse.ok) {
          publishedData = await publishedResponse.json();
        }
      } catch (e) {
        console.warn('[HomePage] 加载已发布会话失败（忽略，仅影响「已发布 Campaign」区块）:', e);
      }

      if (draftData.success) {
        const drafts = draftData.sessions || [];
        const published = publishedData.success ? (publishedData.sessions || []) : [];
        setCampaignSessions(drafts);
        setPublishedSessions(published);
        if (!silent) setLoadingSessions(false);
        return { ok: true, drafts, published };
      }
      // 如果是表不存在的错误，显示更友好的提示
      if (draftData.code === 'TABLE_NOT_EXISTS') {
        throw new Error('数据库表未创建，请先执行创建表的 SQL');
      }
      throw new Error(draftData.error || '获取草稿列表失败');
    } catch (error) {
      console.error('[HomePage] 加载会话列表失败:', error);
      if (!silent) {
        setSessionsError(error.message || '加载失败，请检查数据库连接');
        setCampaignSessions([]);
        setPublishedSessions([]);
      }
      if (!silent) setLoadingSessions(false);
      return fail;
    }
  };

  // 登录态（HttpOnly Cookie）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/me", { credentials: "include" });
        const d = await r.json().catch(() => ({}));
        if (!cancelled && d.success && d.user) setAuthUser(d.user);
      } catch {
        /* ignore */
      }
      if (!cancelled) setAuthChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    loadCampaignSessions();
  }, [authChecked]);

  // 已登录后：若 localStorage 恢复的会话不属于当前账号（或已删除），清空以免沿用他人会话 id / 超长 messages 导致创建会话失败
  useEffect(() => {
    if (!authChecked || !authUser || !currentSessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${currentSessionId}`, { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.success && data.session) return;
        clearChatPersistenceKeys();
        setCurrentSessionId(null);
        setMessages(cloneWelcomeMessages());
        setContext({ workflowState: "idle" });
      } catch {
        if (cancelled) return;
        clearChatPersistenceKeys();
        setCurrentSessionId(null);
        setMessages(cloneWelcomeMessages());
        setContext({ workflowState: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authChecked, authUser, currentSessionId]);

  // 客户端挂载后从 localStorage 恢复数据，并加载草稿列表
  useEffect(() => {
    setMounted(true);

    if (typeof window !== "undefined") {
      const savedVersion = localStorage.getItem(STORAGE_KEY_VERSION);
      
      // 如果版本不匹配，清除旧数据并使用新的 defaultMessage
      if (savedVersion !== MESSAGE_VERSION) {
        console.log(`[HomePage] 消息版本不匹配 (${savedVersion} → ${MESSAGE_VERSION})，清除旧数据`);
        try {
          localStorage.removeItem(STORAGE_KEY_MESSAGES);
          localStorage.removeItem(STORAGE_KEY_CONTEXT);
          localStorage.removeItem(STORAGE_KEY_CURRENT_SESSION_ID);
          localStorage.setItem(STORAGE_KEY_VERSION, MESSAGE_VERSION);
        } catch (error) {
          console.error('[HomePage] 清除 localStorage 失败:', error);
        }
        setMessages(defaultMessage);
        setContext({});
        return;
      }
      
      // 恢复消息（带错误处理）
      try {
        const savedMessages = localStorage.getItem(STORAGE_KEY_MESSAGES);
        if (savedMessages) {
          try {
            const parsed = JSON.parse(savedMessages);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setMessages(parsed);
            }
          } catch (e) {
            console.error("[HomePage] 恢复消息失败:", e);
            // 如果解析失败，清除损坏的数据
            try {
              localStorage.removeItem(STORAGE_KEY_MESSAGES);
            } catch (clearError) {
              console.error("[HomePage] 清除损坏的消息数据失败:", clearError);
            }
          }
        }
      } catch (error) {
        console.error("[HomePage] 读取消息数据失败:", error);
      }

      // 恢复上下文（带错误处理）
      try {
        const savedContext = localStorage.getItem(STORAGE_KEY_CONTEXT);
        if (savedContext) {
          try {
            const parsed = JSON.parse(savedContext);
            if (parsed && typeof parsed === "object") {
              // 确保 workflowState 存在，如果不存在则设置为 "idle"
              if (!parsed.workflowState) {
                parsed.workflowState = "idle";
              }
              setContext(parsed);
            }
          } catch (e) {
            console.error("[HomePage] 恢复上下文失败:", e);
            // 如果解析失败，清除损坏的数据
            try {
              localStorage.removeItem(STORAGE_KEY_CONTEXT);
            } catch (clearError) {
              console.error("[HomePage] 清除损坏的上下文数据失败:", clearError);
            }
          }
        }
      } catch (error) {
        console.error("[HomePage] 读取上下文数据失败:", error);
      }

      // 恢复当前选中的会话 ID（与消息/上下文一并持久化；仅内存会导致刷新后侧栏消失）
      try {
        const raw = localStorage.getItem(STORAGE_KEY_CURRENT_SESSION_ID);
        if (raw) {
          const sid = String(raw).trim();
          if (sid.length > 0 && sid.length <= 128) {
            setCurrentSessionId(sid);
          }
        }
      } catch (e) {
        console.error("[HomePage] 恢复当前会话 ID 失败:", e);
      }
    }
  }, []);

  // 将当前会话 ID 写入 localStorage（须在客户端 mounted 之后，避免与首次恢复竞态清空）
  useEffect(() => {
    if (typeof window === "undefined" || !mounted) return;
    try {
      if (currentSessionId) {
        localStorage.setItem(STORAGE_KEY_CURRENT_SESSION_ID, String(currentSessionId));
      } else {
        localStorage.removeItem(STORAGE_KEY_CURRENT_SESSION_ID);
      }
    } catch (e) {
      console.warn("[HomePage] 同步当前会话 ID 到 localStorage 失败:", e);
    }
  }, [currentSessionId, mounted]);

  // 保存当前会话到后端（如果存在 currentSessionId）
  // options.reloadSessions: 是否在保存成功后刷新左侧会话列表（默认 false，避免每次回复造成左侧闪烁）
  // 不传 title：标题仅由创建会话、侧栏重命名等显式写入；避免保存消息/切换会话时按首条用户消息覆盖改名
  const saveCurrentSession = React.useCallback(async (options = { reloadSessions: false }) => {
    if (!currentSessionId) return;
    
    try {
      const response = await fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.slice(-50), // 只保存最近 50 条
          context,
        }),
      });
      
      const data = await response.json();
      if (data.success && options.reloadSessions !== false) {
        // 更新本地草稿列表（可选，避免在仅切换会话时造成左侧闪烁）
        await loadCampaignSessions();
      }
    } catch (error) {
      console.error('[HomePage] 保存会话失败:', error);
    }
  }, [currentSessionId, messages, context, loadCampaignSessions]);

  // 保存消息到 localStorage（带错误处理和存储限制）
  useEffect(() => {
    if (typeof window === "undefined" || !mounted) return;

    // 先清掉上一次的定时器（messages 变化频率高，避免堆积）
    if (localStorageSaveTimerRef.current) {
      clearTimeout(localStorageSaveTimerRef.current);
      localStorageSaveTimerRef.current = null;
    }

    // 流式输出期间 messages 变化频率极高，频繁 JSON.stringify 会造成 UI 卡顿/看起来“流式中断”
    // 这里直接跳过，等 complete 后（loading=false）再保存一次即可
    if (loading) return;

    // 节流：合并短时间内的多次更新
    localStorageSaveTimerRef.current = setTimeout(() => {
      try {
        // 限制存储的消息数量（只保存最近的 50 条消息）
        const messagesToSave = messages.slice(-50);
        
        // 清理消息中的大对象（截图等），避免超出配额
        const cleanedMessages = messagesToSave.map(msg => {
          const cleaned = { ...msg };
          // 移除截图数据（太大，不需要持久化）
          if (cleaned.thinking?.screenshots) {
            cleaned.thinking = {
              ...cleaned.thinking,
              screenshots: [] // 不保存截图到 localStorage
            };
          }
          // 移除 browserSteps（流式分析文本会非常大；真正的持久化依赖后端 session）
          if (cleaned.thinking?.browserSteps) {
            cleaned.thinking = {
              ...cleaned.thinking,
              browserSteps: []
            };
          }
          if (cleaned.thinking?.influencerAnalyses) {
            cleaned.thinking = {
              ...cleaned.thinking,
              influencerAnalyses: []
            };
          }
          return cleaned;
        });
        
        const messagesJson = JSON.stringify(cleanedMessages);
        
        // 检查数据大小（localStorage 限制通常是 5-10MB）
        if (messagesJson.length > 4 * 1024 * 1024) { // 4MB 限制
          console.warn('[HomePage] 消息数据过大，只保存最近的 30 条消息');
          const limitedMessages = cleanedMessages.slice(-30);
          localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(limitedMessages));
        } else {
          localStorage.setItem(STORAGE_KEY_MESSAGES, messagesJson);
        }
      } catch (error) {
        if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
          console.warn('[HomePage] localStorage 配额已满，尝试清理并只保存最近的 20 条消息');
          try {
            // 尝试清理并只保存最近的消息，移除所有截图以节省空间
            const limitedMessages = messages.slice(-20).map(msg => {
              const cleaned = { ...msg };
              if (cleaned.thinking?.screenshots) {
                cleaned.thinking = { ...cleaned.thinking, screenshots: [] };
              }
              if (cleaned.thinking?.influencerAnalyses) {
                cleaned.thinking = { ...cleaned.thinking, influencerAnalyses: [] };
              }
              return cleaned;
            });
            localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(limitedMessages));
          } catch (retryError) {
            console.error('[HomePage] 无法保存消息到 localStorage:', retryError);
            // 如果还是失败，清除所有数据并重新开始
            try {
              localStorage.removeItem(STORAGE_KEY_MESSAGES);
              localStorage.removeItem(STORAGE_KEY_CONTEXT);
              localStorage.removeItem(STORAGE_KEY_CURRENT_SESSION_ID);
            } catch (clearError) {
              console.error('[HomePage] 无法清除 localStorage:', clearError);
            }
          }
        } else {
          console.error('[HomePage] 保存消息到 localStorage 失败:', error);
        }
      }
    }, 400);

    return () => {
      if (localStorageSaveTimerRef.current) {
        clearTimeout(localStorageSaveTimerRef.current);
        localStorageSaveTimerRef.current = null;
      }
    };
  }, [messages, mounted, loading]);

  // 保存上下文到 localStorage（带错误处理）
  useEffect(() => {
    if (typeof window !== "undefined" && mounted) {
      try {
        const contextJson = JSON.stringify(context);
        localStorage.setItem(STORAGE_KEY_CONTEXT, contextJson);
      } catch (error) {
        if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
          console.warn('[HomePage] localStorage 配额已满，无法保存上下文');
          // 尝试清除旧数据
          try {
            localStorage.removeItem(STORAGE_KEY_CONTEXT);
          } catch (clearError) {
            console.error('[HomePage] 无法清除上下文数据:', clearError);
          }
        } else {
          console.error('[HomePage] 保存上下文到 localStorage 失败:', error);
        }
      }
    }
  }, [context, mounted]);

  // 在「执行阶段」（已发布）加载执行进度数据
  useEffect(() => {
    const campaignId = context?.campaignId;
    const isExecutionPhase =
      context?.workflowState === "published" || context?.published === true;

    if (!campaignId || !isExecutionPhase) {
      // 非执行阶段或没有 campaignId 时，清空执行进度状态
      setExecutionStatus(null);
      setExecutionError(null);
      setExecutionLoading(false);
      return;
    }

    let cancelled = false;

    const loadExecutionStatus = async () => {
      try {
        setExecutionLoading(true);
        setExecutionError(null);
        const res = await fetch(`/api/campaigns/${campaignId}/execution-status`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          if (data.success) {
            setExecutionStatus(data);
          } else {
            setExecutionError(data.error || "获取执行进度失败");
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[HomePage] 获取执行进度失败:", e);
          setExecutionError(e.message || "获取执行进度失败");
        }
      } finally {
        if (!cancelled) {
          setExecutionLoading(false);
        }
      }
    };

    loadExecutionStatus();

    return () => {
      cancelled = true;
    };
  }, [context?.campaignId, context?.workflowState, context?.published]);

  // 在「执行阶段」加载执行节奏 & 汇报配置（用于工作笔记）
  useEffect(() => {
    const campaignId = context?.campaignId;
    const isExecutionPhase =
      context?.workflowState === "published" || context?.published === true;

    if (!campaignId || !isExecutionPhase) {
      setExecutionConfig(null);
      setExecutionConfigError(null);
      return;
    }

    let cancelled = false;

    const loadReportConfig = async () => {
      try {
        setExecutionConfigError(null);
        const res = await fetch(`/api/campaigns/${campaignId}/report-config`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          if (data.success) {
            setExecutionConfig(data);
          } else {
            setExecutionConfigError(data.error || "获取执行配置失败");
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[HomePage] 获取执行配置失败:", e);
          setExecutionConfigError(e.message || "获取执行配置失败");
        }
      }
    };

    loadReportConfig();

    return () => {
      cancelled = true;
    };
  }, [context?.campaignId, context?.workflowState, context?.published]);

  // 在「执行阶段」预加载工作笔记历史（先历史后实时）
  useEffect(() => {
    const campaignId = context?.campaignId;
    const isExecutionPhase =
      context?.workflowState === "published" || context?.published === true;

    if (!campaignId || !isExecutionPhase) {
      setKeywordWorkNotes([]);
      return;
    }

    let cancelled = false;

    const loadWorkNotes = async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/work-notes?limit=50`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled || !data?.success) return;
        const incoming = Array.isArray(data.notes) ? data.notes : [];
        setKeywordWorkNotes((prev) => {
          const merged = [...(Array.isArray(prev) ? prev : [])];
          for (const note of incoming) {
            const key = workNoteMergeKey(note);
            const idx = merged.findIndex((x) => workNoteMergeKey(x) === key);
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], ...note };
            } else {
              merged.push(note);
            }
          }
          merged.sort(
            (a, b) =>
              new Date(a?.time || 0).getTime() - new Date(b?.time || 0).getTime()
          );
          return merged.slice(-60);
        });
      } catch (e) {
        if (!cancelled) {
          console.error("[HomePage] 获取工作笔记历史失败:", e);
        }
      }
    };

    loadWorkNotes();

    return () => {
      cancelled = true;
    };
  }, [context?.campaignId, context?.workflowState, context?.published]);

  const refreshExecutionStatusQuiet = useCallback(async () => {
    const cid = context?.campaignId;
    if (!cid) return;
    try {
      const res = await fetch(`/api/campaigns/${cid}/execution-status`);
      const data = await res.json();
      if (data.success) setExecutionStatus(data);
    } catch (e) {
      console.error("[HomePage] 刷新执行进度失败:", e);
    }
  }, [context?.campaignId]);

  const patchExecution = useCallback(
    async (action, influencerId, payload = {}) => {
      const cid = context?.campaignId;
      if (!cid) return;
      setExecPatchingId(influencerId);
      try {
        const res = await fetch(`/api/campaigns/${cid}/execution`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ influencerId, action, payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "更新失败");
        await refreshExecutionStatusQuiet();
      } catch (err) {
        console.error(err);
        alert(err.message || "更新失败");
      } finally {
        setExecPatchingId(null);
      }
    },
    [context?.campaignId, refreshExecutionStatusQuiet]
  );

  // 智能自动滚动：只在用户发送消息或AI开始新回复时滚动，不在步骤更新时滚动
  useEffect(() => {
    // 只在应该自动滚动时执行
    if (shouldAutoScrollRef.current && messagesEndRef.current) {
      // 检查用户是否手动滚动到了顶部（查看历史消息）
      if (chatContainerRef.current) {
        const container = chatContainerRef.current;
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200; // 距离底部200px内
        // 如果用户不在底部附近，说明在查看历史消息，不自动滚动
        if (!isNearBottom) {
          return;
        }
      }
      // 延迟一点执行滚动，确保DOM已更新
      setTimeout(() => {
        if (messagesEndRef.current && shouldAutoScrollRef.current) {
          messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
      }, 50);
    }
  }, [messages]);

  async function handleSend(e) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    if (!authChecked) return;
    const trimmed = input.trim();
    if (!authUser) {
      pendingSendRef.current = trimmed;
      setLoginOpen(true);
      return;
    }
    await runChatSend(trimmed);
  }

  async function runChatSend(trimmedContent) {
    // 用户发送消息时，启用自动滚动
    shouldAutoScrollRef.current = true;

    const userMessage = {
      role: "user",
      content: trimmedContent
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    // 新一轮请求开始：允许本轮自动切一次「工作实况」
    workLiveAutoSwitchedRef.current = false;
    workLiveUserPinnedOverviewRef.current = false;

    // 创建助手消息占位符，用于实时更新
    const assistantMessageIndex = nextMessages.length;
    const initialAssistantMessage = {
      role: "assistant",
      name: "Bin",
      content: "",
      thinking: {
        steps: [],
        currentState: context.workflowState || "idle",
        nextState: null,
        toolCall: null,
        subAgentResult: null,
        browserSteps: [], // 初始化浏览器步骤
        screenshots: [], // 初始化截图
      },
      isThinkingExpanded: true // 默认展开思考过程（Cursor 风格）
    };
    setMessages([...nextMessages, initialAssistantMessage]);

    // 与本轮请求绑定的会话 ID（新建会话时 setState 尚未生效，不能依赖闭包里的 currentSessionId）
    let sessionIdForChat = currentSessionId;

    try {
      // 如果还没有会话 ID，创建新会话
      if (!sessionIdForChat) {
        try {
          const title = trimmedContent.slice(0, 50) || '新 Campaign';
          const createRes = await fetch('/api/sessions', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              messages: nextMessages,
              context,
              status: 'draft',
            }),
          });
          let createData = {};
          try {
            createData = await createRes.json();
          } catch {
            createData = {};
          }
          if (createData.success && createData.session?.id) {
            sessionIdForChat = createData.session.id;
            setCurrentSessionId(createData.session.id);
            await loadCampaignSessions();
          } else {
            const errMsg =
              createData.error ||
              createData.message ||
              (!createRes.ok ? `HTTP ${createRes.status}` : "创建会话未返回成功");
            console.error("[HomePage] 创建会话失败:", errMsg, createRes.status, createData);
            window.alert(
              `无法创建会话，不能发起对话。\n\n原因：${errMsg}\n\n若刚换账号登录，请关闭本提示后重试；仍失败请联系管理员查看服务日志。`
            );
          }
        } catch (error) {
          console.error('[HomePage] 创建会话失败:', error);
          window.alert(
            `无法创建会话（网络或服务器异常）：${error?.message || String(error)}\n\n请稍后重试。`
          );
        }
      }

      if (!sessionIdForChat) {
        setMessages((prev) => {
          const updated = [...prev];
          if (updated[assistantMessageIndex]) {
            updated[assistantMessageIndex] = {
              ...updated[assistantMessageIndex],
              content: '无法发起对话：缺少会话 ID。请刷新后重试。',
            };
          }
          return updated;
        });
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: nextMessages,
          context,
          sessionId: sessionIdForChat,
          stream: true // 启用流式传输
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "请求失败");
      }

      // 检查是否是流式响应
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("text/event-stream")) {
        // 流式接收数据
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || ""; // 保留最后一个不完整的行

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.type === "thinking") {
                  // 本地调试日志：观察流式分析是否持续推进、累计了几位红人
                  if (isDevelopment) {
                    try {
                      const currentCount = Array.isArray(data.data?.influencerAnalyses) ? data.data.influencerAnalyses.length : 0;
                      if (currentCount !== sseDebugRef.current.influencerCount) {
                        console.log(`[SSE] influencerAnalyses 累计更新: ${sseDebugRef.current.influencerCount} → ${currentCount}`);
                        sseDebugRef.current.influencerCount = currentCount;
                      }
                      const steps = Array.isArray(data.data?.browserSteps) ? data.data.browserSteps : [];
                      const analyzeStep = steps.find(s => s && s.id === 'analyze_match');
                      const analyzing = analyzeStep?.stats?.analyzing || null;
                      if (analyzing && analyzing !== sseDebugRef.current.analyzing) {
                        console.log(`[SSE] 开始/切换分析对象: @${analyzing}`);
                        sseDebugRef.current.analyzing = analyzing;
                        sseDebugRef.current.lastDetailLen = 0;
                      }
                      const detailLen = typeof analyzeStep?.detail === 'string' ? analyzeStep.detail.length : 0;
                      if (detailLen - sseDebugRef.current.lastDetailLen >= 800) {
                        console.log(`[SSE] analyze_match.detail 增长: ${sseDebugRef.current.lastDetailLen} → ${detailLen}`);
                        sseDebugRef.current.lastDetailLen = detailLen;
                      }
                    } catch (e) {
                      // ignore
                    }
                  }
                  // 更新思考过程（合并数据，保留 browserSteps、screenshots、influencerAnalyses）
                  setMessages(prev => {
                    const updated = [...prev];
                    if (updated[assistantMessageIndex]) {
                      const currentThinking = updated[assistantMessageIndex].thinking || {};
                      const newThinking = {
                        ...currentThinking,
                        ...data.data,
                        browserSteps: data.data.browserSteps !== undefined 
                          ? data.data.browserSteps 
                          : (currentThinking.browserSteps || []),
                        screenshots: data.data.screenshots !== undefined 
                          ? data.data.screenshots 
                          : (currentThinking.screenshots || []),
                        influencerAnalyses: data.data.influencerAnalyses !== undefined
                          ? (Array.isArray(data.data.influencerAnalyses)
                              ? data.data.influencerAnalyses.slice(-1)
                              : data.data.influencerAnalyses)
                          : (Array.isArray(currentThinking.influencerAnalyses)
                              ? currentThinking.influencerAnalyses.slice(-1)
                              : currentThinking.influencerAnalyses || []),
                      };
                      
                      if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
                        if (data.data.influencerAnalyses?.length) {
                          console.log('[前端] 收到红人分析卡片更新:', data.data.influencerAnalyses.length);
                        }
                      }
                      
                      updated[assistantMessageIndex] = {
                        ...updated[assistantMessageIndex],
                        thinking: newThinking
                      };
                    }
                    return updated;
                  });

                  // 执行阶段下：收到实时步骤时，更新「工作实况」提醒，并自动切换一次到工作实况
                  if (isExecutionPhaseGlobal) {
                    if (binComputerViewRef.current !== "live") {
                      setWorkLiveUnreadCount(prev => Math.min(prev + 1, 99));
                    }
                    if (
                      !workLiveAutoSwitchedRef.current &&
                      !workLiveUserPinnedOverviewRef.current
                    ) {
                      setBinComputerView("live");
                      setWorkLiveUnreadCount(0);
                      workLiveAutoSwitchedRef.current = true;
                    }
                  }
                } else if (data.type === "complete") {
                  // 最终结果（合并 thinking，保留 browserSteps、screenshots、influencerAnalyses）
                  setMessages(prev => {
                    const updated = [...prev];
                    if (updated[assistantMessageIndex]) {
                      const currentThinking = updated[assistantMessageIndex].thinking || {};
                      const finalThinking = data.data.thinking || {};
                      updated[assistantMessageIndex] = {
                        ...updated[assistantMessageIndex],
                        content: data.data.reply,
                        thinking: {
                          ...currentThinking,
                          ...finalThinking,
                          browserSteps: finalThinking.browserSteps || currentThinking.browserSteps || [],
                          screenshots: finalThinking.screenshots || currentThinking.screenshots || [],
                          influencerAnalyses: (() => {
                            const merged = finalThinking.influencerAnalyses || currentThinking.influencerAnalyses || [];
                            return Array.isArray(merged) ? merged.slice(-1) : merged;
                          })(),
                        }
                      };
                    }
                    return updated;
                  });

                  // 更新上下文
                  if (data.data.context) {
                    setContext(data.data.context);
                  }

                  // 发布成功后刷新左侧草稿/已发布列表（服务端已把 status 置为 published）
                  if (data.data.context?.published) {
                    loadCampaignSessions({ silent: true }).catch(() => {});
                  }

                  // 消息发送完成后，更新会话（延迟保存，避免频繁请求）
                  if (currentSessionId) {
                    setTimeout(() => {
                      saveCurrentSession({ reloadSessions: false });
                    }, 1000);
                  }
                } else if (data.type === "error") {
                  throw new Error(data.data.error);
                }
              } catch (parseError) {
                console.error("解析SSE数据失败:", parseError);
              }
            }
          }
        }
      } else {
        // 非流式响应（兼容旧版本）
        const data = await res.json();

        if (data && data.reply) {
          setMessages(prev => {
            const updated = [...prev];
            if (updated[assistantMessageIndex]) {
              updated[assistantMessageIndex] = {
                ...updated[assistantMessageIndex],
                content: data.reply,
                thinking: data.thinking
              };
            }
            return updated;
          });

          if (data.context) {
            setContext(data.context);
          }
        }
      }
    } catch (err) {
      console.error('[HomePage] 请求失败:', err);
      
      // 检查是否是网络错误或连接错误（可能是刷新页面导致的）
      const isNetworkError = err.name === 'TypeError' && 
                            (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed to fetch'));
      
      // 检查消息是否已经有内容（可能是从 localStorage 恢复的）
      const currentMessage = messages[assistantMessageIndex];
      const hasContent = currentMessage?.content || 
                        (currentMessage?.thinking?.steps?.length > 0) ||
                        (currentMessage?.thinking?.browserSteps?.length > 0);
      
      // 如果是网络错误且消息已有内容，可能是刷新导致的，不显示错误
      if (isNetworkError && hasContent) {
        console.log('[HomePage] 检测到网络错误，但消息已有内容（可能是刷新页面），不显示错误');
        setLoading(false);
        return;
      }
      
      // 其他情况显示错误
      setMessages(prev => {
        const updated = [...prev];
        if (updated[assistantMessageIndex]) {
          // 检查是否已经有内容，如果有则不覆盖
          const msgHasContent = updated[assistantMessageIndex].content || 
                                (updated[assistantMessageIndex].thinking?.steps?.length > 0);
          
          if (!msgHasContent) {
            // 只有完全没有内容时才显示错误
            updated[assistantMessageIndex] = {
              ...updated[assistantMessageIndex],
              content: `抱歉，服务暂时出现问题：${err.message}。请稍后再试。`
            };
          }
        }
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }

  // 获取状态描述
  const getStateDescription = (state) => {
    if (!state) return "未知状态";
    const stateMap = {
      "idle": "空闲状态",
      "step_1_product_info": "步骤 1 - 确认产品信息",
      "step_2_campaign_info": "步骤 2 - 确认 Campaign 信息",
      "step_3_influencer_profile": "步骤 3 - 确认红人画像",
      "step_4_content_requirement": "步骤 4 - 确认内容要求",
      "step_5_publish_confirm": "步骤 5 - 确认发布",
    };
    return stateMap[state] || state;
  };

  // 计算进度
  const calculateProgress = (currentState) => {
    const stateOrder = ["idle", "step_1_product_info", "step_2_campaign_info", "step_3_influencer_profile", "step_4_content_requirement", "step_5_publish_confirm"];
    const currentIndex = stateOrder.indexOf(currentState);
    if (currentIndex === -1 || currentIndex === 0) return { current: 0, total: 5, percentage: 0 };
    const total = stateOrder.length - 1; // 排除 idle
    return {
      current: currentIndex,
      total: total,
      percentage: Math.round((currentIndex / total) * 100)
    };
  };

  // 获取步骤状态（已完成/进行中/待执行）
  const getStepStatus = (stepIndex, totalSteps, isComplete) => {
    // 如果已经完成（有最终回复），所有步骤都是已完成
    if (isComplete) {
      return 'completed';
    }
    // 最后一步是进行中，之前的步骤是已完成
    if (stepIndex === totalSteps - 1) {
      return 'running';
    }
    return 'completed';
  };

  // 术语映射：将技术术语转换为业务语言
  const translateToBusinessLanguage = (agent, action, result) => {
    const mapping = {
      "BinAgent-意图识别": {
        icon: "🔍",
        title: "分析需求",
        description: (result) => {
          if (result?.needTool) {
            const toolNames = {
              'product_info_agent': '提取产品信息',
              'campaign_info_agent': '收集投放信息',
              'influencer_profile_agent': '推荐红人',
              'content_requirement_agent': '生成内容脚本',
              'campaign_publish_agent': '汇总并确认发布'
            };
            return `已识别：需要${toolNames[result.toolName] || '处理'}`;
          }
          return "正在理解您的需求...";
        }
      },
      "AgentRouter-路由决策": {
        icon: "🔄",
        title: "处理中",
        description: (result) => {
          if (typeof result === 'string' && result.includes('product_info_agent')) return "准备提取产品信息...";
          if (typeof result === 'string' && result.includes('campaign_info_agent')) return "准备收集投放信息...";
          return "正在处理...";
        }
      },
      "ProductInfoAgent-提取产品信息": {
        icon: "📦",
        title: "提取产品信息",
        description: "正在从产品链接提取信息..."
      },
      "ProductInfoAgent-确认产品信息": {
        icon: "✅",
        title: "确认产品信息",
        description: "正在检测您是否确认产品信息..."
      },
      "CampaignInfoAgent-收集Campaign信息": {
        icon: "📊",
        title: "收集投放信息",
        description: "正在从您的消息中提取投放信息..."
      },
      "InfluencerProfileAgent-推荐红人画像和账户": {
        icon: "👥",
        title: "推荐红人",
        description: "正在基于产品信息和投放信息推荐合适的红人..."
      },
      "ContentRequirementAgent-生成内容脚本": {
        icon: "✍️",
        title: "生成内容脚本",
        description: "正在生成内容脚本要求和参考视频..."
      },
      "CampaignPublishAgent-汇总并确认发布": {
        icon: "📋",
        title: "汇总信息",
        description: "正在汇总所有信息并确认发布..."
      },
      "AgentRouter-状态更新": {
        icon: "➡️",
        title: "步骤完成",
        description: (result) => result || "进入下一步"
      },
      "AgentRouter-状态自动更新": {
        icon: "➡️",
        title: "自动推进",
        description: (result) => result || "状态自动更新"
      },
      "AgentRouter-引导消息": {
        icon: "💡",
        title: "引导提示",
        description: "检测到引导消息，保持当前状态"
      },
      "BinAgent-直接回复": {
        icon: "💬",
        title: "直接回复",
        description: "无需调用工具，直接回复您"
      }
    };

    const key = `${agent}-${action}`;
    const mapped = mapping[key];
    
    if (mapped) {
      return {
        ...mapped,
        description: typeof mapped.description === 'function' 
          ? mapped.description(result) 
          : mapped.description
      };
    }

    // 默认返回
    return {
      icon: "⚙️",
      title: action,
      description: typeof result === 'string' ? result : "处理中..."
    };
  };

  // 渲染消息内容，支持图片显示
  function renderMessageContent(content) {
    if (!content) return content;
    
    // 同时匹配图片标记 [IMAGE:url]、Markdown 链接 [text](url) 和红人账户标记 [INFLUENCER:...]
    const imageRegex = /\[IMAGE:(.+?)\]/g;
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    // 使用更宽松的正则，允许空值和特殊字符，使用非贪婪匹配
    // 格式: [INFLUENCER:avatar:url:platform:id:name:followers:views:reason:isRecommended:analysis]
    const influencerRegex = /\[INFLUENCER:([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^\]]*?)\]/g;
    const parts = [];
    let lastIndex = 0;
    let partIndex = 0;
    
    // 收集所有匹配项（图片、链接和红人账户）
    const matches = [];
    
    // 匹配图片
    let match;
    while ((match = imageRegex.exec(content)) !== null) {
      matches.push({
        type: 'image',
        index: match.index,
        length: match[0].length,
        url: match[1],
        fullMatch: match[0]
      });
    }
    
    // 匹配链接
    linkRegex.lastIndex = 0; // 重置正则
    while ((match = linkRegex.exec(content)) !== null) {
      matches.push({
        type: 'link',
        index: match.index,
        length: match[0].length,
        text: match[1],
        url: match[2],
        fullMatch: match[0]
      });
    }
    
    // 匹配红人账户
    influencerRegex.lastIndex = 0; // 重置正则
    while ((match = influencerRegex.exec(content)) !== null) {
      matches.push({
        type: 'influencer',
        index: match.index,
        length: match[0].length,
        avatar: match[1],
        profileUrl: match[2],
        platform: match[3],
        id: match[4],
        name: match[5],
        followers: match[6],
        views: match[7],
        reason: match[8],
        isRecommended: match[9] === '1' ? true : (match[9] === '0' ? false : null),
        analysis: match[10] ? match[10].replace(/；/g, ':') : null, // 恢复冒号
        fullMatch: match[0]
      });
    }
    
    // 按索引排序
    matches.sort((a, b) => a.index - b.index);
    
    // 分离influencer匹配和其他匹配
    const influencerMatches = matches.filter(m => m.type === 'influencer');
    const otherMatches = matches.filter(m => m.type !== 'influencer');
    
    // 先处理非influencer的匹配
    for (const match of otherMatches) {
      // 添加匹配前的文本
      if (match.index > lastIndex) {
        const text = content.substring(lastIndex, match.index);
        if (text) {
          parts.push(
            <span key={`text-${partIndex++}`}>{text}</span>
          );
        }
      }
      
      if (match.type === 'image') {
        // 处理图片
        const imageUrl = match.url;
        const imageKey = `img-${partIndex++}`;
        const hasError = imageErrors[imageUrl];
        
        parts.push(
          <div
            key={`img-wrapper-${imageKey}`}
            style={{
              marginTop: 12,
              marginBottom: 12,
              display: "flex",
              justifyContent: "center",
              flexDirection: "column",
              alignItems: "center"
            }}
          >
            {!hasError ? (
              <img
                key={imageKey}
                src={imageUrl}
                alt="红人头像"
                loading="lazy"
                style={{
                  maxWidth: "100%",
                  maxHeight: "700px",
                  borderRadius: 12,
                  display: "block",
                  objectFit: "contain",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                  backgroundColor: "rgba(255,255,255,0.05)"
                }}
                onError={(e) => {
                  const img = e.target;
                  const failedUrl = img.src;
                  
                  console.error(`[Image] 图片加载失败:`, {
                    url: failedUrl,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    complete: img.complete
                  });
                  
                  if (failedUrl.startsWith("http://") && !failedUrl.startsWith("https://")) {
                    const httpsUrl = failedUrl.replace("http://", "https://");
                    console.log(`[Image] 尝试使用 HTTPS 版本: ${httpsUrl}`);
                    img.src = httpsUrl;
                    return;
                  }
                  
                  setImageErrors(prev => ({ ...prev, [failedUrl]: true }));
                }}
                onLoad={() => {
                  console.log("图片加载成功:", imageUrl);
                }}
              />
            ) : (
              <div
                style={{
                  color: "#6B7280",
                  fontSize: 12,
                  padding: "8px 12px",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4
                }}
              >
                <div>图片加载失败</div>
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "#3B82F6",
                    fontSize: 11,
                    textDecoration: "underline",
                    cursor: "pointer"
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  在新窗口打开
                </a>
              </div>
            )}
          </div>
        );
      } else if (match.type === 'link') {
        // 处理链接
        parts.push(
          <a
            key={`link-${partIndex++}`}
            href={match.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "#3B82F6",
              textDecoration: "underline",
              cursor: "pointer",
              fontWeight: 500
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {match.text}
          </a>
        );
      }
      
      lastIndex = match.index + match.length;
    }
    
    // 单独处理influencer匹配 - 渲染为表格形式
    if (influencerMatches.length > 0) {
      // 找到第一个influencer匹配前的文本
      const firstInfluencerIndex = influencerMatches[0].index;
      if (firstInfluencerIndex > lastIndex) {
        const text = content.substring(lastIndex, firstInfluencerIndex);
        if (text) {
          parts.push(
            <span key={`text-${partIndex++}`}>{text}</span>
          );
        }
      }
      
      // 平台图标组件
      const TikTokIcon = () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
        </svg>
      );
      
      const InstagramIcon = () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
        </svg>
      );
      
      // 渲染表格容器
      parts.push(
        <div
          key={`influencer-table-${partIndex++}`}
          style={{
            marginTop: 16,
            marginBottom: 16,
            backgroundColor: "#FFFFFF",
            borderRadius: 12,
            border: "1px solid #E5E7EB",
            overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)"
          }}
        >
          {/* 表头行 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "60px 1fr 120px 120px 1fr",
              gap: 16,
              padding: "12px 16px",
              backgroundColor: "#F3F4F6",
              borderBottom: "1px solid #E5E7EB",
              alignItems: "center",
              fontSize: 13,
              fontWeight: 600,
              color: "#1F2937"
            }}
          >
            <div></div> {/* 头像列 */}
            <div>用户名</div>
            <div>粉丝量</div>
            <div>播放量</div>
            <div>是否推荐</div>
            <div>推荐理由</div>
          </div>
          
          {/* 数据行 */}
          {influencerMatches.map((match, idx) => {
            const avatarUrl = match.avatar;
            const hasAvatarError = avatarUrl && imageErrors[avatarUrl];
            const platform = match.platform || 'TikTok';
            
            return (
              <div
                key={`influencer-row-${idx}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "60px 1fr 120px 120px 100px 1fr",
                  gap: 16,
                  padding: "12px 16px",
                  borderBottom: idx < influencerMatches.length - 1 ? "1px solid #E5E7EB" : "none",
                  alignItems: "center",
                  fontSize: 13,
                  backgroundColor: match.isRecommended === true ? "#F0FDF4" : (match.isRecommended === false ? "#FEF2F2" : "#FFFFFF")
                }}
              >
                {/* 头像 */}
                <div style={{ flexShrink: 0 }}>
                  {avatarUrl && !hasAvatarError ? (
                    <img
                      src={avatarUrl}
                      alt={match.name || match.id}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: "50%",
                        objectFit: "cover",
                        border: "2px solid #E5E7EB"
                      }}
                      onError={(e) => {
                        const failedUrl = e.target.src;
                        if (failedUrl.startsWith("http://") && !failedUrl.startsWith("https://")) {
                          e.target.src = failedUrl.replace("http://", "https://");
                          return;
                        }
                        setImageErrors(prev => ({ ...prev, [failedUrl]: true }));
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: "50%",
                        backgroundColor: "#F3F4F6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#6B7280",
                        fontSize: 18
                      }}
                    >
                      {match.name ? match.name.charAt(0).toUpperCase() : "?"}
                    </div>
                  )}
                </div>
                
                {/* 用户名（可点击，带平台图标） */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <div style={{ 
                    color: platform === 'TikTok' ? 'rgba(255,0,80,0.9)' : 'rgba(225,48,108,0.9)',
                    display: "flex",
                    alignItems: "center"
                  }}>
                    {platform === 'TikTok' ? <TikTokIcon /> : <InstagramIcon />}
                  </div>
                  <a
                    href={match.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: "#3B82F6",
                      textDecoration: "none",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={(e) => {
                      e.target.style.textDecoration = "underline";
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.textDecoration = "none";
                    }}
                  >
                    {match.name || match.id}
                  </a>
                </div>
                
                {/* 粉丝量 */}
                <div style={{ color: "#1F2937" }}>
                  {match.followers}
                </div>
                
                {/* 播放量 */}
                <div style={{ color: "#1F2937" }}>
                  {match.views}
                </div>
                
                {/* 是否推荐 */}
                <div style={{ 
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}>
                  {match.isRecommended === true ? (
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      backgroundColor: "#10B981",
                      color: "#FFFFFF",
                      fontSize: 11,
                      fontWeight: 600
                    }}>
                      ✓ 推荐
                    </span>
                  ) : match.isRecommended === false ? (
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      backgroundColor: "#EF4444",
                      color: "#FFFFFF",
                      fontSize: 11,
                      fontWeight: 600
                    }}>
                      ✗ 不推荐
                    </span>
                  ) : (
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      backgroundColor: "#9CA3AF",
                      color: "#FFFFFF",
                      fontSize: 11,
                      fontWeight: 600
                    }}>
                      ? 未分析
                    </span>
                  )}
                </div>
                
                {/* 推荐理由 */}
                <div style={{ 
                  color: "#6B7280", 
                  lineHeight: 1.4,
                  minWidth: 0
                }}>
                  {match.reason}
                  {match.analysis && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ 
                        cursor: "pointer", 
                        color: "#3B82F6",
                        fontSize: 11
                      }}>
                        查看详细分析
                      </summary>
                      <div style={{ 
                        marginTop: 8,
                        padding: 8,
                        backgroundColor: "#F9FAFB",
                        borderRadius: 4,
                        fontSize: 11,
                        color: "#4B5563",
                        whiteSpace: "pre-wrap"
                      }}>
                        {match.analysis}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      );
      
      // 更新lastIndex到最后一个influencer匹配之后
      const lastInfluencerMatch = influencerMatches[influencerMatches.length - 1];
      lastIndex = lastInfluencerMatch.index + lastInfluencerMatch.length;
    }
    
    // 添加剩余文本
    if (lastIndex < content.length) {
      const remainingText = content.substring(lastIndex);
      if (remainingText) {
        parts.push(
          <span key={`text-${partIndex++}`}>{remainingText}</span>
        );
      }
    }
    
    // 如果没有匹配项，直接返回原文本
    if (parts.length === 0) {
      return content;
    }
    
    // 返回 React Fragment
    return <>{parts}</>;
  }

  // 清除对话和上下文（可选功能）
  function handleClear() {
    if (typeof window !== "undefined" && confirm("确定要清除所有对话记录吗？")) {
      setMessages(defaultMessage);
      setContext({ workflowState: "idle" }); // 重置为初始状态
      setImageErrors({});
      localStorage.removeItem(STORAGE_KEY_MESSAGES);
      localStorage.removeItem(STORAGE_KEY_CONTEXT);
    }
  }

  // 判断是否为空状态：未选中任何会话且只有初始欢迎消息时显示欢迎页；选中了草稿/已发布会话则始终显示对话+执行界面
  const isEmptyState =
    !currentSessionId &&
    messages.length === 1 &&
    messages[0].role === "assistant" &&
    messages[0].name === "Bin";

  // 仅已发布 campaign 展示「Bin的电脑」；草稿/发布对话阶段中间栏占满
  const showBinComputerPanel = !isEmptyState && isExecutionPhaseGlobal;

  // 新建一条服务端草稿并进入对话区（不再进入无会话的欢迎顶栏页）
  async function createDraftSessionAndActivate() {
    const createRes = await fetch("/api/sessions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "新 Campaign",
        messages: defaultMessage.map((m) => ({ ...m })),
        context: { workflowState: "idle" },
        status: "draft",
      }),
    });
    const createData = await createRes.json();
    if (!createData.success) {
      throw new Error(createData.error || "创建草稿失败");
    }
    setCurrentSessionId(createData.session.id);
    setMessages(createData.session.messages || defaultMessage);
    setContext(createData.session.context || { workflowState: "idle" });
    setImageErrors({});
    setSidebarCollapsed(false);
    await loadCampaignSessions({ silent: true });
  }

  // 发布 Campaign：先按需保存当前草稿，再创建并进入新草稿
  const handleCreateNewSession = async () => {
    try {
      if (currentSessionId && !isEmptyState) {
        await saveCurrentSession();
      }
      await createDraftSessionAndActivate();
    } catch (error) {
      console.error("[HomePage] 处理发布 Campaign 点击失败:", error);
      window.alert(error?.message || "创建失败");
    }
  };

  // 切换到指定会话（skipSave：当前会话已删除等情况，勿对已失效 id 执行 PUT）
  const handleSwitchSession = async (sessionId, opts = {}) => {
    const skipSave = Boolean(opts.skipSave);
    try {
      if (!skipSave && currentSessionId && currentSessionId !== sessionId) {
        await saveCurrentSession({ reloadSessions: false });
      }
      
      // 加载新会话
      const response = await fetch(`/api/sessions/${sessionId}`, { credentials: 'include' });
      const data = await response.json();
      if (data.success && data.session) {
        setCurrentSessionId(sessionId);
        setMessages(data.session.messages || defaultMessage);
        setContext(data.session.context || { workflowState: 'idle' });
      }
    } catch (error) {
      console.error('[HomePage] 切换会话失败:', error);
    }
  };

  // 删除会话
  const handleDeleteSession = async (sessionId, e) => {
    if (e?.stopPropagation) e.stopPropagation();
    setSessionRowMenuId((open) => (open === sessionId ? null : open));

    if (!confirm('确定要删除这个草稿吗？')) return;
    
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok || !data.success) {
        const msg = data.error || data.message || `删除失败（HTTP ${response.status}）`;
        console.error('[HomePage] 删除草稿未成功:', msg);
        window.alert(msg);
        return;
      }
      const wasCurrent = sessionId === currentSessionId;
      const lists = await loadCampaignSessions();
      if (wasCurrent && lists.ok) {
        const nextId = lists.drafts[0]?.id || lists.published[0]?.id;
        if (nextId) {
          await handleSwitchSession(nextId, { skipSave: true });
        } else {
          await createDraftSessionAndActivate();
        }
      } else if (wasCurrent && !lists.ok) {
        try {
          await createDraftSessionAndActivate();
        } catch (_) {
          setCurrentSessionId(null);
          setMessages(defaultMessage);
          setContext({ workflowState: "idle" });
        }
      }
    } catch (error) {
      console.error('[HomePage] 删除会话失败:', error);
      window.alert(error?.message || '删除请求异常，请稍后重试');
    }
  };

  const handleDeletePublishedSession = async (sessionId, e) => {
    if (e?.stopPropagation) e.stopPropagation();
    setSessionRowMenuId((open) => (open === sessionId ? null : open));

    if (!confirm('确定要删除这个已发布的 Campaign 吗？删除后不可恢复。')) return;

    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok || !data.success) {
        const msg = data.error || data.message || `删除失败（HTTP ${response.status}）`;
        console.error('[HomePage] 删除已发布 campaign 未成功:', msg);
        window.alert(msg);
        return;
      }
      const wasCurrent = sessionId === currentSessionId;
      const lists = await loadCampaignSessions();
      if (wasCurrent && lists.ok) {
        const nextId = lists.drafts[0]?.id || lists.published[0]?.id;
        if (nextId) {
          await handleSwitchSession(nextId, { skipSave: true });
        } else {
          await createDraftSessionAndActivate();
        }
      } else if (wasCurrent && !lists.ok) {
        try {
          await createDraftSessionAndActivate();
        } catch (_) {
          setCurrentSessionId(null);
          setMessages(defaultMessage);
          setContext({ workflowState: "idle" });
        }
      }
    } catch (error) {
      console.error('[HomePage] 删除已发布 campaign 失败:', error);
      window.alert(error?.message || '删除请求异常，请稍后重试');
    }
  };

  const cancelRenameSession = () => {
    setRenamingSessionId(null);
    setRenameInputValue("");
    renameBaselineRef.current = { id: null, title: "" };
  };

  const beginRenameSession = (sessionId, currentTitle) => {
    setSessionRowMenuId(null);
    const t = currentTitle || "";
    renameBaselineRef.current = { id: sessionId, title: t };
    renameValueRef.current = t;
    setRenamingSessionId(sessionId);
    setRenameInputValue(t);
  };

  const commitRenameSession = async (sessionId) => {
    if (!sessionId || renamingSessionIdRef.current !== sessionId) return;
    const baseline = renameBaselineRef.current;
    const title = String(renameValueRef.current || "").trim();
    if (!title) {
      window.alert("标题不能为空");
      if (baseline.id === sessionId) {
        setRenameInputValue(baseline.title);
        renameValueRef.current = baseline.title;
      }
      requestAnimationFrame(() => renameInputRef.current?.focus());
      return;
    }
    if (baseline.id === sessionId && baseline.title === title) {
      cancelRenameSession();
      return;
    }
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        window.alert(data.error || `重命名失败（HTTP ${response.status}）`);
        return;
      }
      const session = data.session;
      const newTitle = session?.title ?? title;
      const updatedAt = session?.updatedAt ?? null;
      setCampaignSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, title: newTitle, ...(updatedAt ? { updatedAt } : {}) } : s
        )
      );
      setPublishedSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, title: newTitle, ...(updatedAt ? { updatedAt } : {}) } : s
        )
      );
      cancelRenameSession();
    } catch (error) {
      console.error("[HomePage] 重命名会话失败:", error);
      window.alert(error?.message || "重命名请求异常，请稍后重试");
    }
  };

  const onRenameInputKeyDown = (e, sessionId) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRenameSession(sessionId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      ignoreRenameBlurRef.current = true;
      cancelRenameSession();
      queueMicrotask(() => {
        ignoreRenameBlurRef.current = false;
      });
    }
  };

  const onRenameInputBlur = (sessionId) => {
    if (ignoreRenameBlurRef.current) return;
    void commitRenameSession(sessionId);
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (_) {
      /* ignore */
    }
    cancelRenameSession();
    setSessionRowMenuId(null);
    setAuthUser(null);
    setCurrentSessionId(null);
    clearChatPersistenceKeys();
    setMessages(cloneWelcomeMessages());
    setContext({ workflowState: "idle" });
    setCampaignSessions([]);
    setPublishedSessions([]);
  };

  const submitLogin = async (e) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginErr("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: loginCompany.trim(),
          username: loginUser.trim(),
          password: loginPass,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) {
        setLoginErr(data.error || "登录失败");
        setLoginBusy(false);
        return;
      }
      setAuthUser(data.user);
      setLoginPass("");
      setLoginBusy(false);
      setLoginOpen(false);
      // 换账号登录：勿沿用浏览器里上一用户的会话 id / 超长 messages（会导致 POST /api/sessions 失败或误用他人会话）
      clearChatPersistenceKeys();
      setCurrentSessionId(null);
      setMessages(cloneWelcomeMessages());
      setContext({ workflowState: "idle" });
      setImageErrors({});
      await loadCampaignSessions();
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      if (pending) {
        await runChatSend(pending);
      }
    } catch (err) {
      setLoginErr(err?.message || "网络错误");
      setLoginBusy(false);
    }
  };

  // 快捷功能按钮点击处理
  function handleQuickAction(action) {
    let prompt = "";
    switch (action) {
      case "publish":
        // 发布 Campaign = 创建新会话
        handleCreateNewSession();
        return;
      case "modify":
        prompt = "我想修改已发布的campaign";
        break;
      case "speed":
        prompt = "我想调整campaign的执行速度";
        break;
      default:
        return;
    }
    setInput(prompt);
    // 自动聚焦到输入框
    setTimeout(() => {
      const textarea = document.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(prompt.length, prompt.length);
      }
    }, 100);
  }

  // 处理拖拽调整宽度
  const handleMouseDown = (e) => {
    isResizingRef.current = true;
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = middlePanelWidth;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  };

  const handleMouseMove = (e) => {
    if (!isResizingRef.current) return;
    const deltaX = e.clientX - resizeStartXRef.current;
    const sidebarGutter =
      showCampaignSidebar ? (sidebarCollapsed ? 48 : 240) : 0;
    const containerWidth = window.innerWidth - sidebarGutter;
    const deltaPercent = (deltaX / containerWidth) * 100;
    const newWidth = Math.max(30, Math.min(70, resizeStartWidthRef.current + deltaPercent));
    setMiddlePanelWidth(newWidth);
  };

  const handleMouseUp = () => {
    isResizingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  // 右侧面板：处理上下拖拽分割
  const handleVerticalMouseDown = (e) => {
    isVerticalResizingRef.current = true;
    verticalResizeStartYRef.current = e.clientY;
    verticalResizeStartSplitRef.current = rightPanelSplit;
    document.addEventListener('mousemove', handleVerticalMouseMove);
    document.addEventListener('mouseup', handleVerticalMouseUp);
    e.preventDefault();
  };

  const handleVerticalMouseMove = (e) => {
    if (!isVerticalResizingRef.current) return;
    const deltaY = e.clientY - verticalResizeStartYRef.current;
    const container = document.getElementById('right-panel-split-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const containerHeight = rect.height || 1;
    const deltaPercent = (deltaY / containerHeight) * 100;
    const newSplit = Math.max(20, Math.min(80, verticalResizeStartSplitRef.current + deltaPercent));
    setRightPanelSplit(newSplit);
  };

  const handleVerticalMouseUp = () => {
    isVerticalResizingRef.current = false;
    document.removeEventListener('mousemove', handleVerticalMouseMove);
    document.removeEventListener('mouseup', handleVerticalMouseUp);
    document.querySelectorAll(".vertical-panel-splitter").forEach((el) => {
      el.style.backgroundColor = "#E5E7EB";
    });
  };

  // 清理事件监听器
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleVerticalMouseMove);
      document.removeEventListener('mouseup', handleVerticalMouseUp);
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        backgroundColor: "#FFFFFF",
        position: "relative",
        overflow: "hidden",
        paddingLeft:
          showCampaignSidebar && sidebarCollapsed ? 48 : 0,
      }}
    >
      {/* 收缩状态下的左侧窄栏（仿照 Manus 左栏） */}
      {showCampaignSidebar && sidebarCollapsed && (
      <div
        style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: 48,
            backgroundColor: "#F3F4F6",
          borderRight: "1px solid #E5E7EB",
          display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 16,
            paddingBottom: 16,
            gap: 12,
            zIndex: 30,
          }}
        >
          {/* 视图切换 / 展开按钮 */}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "none",
              backgroundColor: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <div
              style={{
                width: 18,
                height: 16,
                borderRadius: 4,
                border: "1.5px solid #111827",
                display: "flex",
                flexDirection: "row",
                overflow: "hidden",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  width: "45%",
                  borderRight: "1.5px solid #111827",
                  backgroundColor: "transparent",
                }}
              />
              <div style={{ flex: 1 }} />
            </div>
          </button>

          {/* 新建 Campaign 按钮：圆形加号图标 */}
          <button
            type="button"
            onClick={() => handleQuickAction("publish")}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "none",
              backgroundColor: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                border: "1.5px solid #111827",
                position: "relative",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  width: 8,
                  height: 1.5,
                  backgroundColor: "#111827",
                  transform: "translate(-50%, -50%)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  width: 1.5,
                  height: 8,
                  backgroundColor: "#111827",
                  transform: "translate(-50%, -50%)",
                }}
              />
            </div>
          </button>
        </div>
      )}
      {/* 左侧菜单栏：已登录即可见 */}
      {showCampaignSidebar && (
      <div
        style={{
          width: sidebarCollapsed ? 0 : 240,
          backgroundColor: "#F9FAFB",
          borderRight: sidebarCollapsed ? "none" : "1px solid #E5E7EB",
          display: sidebarCollapsed ? "none" : "flex",
          flexDirection: "column",
          transition: "width 0.3s ease",
          flexShrink: 0
        }}
      >
        {/* Logo、视图切换与新建按钮 */}
        <div
          style={{
            padding: "16px",
            borderBottom: "1px solid #E5E7EB",
            display: "flex",
            alignItems: "center",
            justifyContent: sidebarCollapsed ? "center" : "space-between"
          }}
        >
          {!sidebarCollapsed && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <BinLogo size={24} />
              </div>
              <div style={{ fontWeight: 600, color: "#1F2937", fontSize: 14 }}>
                Maxin AI
              </div>
            </div>
          )}

          {sidebarCollapsed ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: 2,
                borderRadius: 999,
                backgroundColor: "#F3F4F6",
                border: "1px solid #E5E7EB",
              }}
            >
              {/* 视图切换 / 展开按钮：仿照左侧布局图标 */}
          <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                style={{
                  width: 28,
                  height: 20,
                  borderRadius: 999,
                  border: "none",
                  backgroundColor: "#FFFFFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 12,
                    borderRadius: 4,
                    border: "1.5px solid #111827",
                    display: "flex",
                    flexDirection: "row",
                    overflow: "hidden",
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      width: "45%",
                      borderRight: "1.5px solid #111827",
                      backgroundColor: "transparent",
                    }}
                  />
                  <div style={{ flex: 1 }} />
                </div>
              </button>

              {/* 新建 Campaign 按钮：圆形加号图标 */}
              <button
                type="button"
                onClick={() => handleQuickAction("publish")}
                style={{
                  width: 28,
                  height: 20,
                  borderRadius: 999,
                  border: "none",
                  backgroundColor: "#FFFFFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "1.5px solid #111827",
                    position: "relative",
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      width: 7,
                      height: 1.5,
                      backgroundColor: "#111827",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      width: 1.5,
                      height: 7,
                      backgroundColor: "#111827",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                </div>
              </button>
            </div>
          ) : (
            <button
              onClick={() => setSidebarCollapsed(true)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
                padding: 0,
                width: 32,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 14,
                  borderRadius: 4,
                  border: "1.5px solid #111827",
                  display: "flex",
                  flexDirection: "row",
                  overflow: "hidden",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    width: "45%",
                    borderRight: "1.5px solid #111827",
                    backgroundColor: "transparent",
                  }}
                />
                <div style={{ flex: 1 }} />
              </div>
          </button>
          )}
        </div>

        {/* 发布新的 Campaign（仅按钮，无额外说明文字） */}
        {!sidebarCollapsed && (
          <div style={{ padding: "12px", borderBottom: "1px solid #E5E7EB" }}>
            <button
              onClick={() => handleQuickAction("publish")}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E5E7EB",
                background: "#FFFFFF",
                color: "#1F2937",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "flex-start",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = "#F3F4F6";
                e.target.style.borderColor = "#111827";
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = "#FFFFFF";
                e.target.style.borderColor = "#E5E7EB";
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: "1.5px solid #111827",
                  position: "relative",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 8,
                    height: 1.5,
                    backgroundColor: "#111827",
                    transform: "translate(-50%, -50%)",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 1.5,
                    height: 8,
                    backgroundColor: "#111827",
                    transform: "translate(-50%, -50%)",
                  }}
                />
              </div>
              <span>发布 Campaign</span>
            </button>
          </div>
        )}

        {/* Campaign 草稿 + 已发布 Campaign */}
        <div style={{ flex: 1, padding: "12px", overflowY: "auto" }}>
          {sidebarCollapsed ? null : (
            <>
              {/* 只有在存在草稿 / 已发布会话，或加载/拉取出错时，才展示下方列表，避免在完全空状态点击发布按钮时闪烁文字 */}
              {(sessionsError ||
                campaignSessions.length > 0 ||
                publishedSessions.length > 0) && (
                <>
                  {/* Campaign 草稿列表（仅在有草稿时展示） */}
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#9CA3AF",
                        marginBottom: 8,
                        textTransform: "uppercase",
                      }}
                    >
              Campaign 草稿
            </div>
          {loadingSessions ? (
                      <div
                        style={{
                          padding: "12px",
              fontSize: 12,
              color: "#9CA3AF",
                        }}
                      >
                        加载中...
            </div>
          ) : sessionsError ? (
                      <div
                        style={{
                          padding: "12px",
              fontSize: 11,
              color: "#EF4444",
                          lineHeight: 1.4,
                        }}
                      >
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>加载失败</div>
                  <div style={{ fontSize: 10, color: "#9CA3AF" }}>{sessionsError}</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      loadCampaignSessions();
                    }}
                    style={{
                      marginTop: 8,
                      padding: "4px 8px",
                      fontSize: 10,
                      backgroundColor: "#3B82F6",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: 4,
                            cursor: "pointer",
                    }}
                  >
                    重试
                  </button>
            </div>
          ) : campaignSessions.length === 0 ? (
                      <div
                        style={{
                          padding: "4px 0 8px",
              fontSize: 12,
              color: "#9CA3AF",
                        }}
                      >
                        暂无草稿
            </div>
          ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          marginBottom: 4,
                        }}
                      >
              {campaignSessions.map((session) => {
                const isActive = session.id === currentSessionId;
                return (
                  <div
                    key={session.id}
                    onClick={() => {
                      if (renamingSessionId === session.id) return;
                      handleSwitchSession(session.id);
                    }}
                    style={{
                                padding: "10px 12px",
                      borderRadius: 8,
                      backgroundColor: isActive ? "#E0F2FE" : "#FFFFFF",
                      border: `1px solid ${
                        renamingSessionId === session.id
                          ? "#2563EB"
                          : isActive
                            ? "#3B82F6"
                            : "#E5E7EB"
                      }`,
                      cursor: renamingSessionId === session.id ? "default" : "pointer",
                      fontSize: 12,
                      color: "#1F2937",
                      display: "flex",
                      alignItems: "center",
                                justifyContent: "space-between",
                      gap: 8,
                      position: "relative",
                                transition: "all 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      setSessionRowHoverId(session.id);
                      if (!isActive && renamingSessionId !== session.id) {
                        e.currentTarget.style.backgroundColor = "#F3F4F6";
                        e.currentTarget.style.borderColor = "#D1D5DB";
                      }
                    }}
                    onMouseLeave={(e) => {
                      setSessionRowHoverId((cur) => (cur === session.id ? null : cur));
                      if (!isActive && renamingSessionId !== session.id) {
                        e.currentTarget.style.backgroundColor = "#FFFFFF";
                        e.currentTarget.style.borderColor = "#E5E7EB";
                      }
                    }}
                  >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {renamingSessionId === session.id ? (
                            <input
                              ref={renameInputRef}
                              value={renameInputValue}
                              onChange={(e) => {
                                const v = e.target.value;
                                setRenameInputValue(v);
                                renameValueRef.current = v;
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onKeyDown={(e) => onRenameInputKeyDown(e, session.id)}
                              onBlur={() => onRenameInputBlur(session.id)}
                              maxLength={200}
                              style={{
                                width: "100%",
                                fontSize: 12,
                                fontWeight: isActive ? 600 : 500,
                                marginBottom: 2,
                                padding: "4px 8px",
                                borderRadius: 6,
                                border: "1px solid #2563EB",
                                outline: "none",
                                boxSizing: "border-box",
                                color: "#111827",
                                background: "#FFFFFF",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                fontWeight: isActive ? 600 : 500,
                                marginBottom: 2,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {session.title || "未命名草稿"}
                            </div>
                          )}
                          <div
                            style={{
                              fontSize: 10,
                              color: "#9CA3AF",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {session.updatedAt
                              ? new Date(session.updatedAt).toLocaleString("zh-CN", {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : ""}
                          </div>
                        </div>
                        {renamingSessionId !== session.id ? (
                          <CampaignSessionRowMenu
                            sessionId={session.id}
                            showTrigger={
                              sessionRowHoverId === session.id || sessionRowMenuId === session.id
                            }
                            menuOpen={sessionRowMenuId === session.id}
                            onToggleMenu={() =>
                              setSessionRowMenuId((open) =>
                                open === session.id ? null : session.id
                              )
                            }
                            onRename={() =>
                              beginRenameSession(session.id, session.title || "未命名草稿")
                            }
                            onDelete={() => handleDeleteSession(session.id)}
                          />
                        ) : null}
                  </div>
                );
              })}
            </div>
          )}
                  </div>

                  {/* 已发布 Campaign 区块：仅在有已发布时展示标题和列表 */}
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#9CA3AF",
                  marginBottom: 8,
                        textTransform: "uppercase",
                }}
              >
                已发布 Campaign
              </div>
              {loadingSessions ? (
                <div
                  style={{
                    padding: "8px 0",
                    fontSize: 12,
                          color: "#9CA3AF",
                  }}
                >
                  加载中...
                </div>
              ) : publishedSessions.length === 0 ? (
                <div
                  style={{
                    padding: "4px 0",
                    fontSize: 12,
                          color: "#9CA3AF",
                  }}
                >
                  暂无已发布的 Campaign
                </div>
              ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                  {publishedSessions.map((session) => {
                    const isActive = session.id === currentSessionId;
                    return (
                      <div
                        key={session.id}
                        onClick={() => {
                          if (renamingSessionId === session.id) return;
                          handleSwitchSession(session.id);
                        }}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 8,
                          backgroundColor: isActive ? "#EEF2FF" : "#FFFFFF",
                          border: `1px solid ${
                            renamingSessionId === session.id
                              ? "#2563EB"
                              : isActive
                                ? "#4F46E5"
                                : "#E5E7EB"
                          }`,
                          cursor: renamingSessionId === session.id ? "default" : "pointer",
                          fontSize: 12,
                          color: "#1F2937",
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                                transition: "all 0.2s",
                        }}
                        onMouseEnter={(e) => {
                          setSessionRowHoverId(session.id);
                          if (!isActive && renamingSessionId !== session.id) {
                            e.currentTarget.style.backgroundColor = "#F3F4F6";
                            e.currentTarget.style.borderColor = "#D1D5DB";
                          }
                        }}
                        onMouseLeave={(e) => {
                          setSessionRowHoverId((cur) => (cur === session.id ? null : cur));
                          if (!isActive && renamingSessionId !== session.id) {
                            e.currentTarget.style.backgroundColor = "#FFFFFF";
                            e.currentTarget.style.borderColor = "#E5E7EB";
                          }
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          {renamingSessionId === session.id ? (
                            <input
                              ref={renameInputRef}
                              value={renameInputValue}
                              onChange={(e) => {
                                const v = e.target.value;
                                setRenameInputValue(v);
                                renameValueRef.current = v;
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onKeyDown={(e) => onRenameInputKeyDown(e, session.id)}
                              onBlur={() => onRenameInputBlur(session.id)}
                              maxLength={200}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 12,
                                fontWeight: isActive ? 600 : 500,
                                padding: "4px 8px",
                                borderRadius: 6,
                                border: "1px solid #2563EB",
                                outline: "none",
                                boxSizing: "border-box",
                                color: "#111827",
                                background: "#FFFFFF",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                fontWeight: isActive ? 600 : 500,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                flex: 1,
                                minWidth: 0,
                              }}
                            >
                              {session.title || "已发布 Campaign"}
                            </div>
                          )}
                          {renamingSessionId !== session.id ? (
                            <CampaignSessionRowMenu
                              sessionId={session.id}
                              showTrigger={
                                sessionRowHoverId === session.id || sessionRowMenuId === session.id
                              }
                              menuOpen={sessionRowMenuId === session.id}
                              onToggleMenu={() =>
                                setSessionRowMenuId((open) =>
                                  open === session.id ? null : session.id
                                )
                              }
                              onRename={() =>
                                beginRenameSession(session.id, session.title || "已发布 Campaign")
                              }
                              onDelete={() => handleDeletePublishedSession(session.id)}
                            />
                          ) : null}
                        </div>
                        {session.updatedAt && (
                          <div
                            style={{
                              fontSize: 10,
                              color: "#9CA3AF",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {new Date(session.updatedAt).toLocaleString("zh-CN", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
                </>
              )}
            </>
          )}
        </div>
        {authUser && (
          <div
            style={{
              borderTop: "1px solid #E5E7EB",
              padding: "10px 12px",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={handleLogout}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 12,
                color: "#6B7280",
                background: "#FFFFFF",
                border: "1px solid #E5E7EB",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              退出登录
            </button>
            {authUser.isAdmin ? (
              <a
                href="/admin"
                style={{
                  fontSize: 11,
                  color: "#3B82F6",
                  textAlign: "center",
                  textDecoration: "none",
                }}
              >
                会话管理（管理员）
              </a>
            ) : null}
          </div>
        )}
      </div>
      )}

      {/* 中间和右侧面板容器 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          position: "relative",
          paddingTop: 0,
          boxSizing: "border-box",
        }}
      >
        {/* 右侧主区域：空状态时占满右侧（学习 Manus），有对话时再拆分中间/右侧 */}
        <div
          style={{
            width: isEmptyState
              ? "100%"
              : showBinComputerPanel
                ? `${middlePanelWidth}%`
                : "100%",
            display: "flex",
            flexDirection: "column",
            borderRight: showBinComputerPanel ? "1px solid #E5E7EB" : "none",
            backgroundColor: "#FFFFFF",
            transition: "width 0.2s ease"
          }}
        >
          <main
            style={{
              flex: 1,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#FFFFFF"
            }}
          >
        {isEmptyState ? (
          // 空状态：欢迎界面（学习 DeepSeek / Manus，右侧区域正中央）
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
              padding: "24px 40px",
              boxSizing: "border-box"
            }}
          >
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: "#1F2937",
                marginBottom: 12,
                fontFamily: "system-ui, -apple-system, sans-serif"
              }}
            >
              Maxin AI
            </div>
            
            <div
              style={{
                fontSize: 18,
                color: "#6B7280",
                marginBottom: 48,
                textAlign: "center"
              }}
            >
              我是 Bin，你的红人营销助手
            </div>

            {/* 大输入框 */}
            <form
              onSubmit={handleSend}
              style={{
                width: "100%",
                maxWidth: 600,
                marginBottom: 24
              }}
            >
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  backgroundColor: "#FFFFFF",
                  borderRadius: 16,
                  border: inputFocused ? "2px solid #111827" : "2px solid #E5E7EB",
                  padding: "12px 16px",
                  transition: "all 0.2s",
                  boxShadow: inputFocused 
                    ? "0 4px 12px rgba(15, 23, 42, 0.18)" 
                    : "0 2px 8px rgba(0,0,0,0.04)"
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 12,
                    flexShrink: 0
                  }}
                >
                  <BinLogo size={22} />
                </div>
                <textarea
                  ref={inputTextAreaRefMain}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  rows={1}
                  placeholder="发送消息给 Bin"
                  style={{
                    flex: 1,
                    resize: "none",
                    border: "none",
                    outline: "none",
                    fontSize: 15,
                    backgroundColor: "transparent",
                    color: "#1F2937",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                    lineHeight: 1.5,
                    minHeight: 24,
                    maxHeight: 220,
                    overflowY: "auto"
                  }}
                  onKeyDown={(e) => {
                    const isComposing =
                      e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229;
                    if (isComposing) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(e);
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    border: "none",
              background: loading || !input.trim()
                      ? "#E5E7EB"
                      : "#60A5FA",
              color: loading || !input.trim() ? "#9CA3AF" : "#FFFFFF",
                    cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "all 0.2s",
                    flexShrink: 0,
                    marginLeft: 8
                  }}
                  onMouseEnter={(e) => {
                    if (!loading && input.trim()) {
                      e.target.style.transform = "translateY(-1px)";
                      e.target.style.boxShadow = "0 2px 8px rgba(59, 130, 246, 0.4)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!loading && input.trim()) {
                      e.target.style.transform = "translateY(0)";
                      e.target.style.boxShadow = "none";
                    }
                  }}
                >
                  <ChatSendUpIcon />
                </button>
              </div>
            </form>
          </div>
        ) : (
          // 有对话时：显示聊天界面（发布阶段无右栏时居中收窄，参考常见 Chat 布局）
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: "20px",
              boxSizing: "border-box",
              overflow: "hidden"
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: showBinComputerPanel ? "none" : 820,
                marginLeft: showBinComputerPanel ? 0 : "auto",
                marginRight: showBinComputerPanel ? 0 : "auto",
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden"
              }}
            >
            <div
              ref={chatContainerRef}
              style={{
                flex: 1,
                overflowY: "auto",
                paddingRight: 8
              }}
              onScroll={(e) => {
                // 检测用户是否手动滚动
                const container = e.target;
                const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
                // 如果用户不在底部附近，禁用自动滚动（用户可能在查看历史消息）
                if (!isNearBottom) {
                  shouldAutoScrollRef.current = false;
                } else {
                  // 如果用户滚动回底部，重新启用自动滚动
                  shouldAutoScrollRef.current = true;
                }
              }}
            >
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    justifyContent:
                      m.role === "user" ? "flex-end" : "flex-start",
                    marginBottom: 16,
                    animation: "fadeIn 0.3s ease-in"
                  }}
                >
                  <div
                    style={{
                      maxWidth: "80%",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      alignItems: m.role === "assistant" ? "flex-start" : "flex-end"
                    }}
                  >
                    {m.role === "assistant" && (
                      <div style={{ marginLeft: 2 }}>
                        <BinLogo size={22} />
                      </div>
                    )}
                    {m.content && (
                      <div
                        style={{
                          padding: "12px 16px",
                          borderRadius: 12,
                          backgroundColor:
                            m.role === "user"
                              ? "#F3F4F6"
                              : "#FFFFFF",
                          color: m.role === "user" ? "#111827" : "#1F2937",
                          fontSize: 14,
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.6,
                          border: "1px solid #E5E7EB",
                          boxShadow: "none",
                          wordBreak: "break-word", // 防止长链接/长词溢出
                          overflowWrap: "break-word"
                        }}
                      >
                        {renderMessageContent(m.content)}
                      </div>
                    )}
                    {/* 思考过程展示 - 精简版（类似 Manus / Cursor） */}
                    {m.role === "assistant" && m.thinking && m.thinking.steps && m.thinking.steps.length > 0 && !m.content && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 12px",
                          borderRadius: 999,
                          backgroundColor: "#F3F4F6",
                          fontSize: 12,
                          color: "#6B7280",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          maxWidth: "100%"
                        }}
                      >
                        <span
                          className="thinking-dot"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            backgroundColor: "#60A5FA",
                            display: "inline-block"
                          }}
                        />
                        <span style={{ whiteSpace: "nowrap" }}>Bin 正在思考</span>
                        <span style={{ whiteSpace: "nowrap" }}>·</span>
                        <span style={{ whiteSpace: "nowrap" }}>
                          {translateToBusinessLanguage(
                            m.thinking.steps[m.thinking.steps.length - 1].agent,
                            m.thinking.steps[m.thinking.steps.length - 1].action,
                            m.thinking.steps[m.thinking.steps.length - 1].result
                          ).title}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            
            {/* 输入框 */}
            <form
              onSubmit={handleSend}
              style={{
                paddingTop: "16px",
                borderTop: "1px solid #E5E7EB",
                flexShrink: 0
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-end"
                }}
              >
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                borderRadius: 12,
                border: "1px solid #D1D5DB",
                padding: "6px 8px 6px 12px",
                backgroundColor: "#FFFFFF"
              }}
            >
              <textarea
                ref={inputTextAreaRefFooter}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={1}
                placeholder="发送消息给 Bin"
                style={{
                  flex: 1,
                  resize: "none",
                  border: "none",
                  fontSize: 14,
                  backgroundColor: "transparent",
                  color: "#1F2937",
                  outline: "none",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  minHeight: 32,
                  maxHeight: 220,
                  overflowY: "auto"
                }}
                onKeyDown={(e) => {
                  const isComposing =
                    e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229;
                  if (isComposing) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e);
                  }
                }}
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: "none",
                  marginLeft: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                  backgroundColor: loading || !input.trim() ? "#E5E7EB" : "#60A5FA",
                  color: loading || !input.trim() ? "#9CA3AF" : "#FFFFFF",
                  transition: "all 0.2s",
                  fontSize: 14
                }}
              >
                <ChatSendUpIcon />
              </button>
            </div>
          </div>
        </form>
            </div>
          </div>
        )}
          </main>
        </div>

        {/* 拖拽调整宽度的分隔条（仅已发布且展示 Bin 的电脑时） */}
        {showBinComputerPanel && (
          <div
            onMouseDown={handleMouseDown}
            style={{
              width: "4px",
              backgroundColor: "#E5E7EB",
              cursor: "col-resize",
              flexShrink: 0,
              transition: "background-color 0.2s",
              zIndex: 10
            }}
            onMouseEnter={(e) => {
              e.target.style.backgroundColor = "#0F172A";
            }}
            onMouseLeave={(e) => {
              if (!isResizingRef.current) {
                e.target.style.backgroundColor = "#E5E7EB";
              }
            }}
          />
        )}

        {/* 右侧：Agent 工作界面（仅已发布 campaign 展示） */}
        {showBinComputerPanel && (
          <div
            style={{
              width: `${100 - middlePanelWidth}%`,
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#F9FAFB",
              borderLeft: "1px solid #E5E7EB",
              overflow: "hidden",
              transition: "width 0.2s ease"
            }}
          >
            {/* 右侧面板标题栏 - 可折叠 */}
            <div style={{
              padding: "12px 16px",
              borderBottom: "1px solid #E5E7EB",
              backgroundColor: "#FFFFFF",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: "#1F2937",
                display: "flex",
                alignItems: "center",
                gap: 8
              }}>
                💻 Bin的电脑
              </div>
              {isExecutionPhaseGlobal && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    backgroundColor: "#F3F4F6",
                    borderRadius: 8,
                    padding: 2
                  }}
                >
                  {[
                    { key: "overview", label: "执行总览" },
                    { key: "live", label: "工作实况" },
                  ].map((tab) => {
                    const active = binComputerView === tab.key;
                    const isLive = tab.key === "live";
                    return (
                      <button
                        key={tab.key}
                        onClick={() => handleBinComputerViewChange(tab.key, true)}
                        style={{
                          border: "none",
                          backgroundColor: active ? "#FFFFFF" : "transparent",
                          color: active ? "#111827" : "#6B7280",
                          fontSize: 12,
                          fontWeight: active ? 600 : 500,
                          padding: "6px 10px",
                          borderRadius: 6,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none"
                        }}
                      >
                        {tab.label}
                        {isLive && workLiveUnreadCount > 0 && !active && (
                          <span
                            style={{
                              minWidth: 16,
                              height: 16,
                              padding: "0 4px",
                              borderRadius: 999,
                              backgroundColor: "#EF4444",
                              color: "#FFFFFF",
                              fontSize: 10,
                              lineHeight: "16px",
                              textAlign: "center",
                              fontWeight: 600
                            }}
                          >
                            {workLiveUnreadCount > 99 ? "99+" : workLiveUnreadCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{
              flex: 1,
              overflow: "hidden",
              padding: "16px",
              display: "flex",
            flexDirection: "column"
            }}>
              {/* 显示右侧 Agent 工作区域：根据 workflowState 在「发布阶段」和「执行阶段」之间切换布局 */}
              {(() => {
                const lastMessage = messages[messages.length - 1];
                if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.thinking) {
                  return (
                    <div style={{
                      padding: "40px 20px",
                      textAlign: "center",
                      color: "#9CA3AF",
                      fontSize: 14
                    }}>
                      等待 Agent 开始工作...
                    </div>
                  );
                }

                const isExecutionPhase =
                  context?.workflowState === "published" || context?.published === true;

                const { browserSteps, screenshots, influencerAnalyses, source } =
                  lastMessage.thinking || {};

                // 执行阶段：上「工作笔记」（执行节奏 + 汇报方式）、下「执行进度」（单阶段 Tab）
                if (isExecutionPhase && binComputerView === "overview") {
                  const cols = executionStatus?.columns || {};
                  const needSampleFlag = executionStatus?.needSample !== false;
                  const stageDefsAll = [
                    { key: "contacted", title: "已联系", items: cols.contacted || [] },
                    { key: "pendingPrice", title: "待审核价格", items: cols.pendingPrice || [] },
                    { key: "pendingSample", title: "待寄样品", items: cols.pendingSample || [] },
                    { key: "pendingDraft", title: "待审核草稿", items: cols.pendingDraft || [] },
                    { key: "published", title: "已发布视频", items: cols.published || [] },
                  ];
                  const stageDefs = stageDefsAll.filter(
                    (s) => s.key !== "pendingSample" || needSampleFlag
                  );
                  const currentStage =
                    stageDefs.find((s) => s.key === activeExecutionStage) || stageDefs[0];
                  const currentItems = currentStage.items;

                  // 工作笔记：来自执行节奏 + 汇报配置
                  const config = executionConfig;
                  const influencersPerDay =
                    config?.influencersPerDay ?? executionStatus?.influencersPerDay ?? null;
                  const report = config?.reportConfig || null;
                  const keywordStrategy = config?.keywordStrategy || null;
                  const intervalHours = report?.intervalHours ?? null;
                  const reportTime = report?.reportTime || null;
                  const contentPreference = report?.contentPreference || null;
                  const includeMetrics = report?.includeMetrics || [];
                  const fallbackNotes = Array.isArray(lastMessage?.thinking?.workNotes)
                    ? lastMessage.thinking.workNotes
                    : [];
                  const workNoteItems =
                    Array.isArray(keywordWorkNotes) && keywordWorkNotes.length > 0
                      ? keywordWorkNotes
                      : fallbackNotes;

                  return (
                    <div
                      id="right-panel-split-container"
                      style={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column"
                      }}
                    >
                      {/* 上：工作笔记（可上下拖拽调整高度） */}
                      <div style={{
                        flex: rightPanelSplit,
                        minHeight: 0,
                        border: "1px solid #E5E7EB",
                        borderRadius: 12,
                        overflow: "hidden",
                        backgroundColor: "#FFFFFF",
                        display: "flex",
                        flexDirection: "column"
                      }}>
                        <div style={{
                          padding: "10px 12px",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#6B7280",
                          backgroundColor: "#F9FAFB",
                          borderBottom: "1px solid #E5E7EB"
                        }}>
                          工作笔记
                        </div>
                        <div style={{
                          flex: 1,
                          minHeight: 0,
                          overflowY: "auto",
                          padding: "12px"
                        }}>
                          {executionConfigError ? (
                            <div style={{ fontSize: 12, color: "#EF4444" }}>
                              {executionConfigError}
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              <div style={{ fontSize: 12, color: "#4B5563", lineHeight: 1.7 }}>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>执行节奏：</span>
                                  {influencersPerDay
                                    ? `每天联系 ${influencersPerDay} 位红人`
                                    : "尚未设置每天联系的红人数量"}
                                </div>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>汇报频率：</span>
                                  {intervalHours
                                    ? `每 ${intervalHours} 小时汇报一次`
                                    : "尚未设置汇报频率"}
                                </div>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>汇报时间：</span>
                                  {reportTime ? `每日 ${reportTime}` : "尚未设置具体汇报时间"}
                                </div>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>汇报形式：</span>
                                  {contentPreference === "brief"
                                    ? "简要汇总"
                                    : contentPreference === "detailed"
                                    ? "详细报告"
                                    : contentPreference === "summary_only"
                                    ? "仅汇总数字"
                                    : "尚未设置汇报形式"}
                                </div>
                                <div>
                                  <span style={{ fontWeight: 600 }}>重点指标：</span>
                                  {(() => {
                                    const metricLabelMap = {
                                      pending_price_count: "待审核价格数量",
                                      pending_sample_count: "待寄样品数量",
                                      pending_draft_count: "待审核草稿数量",
                                      published_count: "已发布视频数量",
                                    };
                                    return Array.isArray(includeMetrics) && includeMetrics.length > 0
                                      ? includeMetrics.map((k) => metricLabelMap[k] ?? k).join("，")
                                      : "当前日报中未配置额外指标";
                                  })()}
                                </div>
                                {keywordStrategy ? (
                                  <div style={{ marginTop: 4 }}>
                                    <span style={{ fontWeight: 600 }}>关键词策略：</span>
                                    {keywordStrategy}
                                  </div>
                                ) : null}
                              </div>
                              {workNoteItems.length > 0 && (
                                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
                                  {workNoteItems
                                    .slice()
                                    .sort((a, b) => new Date(a?.time || 0) - new Date(b?.time || 0))
                                    .map((item, idx) => {
                                      const timeLabel = item?.time
                                        ? new Date(item.time).toLocaleTimeString("zh-CN", {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                            second: "2-digit",
                                          })
                                        : "--:--:--";
                                      const keyword = item?.keyword || "（未命名关键词）";
                                      const reason = item?.reasonText || "基于当前 campaign 的执行目标选择该关键词。";
                                      const extracted = item?.extractedCount;
                                      const matched = item?.matchedCount;
                                      const resultText =
                                        extracted == null || matched == null
                                          ? ""
                                          : `已提取 ${extracted} 位红人主页，${matched} 位符合红人画像要求。`;
                                      const failedText = item?.status === "failed" ? "本轮未成功完成，系统将继续优化后续搜索。" : "";
                                      return (
                                        <div key={`work-note-${item?.taskId || idx}`} style={{ fontSize: 12, color: "#4B5563", lineHeight: 1.7 }}>
                                          {`${timeLabel}，开始搜索“${keyword}”。选择原因：${reason}${resultText ? `。${resultText}` : "。"}`}
                                          {failedText ? ` ${failedText}` : ""}
                                        </div>
                                      );
                                    })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 上下拖拽分隔条（与聊天区/Bin 电脑间左右分割条同色：悬停与拖拽时 #0F172A） */}
                      <div
                        className="vertical-panel-splitter"
                        onMouseDown={handleVerticalMouseDown}
                        style={{
                          height: "4px",
                          cursor: "row-resize",
                          margin: "4px 0",
                          flexShrink: 0,
                          backgroundColor: "#E5E7EB",
                          transition: "background-color 0.2s",
                          zIndex: 10
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "#0F172A";
                        }}
                        onMouseLeave={(e) => {
                          if (!isVerticalResizingRef.current) {
                            e.currentTarget.style.backgroundColor = "#E5E7EB";
                          }
                        }}
                      />

                      {/* 下：执行进度（单阶段 Tab + 红人卡片） */}
                      <div style={{
                        flex: 100 - rightPanelSplit,
                        minHeight: 0,
                        border: "1px solid #E5E7EB",
                        borderRadius: 12,
                        overflow: "hidden",
                        backgroundColor: "#FFFFFF",
                        display: "flex",
                        flexDirection: "column"
                      }}>
                        <div style={{
                        padding: "10px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#6B7280",
                        backgroundColor: "#F9FAFB",
                        borderBottom: "1px solid #E5E7EB",
                        flexShrink: 0
                      }}>
                          执行进度
                        </div>
                        <div
                          style={{
                            flex: 1,
                            minHeight: 0,
                            overflow: "hidden",
                            padding: "12px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 8
                          }}
                        >
                          {executionLoading ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#9CA3AF",
                                textAlign: "center",
                                paddingTop: 12
                              }}
                            >
                              加载执行进度中…
                            </div>
                          ) : executionError ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#EF4444",
                                textAlign: "center",
                                paddingTop: 12
                              }}
                            >
                              {executionError}
                            </div>
                          ) : !executionStatus ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#9CA3AF",
                                textAlign: "center",
                                paddingTop: 12
                              }}
                            >
                              暂无执行数据。
                            </div>
                          ) : (
                            <>
                              {/* 阶段 Tab 切换 */}
                              <div
                                style={{
                                  flexShrink: 0,
                                  display: "flex",
                                  gap: 8,
                                  flexWrap: "wrap"
                                }}
                              >
                                {stageDefs.map((stage) => {
                                  const isActive = stage.key === currentStage.key;
                                  return (
                                    <button
                                      key={stage.key}
                                      type="button"
                                      onClick={() => setActiveExecutionStage(stage.key)}
                                      style={{
                                        padding: "4px 10px",
                                        borderRadius: 999,
                                        border: isActive ? "1px solid #4F46E5" : "1px solid #E5E7EB",
                                        backgroundColor: isActive ? "#EEF2FF" : "#FFFFFF",
                                        color: isActive ? "#3730A3" : "#4B5563",
                                        fontSize: 12,
                                        cursor: "pointer"
                                      }}
                                    >
                                      {stage.title}（{stage.items.length}）
                                    </button>
                                  );
                                })}
                              </div>

                              {/* 当前阶段的红人卡片列表 */}
                              <div
                                style={{
                                  flex: 1,
                                  minHeight: 0,
                                  overflowY: "auto",
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 8
                                }}
                              >
                                {currentItems.length === 0 ? (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: "#9CA3AF"
                                    }}
                                  >
                                    该阶段暂无红人。
                                  </div>
                                ) : (
                                  currentItems.map((item) => (
                                    <ExecutionProgressRow
                                      key={item.id}
                                      stageKey={currentStage.key}
                                      item={item}
                                      needSample={needSampleFlag}
                                      execPatchingId={execPatchingId}
                                      patchExecution={patchExecution}
                                    />
                                  ))
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }

                // ---------- 工作实况（执行阶段）或默认发布阶段：红人画像 + 浏览器 ----------
                
                // 红人匹配分析数据：优先使用 SSE 实时累积的 influencerAnalyses，否则从消息内容解析
                let influencerMatches = [];
                if (influencerAnalyses && influencerAnalyses.length > 0) {
                  influencerMatches = [...influencerAnalyses]
                    .sort((a, b) => {
                      const ao = Number(a?.order || 0);
                      const bo = Number(b?.order || 0);
                      if (ao && bo && ao !== bo) return ao - bo;
                      const at = new Date(a?.timestamp || 0).getTime();
                      const bt = new Date(b?.timestamp || 0).getTime();
                      return at - bt;
                    })
                    .map((inf) => ({
                      avatar: inf.avatar || '',
                      profileUrl: inf.profileUrl || '',
                      platform: inf.platform || 'TikTok',
                      id: inf.id || '',
                      name: inf.name || '',
                      followers: inf.followers || '0',
                      views: inf.views || '0',
                      reason: inf.reason || '',
                      isRecommended: inf.isRecommended,
                      analysis: inf.analysis || '',
                      score: inf.score
                    }));
                } else if (lastMessage.content) {
                  const influencerRegex = /\[INFLUENCER:([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^\]]*?)\]/g;
                  let match;
                  while ((match = influencerRegex.exec(lastMessage.content)) !== null) {
                    influencerMatches.push({
                      avatar: match[1],
                      profileUrl: match[2],
                      platform: match[3],
                      id: match[4],
                      name: match[5],
                      followers: match[6],
                      views: match[7],
                      reason: match[8],
                      isRecommended: match[9] === '1' ? true : (match[9] === '0' ? false : null),
                      analysis: match[10] ? match[10].replace(/；/g, ':') : null,
                      score: null
                    });
                  }
                }

                // 只显示分析红人匹配度步骤（流式展示）
                const analyzeMatchSteps = browserSteps?.filter(step => step.id === 'analyze_match') || [];

                const currentStep = browserSteps?.find(s => s.status === 'running' && s.id === 'analyze_match') 
                  || browserSteps?.find(s => s.id === 'analyze_match');
                const currentScreenshot = (screenshots && screenshots.length > 0)
                  ? screenshots.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
                  : null;

                // 浏览器标题：显示“正在浏览 xx网址”，忽略“滚动/滑动”等技术细节
                let browserStatusLabel = "浏览器";
                const allScreenshotsSorted = (screenshots || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                const isScrollLabel = (label) =>
                  typeof label === "string" && /滚动|滑动|scroll/i.test(label);
                const buildBrowseText = (label) => {
                  if (!label) return null;
                  const urlMatch = label.match(/https?:\/\/[^\s)]+/);
                  if (urlMatch && urlMatch[0]) {
                    return `正在浏览 ${urlMatch[0]}`;
                  }
                  return label;
                };

                if (currentScreenshot && currentScreenshot.label) {
                  if (!isScrollLabel(currentScreenshot.label)) {
                    browserStatusLabel = buildBrowseText(currentScreenshot.label) || "浏览器";
                  } else {
                    // 当前是滚动等操作时，回退到最近一个“非滚动”截图的地址
                    const stableShot = [...allScreenshotsSorted]
                      .reverse()
                      .find(s => s.label && !isScrollLabel(s.label));
                    if (stableShot) {
                      browserStatusLabel = buildBrowseText(stableShot.label) || "浏览器";
                    }
                  }
                }

                if (source?.workerHost || source?.workerId) {
                  const workerLabel = source.workerHost || source.workerId;
                  browserStatusLabel = `${browserStatusLabel}（${workerLabel}）`;
                }

                const liveTopTitle = isExecutionPhase ? "红人画像分析" : "红人画像确认";
                return (
                  <div
                    id="right-panel-split-container"
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column"
                    }}
                  >
                    {/* 上：LLM 红人分析文档（默认 1:1，可上下拖拽调整高度） */}
                    <div style={{
                      flex: rightPanelSplit,
                      minHeight: 0,
                      border: "1px solid #E5E7EB",
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: "#FFFFFF",
                      display: "flex",
                      flexDirection: "column"
                    }}>
                      <div style={{
                        padding: "10px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#6B7280",
                        backgroundColor: "#F9FAFB",
                        borderBottom: "1px solid #E5E7EB"
                      }}>
                        {liveTopTitle}
                      </div>
                      <div style={{
                        flex: 1,
                        minHeight: 0,
                        overflowY: "auto",
                        padding: "12px"
                      }}>
                        {/* 红人画像确认文档：为每位红人输出一段结构化分析，并在顶部补充用户名/链接/推荐结论 */}
                        {influencerMatches.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            {influencerMatches.map((inf, idx) => (
                              <div
                                key={`doc-${inf.id || idx}-${idx}`}
                                style={{
                                  paddingTop: idx === 0 ? 0 : 12,
                                  marginTop: idx === 0 ? 0 : 12,
                                  borderTop: idx === 0 ? "none" : "1px solid #E5E7EB"
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                                    {inf.profileUrl ? (
                                      <a href={inf.profileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                                        @{inf.id || inf.name}
                                      </a>
                                    ) : (
                                      `@${inf.id || inf.name}`
                                    )}
                                  </div>
                                  <div style={{ fontSize: 11, color: "#6B7280" }}>
                                    {inf.isRecommended === true
                                      ? "✅ 推荐"
                                      : inf.isRecommended === false
                                      ? "❌ 不推荐"
                                      : "⏳ 分析中"}
                                  </div>
                                </div>
                                {/* 中段：各个维度的详细分析（来自 LLM 输出的结构化 Markdown 文本） */}
                                {inf.analysis && (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: "#1F2937",
                                      lineHeight: 1.7,
                                      whiteSpace: "pre-wrap"
                                    }}
                                  >
                                    {inf.analysis}
                                  </div>
                                )}
                                {/* 底部：基于 isRecommended / score / reason 的结论小结 */}
                                {(inf.isRecommended != null || inf.score != null || inf.reason) && (
                                  <div
                                    style={{
                                      marginTop: 8,
                                      paddingTop: 6,
                                      borderTop: "1px solid #E5E7EB",
                                      fontSize: 12,
                                      color: "#374151"
                                    }}
                                  >
                                    <div style={{ fontWeight: 600, marginBottom: 4 }}>结论</div>
                                    {inf.score != null && (
                                      <div style={{ marginBottom: 2 }}>
                                        匹配度：{inf.score}/100
                                      </div>
                                    )}
                                    <div style={{ marginBottom: inf.reason ? 2 : 0 }}>
                                      推荐结论：
                                      {inf.isRecommended === true
                                        ? "✅ 推荐"
                                        : inf.isRecommended === false
                                        ? "❌ 不推荐"
                                        : "⏳ 分析中"}
                                    </div>
                                    {inf.reason && (
                                      <div>
                                        理由：{inf.reason}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 当前正在分析但还未形成红人卡片的流式文档（可选） */}
                        {(() => {
                          if (!analyzeMatchSteps || analyzeMatchSteps.length === 0) return null;
                          // 找到一个“正在分析中但还没有出现在 influencerMatches 里的红人”
                          const pendingStep = analyzeMatchSteps
                            .filter(s => s && typeof s.detail === 'string' && s.detail.trim())
                            .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
                            .slice(-1)[0];
                          if (!pendingStep || !pendingStep.detail) return null;

                          const analyzingId = pendingStep.stats?.analyzing;
                          const alreadyInMatches = analyzingId &&
                            influencerMatches.some(inf => inf.id === analyzingId || inf.name === analyzingId);
                          if (alreadyInMatches) return null;

                          return (
                            <div style={{
                              marginTop: influencerMatches.length > 0 ? 16 : 0,
                              paddingTop: influencerMatches.length > 0 ? 12 : 0,
                              borderTop: influencerMatches.length > 0 ? "1px solid #E5E7EB" : "none",
                              fontSize: 12,
                              color: "#1F2937",
                              lineHeight: 1.7,
                              whiteSpace: "pre-wrap"
                            }}>
                              {analyzingId && (
                                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                                  @{analyzingId}（分析中）
                                </div>
                              )}
                              {pendingStep.detail}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* 上下拖拽分隔条（与左右分割条一致） */}
                    <div
                      className="vertical-panel-splitter"
                      onMouseDown={handleVerticalMouseDown}
                      style={{
                        height: "4px",
                        cursor: "row-resize",
                        margin: "4px 0",
                        flexShrink: 0,
                        backgroundColor: "#E5E7EB",
                        transition: "background-color 0.2s",
                        zIndex: 10
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "#0F172A";
                      }}
                      onMouseLeave={(e) => {
                        if (!isVerticalResizingRef.current) {
                          e.currentTarget.style.backgroundColor = "#E5E7EB";
                        }
                      }}
                    />

                    {/* 下：浏览器（默认 1:1，可上下拖拽调整高度） */}
                    <div style={{
                      flex: 100 - rightPanelSplit,
                      minHeight: 0,
                      border: "1px solid #E5E7EB",
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: "#FFFFFF",
                      display: "flex",
                      flexDirection: "column"
                    }}>
                      <div style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#6B7280",
                      backgroundColor: "#F9FAFB",
                      borderBottom: "1px solid #E5E7EB"
                    }}>
                        <span className={currentScreenshot ? "browser-status-blink" : undefined}>
                          {browserStatusLabel}
                        </span>
                      </div>
                      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                        {currentScreenshot ? (
                          <>
                            <img
                              src={currentScreenshot.image}
                              alt={currentScreenshot.label}
                              style={{ width: "100%", height: "auto", display: "block" }}
                            />
                            {currentScreenshot?.truncated && (
                              <div style={{
                                padding: "8px 12px",
                                fontSize: 11,
                                color: "#F59E0B",
                                backgroundColor: "#FEF3C7",
                                borderTop: "1px solid #FCD34D"
                              }}>
                                ⚠️ 提示：截图数据较大，已压缩保存
                              </div>
                            )}
                          </>
                        ) : (
                          <div style={{
                            padding: "24px 12px",
                            textAlign: "center",
                            color: "#9CA3AF",
                            fontSize: 13
                          }}>
                            暂无截图（Agent 开始浏览后会自动显示）
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {loginOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "rgba(255, 255, 255, 0.65)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            boxSizing: "border-box",
          }}
        >
          <form
            onSubmit={submitLogin}
            style={{
              width: "100%",
              maxWidth: 380,
              background: "#FFFFFF",
              border: "1px solid #E5E7EB",
              borderRadius: 14,
              padding: "28px 24px",
              boxShadow:
                "0 0 0 1px rgba(15, 23, 42, 0.04), 0 12px 40px rgba(15, 23, 42, 0.08)",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                color: "#111827",
                fontSize: 17,
                fontWeight: 600,
                marginBottom: 6,
                letterSpacing: "-0.02em",
              }}
            >
              登录 Maxin AI
            </div>
            <div
              style={{
                color: "#6B7280",
                fontSize: 12,
                marginBottom: 22,
                lineHeight: 1.55,
              }}
            >
              请输入Maxin AI销售提供的账户信息
            </div>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 500,
                color: "#6B7280",
                marginBottom: 6,
              }}
            >
              公司名
            </label>
            <input
              value={loginCompany}
              onChange={(e) => setLoginCompany(e.target.value)}
              autoComplete="organization"
              style={{
                width: "100%",
                marginBottom: 14,
                padding: "11px 12px",
                borderRadius: 10,
                border: "1px solid #E5E7EB",
                background: "#FAFAFA",
                color: "#111827",
                fontSize: 14,
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 500,
                color: "#6B7280",
                marginBottom: 6,
              }}
            >
              用户名
            </label>
            <input
              value={loginUser}
              onChange={(e) => setLoginUser(e.target.value)}
              autoComplete="username"
              style={{
                width: "100%",
                marginBottom: 14,
                padding: "11px 12px",
                borderRadius: 10,
                border: "1px solid #E5E7EB",
                background: "#FAFAFA",
                color: "#111827",
                fontSize: 14,
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 500,
                color: "#6B7280",
                marginBottom: 6,
              }}
            >
              密码（6 位数字）
            </label>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={loginPass}
              onChange={(e) => setLoginPass(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="current-password"
              style={{
                width: "100%",
                marginBottom: 8,
                padding: "11px 12px",
                borderRadius: 10,
                border: "1px solid #E5E7EB",
                background: "#FAFAFA",
                color: "#111827",
                fontSize: 14,
                boxSizing: "border-box",
                outline: "none",
                letterSpacing: "0.12em",
              }}
            />
            {loginErr ? (
              <div style={{ color: "#DC2626", fontSize: 12, marginTop: 4 }}>{loginErr}</div>
            ) : null}
            <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => {
                  setLoginOpen(false);
                  setLoginErr("");
                  pendingSendRef.current = null;
                }}
                style={{
                  padding: "9px 16px",
                  fontSize: 13,
                  color: "#6B7280",
                  background: "#FFFFFF",
                  border: "1px solid #E5E7EB",
                  borderRadius: 10,
                  cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loginBusy}
                style={{
                  padding: "9px 20px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#FFFFFF",
                  background: loginBusy ? "#9CA3AF" : "#111827",
                  border: "none",
                  borderRadius: 10,
                  cursor: loginBusy ? "not-allowed" : "pointer",
                }}
              >
                {loginBusy ? "登录中…" : "登录"}
              </button>
            </div>
          </form>
        </div>
      )}

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.7;
          }
        }
        .thinking-step-running {
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes browserBlink {
          0% {
            opacity: 0.6;
          }
          100% {
            opacity: 1;
          }
        }
        .browser-status-blink {
          animation: browserBlink 1.2s ease-in-out infinite alternate;
        }
      `}</style>
    </div>
  );
}
