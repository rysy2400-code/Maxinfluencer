"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { formatTime, Pill } from "./shared-ui";

/** 与 lib/db/influencer-inbox-by-project-dao.js 中 EXECUTION_STAGE_ORDER 保持一致 */
const EXECUTION_STAGE_ORDER = [
  "pending_quote",
  "quote_submitted",
  "quote_rejected",
  "pending_sample",
  "pending_draft",
  "draft_submitted",
  "published",
];

const STAGE_LABEL = {
  pending_quote: "待报价",
  quote_submitted: "已提交报价",
  quote_rejected: "报价被拒",
  pending_sample: "待寄样",
  pending_draft: "待交稿",
  draft_submitted: "已交稿",
  published: "已发布",
};

const STATUS_LABEL = {
  running: "进行中",
  paused: "已暂停",
  completed: "已结项",
};

function stageLabel(stage) {
  return STAGE_LABEL[stage] || stage || "—";
}

export function findSelectionPath(accounts, orphans, influencerId) {
  if (!influencerId) return null;
  for (const acc of accounts || []) {
    const aid = acc.advertiserUserId;
    for (const st of ["running", "paused", "completed"]) {
      for (const camp of acc[st]?.campaigns || []) {
        if ((camp.influencers || []).some((x) => x.influencerId === influencerId)) {
          return { type: "campaign", advertiserUserId: aid, status: st, campaignId: camp.campaignId };
        }
      }
    }
  }
  if ((orphans || []).some((o) => o.influencerId === influencerId)) {
    return { type: "orphan" };
  }
  return null;
}

function isCampaignOpen(campaignId, onPath, campPref) {
  const k = `camp:${campaignId}`;
  if (Object.prototype.hasOwnProperty.call(campPref, k)) {
    return campPref[k] === true;
  }
  return !!onPath;
}

function isAccountOpen(advertiserUserId, path, accPref) {
  const k = `acc:${advertiserUserId}`;
  if (Object.prototype.hasOwnProperty.call(accPref, k)) {
    return accPref[k] === true;
  }
  if (!path || path.type === "orphan") return false;
  return path.advertiserUserId === advertiserUserId;
}

export function ProjectInboxList({
  accounts,
  orphans,
  influencerId,
  listScrollRef,
  accountPref,
  campPref,
  onToggleAccount,
  onToggleCampaign,
}) {
  const path = useMemo(
    () => findSelectionPath(accounts, orphans, influencerId),
    [accounts, orphans, influencerId]
  );

  const renderInfluencerRow = (inf) => {
    const active = inf.influencerId === influencerId;
    return (
      <Link
        key={`${inf.influencerId}`}
        href={`/influencers/${encodeURIComponent(inf.influencerId)}`}
        scroll={false}
        data-influencer-row
        data-influencer-id={inf.influencerId}
        style={{
          display: "block",
          padding: "8px 10px 8px 14px",
          borderBottom: "1px solid rgba(0,0,0,0.04)",
          background: active ? "#C4C4C4" : "transparent",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 4,
              background: "#C8C8C8",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            {(inf.displayName || inf.username || inf.influencerId || "?").slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              {inf.displayName || inf.username || inf.influencerId}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#666",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {inf.lastEventTime ? formatTime(inf.lastEventTime) : "—"} ·{" "}
              {(inf.lastPreview?.bodyText || inf.lastPreview?.subject || "").slice(0, 32) || "…"}
            </div>
          </div>
          <Pill tone={inf.handoverMode === "auto" ? "green" : "neutral"}>
            {inf.handoverMode === "auto" ? "全托管" : "半托管"}
          </Pill>
        </div>
      </Link>
    );
  };

  const renderCampaignBlock = (acc, st, camp) => {
    const onPath =
      path &&
      path.type === "campaign" &&
      path.advertiserUserId === acc.advertiserUserId &&
      path.status === st &&
      path.campaignId === camp.campaignId;
    const open = isCampaignOpen(camp.campaignId, onPath, campPref);
    const statusTag = STATUS_LABEL[camp.campaignStatus] || camp.campaignStatus;

    const byStage = new Map();
    for (const s of EXECUTION_STAGE_ORDER) {
      byStage.set(s, []);
    }
    const other = [];
    for (const inf of camp.influencers || []) {
      if (byStage.has(inf.executionStage)) {
        byStage.get(inf.executionStage).push(inf);
      } else {
        other.push(inf);
      }
    }

    return (
      <div
        key={camp.campaignId}
        style={{ borderBottom: "1px solid rgba(0,0,0,0.06)", background: "#EAEAEA" }}
        data-campaign-id={camp.campaignId}
      >
        <button
          type="button"
          onClick={() => onToggleCampaign(camp.campaignId, !open)}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "8px 10px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontWeight: 800,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span>{open ? "▼" : "▶"}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{camp.brandProduct}</span>
          <Pill tone="blue">{statusTag}</Pill>
        </button>
        {open ? (
          <div style={{ paddingBottom: 4 }}>
            {EXECUTION_STAGE_ORDER.map((stage) => {
              const rows = byStage.get(stage) || [];
              if (!rows.length) return null;
              const anchorActive =
                influencerId && rows.some((r) => r.influencerId === influencerId);
              return (
                <div key={stage}>
                  <div
                    data-stage-anchor={stage}
                    data-send-scroll={anchorActive ? "1" : undefined}
                    style={{
                      padding: "4px 12px",
                      fontSize: 11,
                      fontWeight: 800,
                      color: "#555",
                      background: "rgba(0,0,0,0.04)",
                    }}
                  >
                    {stageLabel(stage)}
                  </div>
                  {rows.map((inf) => renderInfluencerRow(inf))}
                </div>
              );
            })}
            {other.length ? (
              <div>
                <div
                  data-stage-anchor="_other"
                  data-send-scroll={
                    influencerId && other.some((r) => r.influencerId === influencerId) ? "1" : undefined
                  }
                  style={{
                    padding: "4px 12px",
                    fontSize: 11,
                    fontWeight: 800,
                    color: "#555",
                    background: "rgba(0,0,0,0.04)",
                  }}
                >
                  其他阶段
                </div>
                {other.map((inf) => renderInfluencerRow(inf))}
              </div>
            ) : null}
            {!(camp.influencers || []).length ? (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "#888" }}>（暂无红人）</div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderStatusColumn = (acc, statusKey) => {
    const camps = acc[statusKey]?.campaigns || [];
    const title = STATUS_LABEL[statusKey] || statusKey;
    return (
      <div key={statusKey} style={{ marginBottom: 8 }}>
        <div
          style={{
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 800,
            color: "#333",
            background: "rgba(0,0,0,0.05)",
          }}
        >
          {title}
        </div>
        {camps.length === 0 ? (
          <div style={{ padding: "6px 10px", fontSize: 11, color: "#999" }}>暂无项目</div>
        ) : (
          camps.map((camp) => renderCampaignBlock(acc, statusKey, camp))
        )}
      </div>
    );
  };

  return (
    <div ref={listScrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
      {(orphans || []).length ? (
        <div style={{ borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
          <div
            style={{
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 800,
              background: "rgba(0,0,0,0.06)",
            }}
          >
            未进入任何 campaign
          </div>
          {(orphans || []).map((inf) => renderInfluencerRow(inf))}
        </div>
      ) : null}

      {(accounts || []).map((acc) => {
        const accOpen = isAccountOpen(acc.advertiserUserId, path, accountPref);
        const label = `${acc.companyName || "—"} · ${acc.advertiserUsername || "—"}`;
        return (
          <div key={String(acc.advertiserUserId)} style={{ borderBottom: "1px solid rgba(0,0,0,0.1)" }}>
            <button
              type="button"
              onClick={() => onToggleAccount(acc.advertiserUserId, !accOpen)}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                border: "none",
                background: "#E0E0E0",
                cursor: "pointer",
                fontWeight: 800,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>{accOpen ? "▼" : "▶"}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
            </button>
            {accOpen ? (
              <div style={{ padding: "4px 4px 8px" }}>
                {renderStatusColumn(acc, "running")}
                {renderStatusColumn(acc, "paused")}
                {renderStatusColumn(acc, "completed")}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
