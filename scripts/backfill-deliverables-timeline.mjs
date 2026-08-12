/**
 * 回填 tiktok_campaign_execution.last_event.deliverablesTimeline
 *
 * 把存量「草稿/已发布」阶段数据（脚本在邮件正文 / draftLink / 修改建议 / 通过标记 / 发布链接）
 * 补成结构化交付时间线，供前端「待审核草稿」卡片直接展示。
 *
 * 用法：
 *   node scripts/backfill-deliverables-timeline.mjs            # 干跑，只预览不写库
 *   node scripts/backfill-deliverables-timeline.mjs --apply    # 真正回填
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { listInboundAttachmentsByEmailEventId } from "../lib/db/influencer-inbound-attachments-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const APPLY = process.argv.includes("--apply");

function parseJsonOrObject(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 从邮件正文抽取脚本段落：优先从 ON-SCREEN HOOK / VOICEOVER 起始，否则整封正文 */
function extractScriptFromBody(body) {
  const text = String(body || "").trim();
  if (!text) return null;
  const m = text.match(
    /(?:\*?\bON-SCREEN HOOK\b\*?|\bON_SCREEN_HOOK\b|\bVOICEOVER\b|\bVISUALS?\b)[\s\S]*/i
  );
  return m ? m[0].trim() : text;
}

function isScriptLike(le, bodyText) {
  const note = String(le?.campaignAgentDecision?.note || "").toLowerCase();
  const text = String(bodyText || "").toLowerCase();
  return (
    /脚本|script/.test(note) ||
    /on-screen hook|on_screen_hook|voiceover|attached a script|script idea/.test(
      text
    )
  );
}

async function buildTimeline(row) {
  const le = parseJsonOrObject(row.last_event) || {};
  if (!le || typeof le !== "object") return null;
  if (Array.isArray(le.deliverablesTimeline) && le.deliverablesTimeline.length) {
    return null; // 已有时间线，跳过
  }

  const decision = le.campaignAgentDecision || {};
  const bodyText =
    typeof decision?.emailEvent?.bodyText === "string"
      ? decision.emailEvent.bodyText
      : "";
  const scriptLike = isScriptLike(le, bodyText);
  const draftLink = le.draftLink || null;
  const videoLink = le.videoLink || row.video_link || null;
  const scriptApproved = Boolean(le.scriptApprovedAt);
  const draftApproved = Boolean(le.draftApprovedAt);

  let submittedKind = null;
  if (scriptLike) submittedKind = "script";
  else if (draftLink) submittedKind = "video_draft";

  // 附件：历史事件里如果恰好只有一个附件，且提交内容没有链接/正文脚本，则关联该附件
  let attachmentMeta = null;
  if (submittedKind && !draftLink) {
    const eventId = Number(decision?.emailEvent?.id);
    if (eventId > 0) {
      const atts = await listInboundAttachmentsByEmailEventId(eventId).catch(
        () => []
      );
      if (atts.length === 1) {
        attachmentMeta = {
          inboundAttachmentId: atts[0].inboundAttachmentId,
          filename: atts[0].filename,
          contentType: atts[0].contentType,
        };
      }
    }
  }

  const submittedAt =
    le.draftSubmittedAt || le.draftLinkSavedAt || decision?.updatedAt || null;
  const feedbackAt = le.draftRejectedAt || null;
  const approvedAt = scriptApproved
    ? le.scriptApprovedAt
    : draftApproved
    ? le.draftApprovedAt
    : null;

  const entries = [];
  if (submittedKind) {
    entries.push({
      kind: submittedKind,
      role: "influencer",
      type: "submitted",
      content:
        submittedKind === "script"
          ? scriptLike
            ? extractScriptFromBody(bodyText)
            : null
          : null,
      link: draftLink || null,
      attachment: attachmentMeta,
      at: toIso(submittedAt) || toIso(row.updated_at),
      source: "backfill",
      note: submittedKind === "script" && !draftLink ? "脚本在邮件正文中" : null,
    });
  }

  if (le.draftFeedback) {
    entries.push({
      kind: submittedKind || "video_draft",
      role: "advertiser",
      type: "feedback",
      content: String(le.draftFeedback).slice(0, 2000),
      link: draftLink || null,
      at: toIso(feedbackAt) || null,
      source: "backfill",
    });
  }

  if (approvedAt) {
    entries.push({
      kind: scriptApproved ? "script" : "video_draft",
      role: "advertiser",
      type: "approved",
      link: draftLink || null,
      at: toIso(approvedAt) || null,
      source: "backfill",
    });
  }

  if (videoLink) {
    entries.push({
      kind: "published",
      role: "influencer",
      type: "published_link",
      link: videoLink,
      content: le.promoCode ? `投流码: ${le.promoCode}` : null,
      promoCode: le.promoCode || null,
      at: toIso(le.publishedAt) || toIso(row.updated_at),
      source: "backfill",
    });
  }

  if (!entries.length) return null;
  return entries;
}

const rows = await queryTikTok(
  `
  SELECT id, campaign_id, tiktok_username, stage, last_event, video_link, updated_at
  FROM tiktok_campaign_execution
  WHERE stage IN ('pending_draft', 'draft_submitted', 'published')
    AND last_event IS NOT NULL
  ORDER BY updated_at DESC
  LIMIT 3000
  `
);

let changed = 0;
let skipped = 0;
let withTimeline = 0;

for (const row of rows) {
  const entries = await buildTimeline(row);
  if (!entries) {
    const le = parseJsonOrObject(row.last_event) || {};
    if (Array.isArray(le.deliverablesTimeline) && le.deliverablesTimeline.length) {
      withTimeline += 1;
    } else {
      skipped += 1;
    }
    continue;
  }

  const le = parseJsonOrObject(row.last_event) || {};
  le.deliverablesTimeline = entries;
  le.deliverablesBackfilledAt = new Date().toISOString();

  if (APPLY) {
    await queryTikTok(
      `UPDATE tiktok_campaign_execution SET last_event = ? WHERE id = ?`,
      [JSON.stringify(le), row.id]
    );
  }
  changed += 1;
  if (changed <= 25) {
    console.log(
      `- ${row.campaign_id} / @${row.tiktok_username} (${row.stage}): ${entries
        .map((e) => `${e.role}:${e.type}:${e.kind}`)
        .join(" → ")}`
    );
  }
}

console.log(
  `\n[backfill] 共 ${rows.length} 行草稿/已发布数据；新增时间线 ${changed} 行，已有时间线 ${withTimeline} 行，无内容可回填 ${skipped} 行。${
    APPLY ? "已写库" : "干跑模式，加 --apply 才会写库"
  }`
);
