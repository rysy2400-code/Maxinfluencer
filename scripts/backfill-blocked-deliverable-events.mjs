/**
 * 回填「交付已提交但阶段推进被拦截」的脚本/视频草稿记录。
 *
 * 读取 tiktok_advertiser_agent_event 中已成功处理的事件，仅当：
 * - 报价已确认（execution.last_event.quoteApprovedAt 存在）
 * - 事件包含带正文、链接或附件的 script / video_draft deliverable
 * - deliverablesTimeline 尚无同一 emailEventId + kind 的提交记录
 * 时，把交付记录追加到 last_event.deliverablesTimeline。
 *
 * 不修改 stage，不修改邮件和附件原始数据。
 *
 * 用法：
 *   node scripts/backfill-blocked-deliverable-events.mjs --event 8530
 *   node scripts/backfill-blocked-deliverable-events.mjs --event 8530 --apply
 */

import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { listInboundAttachmentsByEmailEventId } from "../lib/db/influencer-inbound-attachments-dao.js";

const APPLY = process.argv.includes("--apply");
const eventIds = [];
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== "--event") continue;
  const eventId = Number(process.argv[i + 1]);
  if (Number.isInteger(eventId) && eventId > 0) eventIds.push(eventId);
  i += 1;
}

if (!eventIds.length) {
  console.error(
    "用法：node scripts/backfill-blocked-deliverable-events.mjs --event <id> [--event <id> ...] [--apply]"
  );
  process.exit(1);
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hasConcreteDeliverable(deliverable) {
  return (
    deliverable &&
    typeof deliverable === "object" &&
    ["script", "video_draft"].includes(deliverable.kind) &&
    [deliverable.content, deliverable.link, deliverable.attachmentFilename].some(
      (value) => typeof value === "string" && value.trim() !== ""
    )
  );
}

const placeholders = eventIds.map(() => "?").join(", ");
const events = await queryTikTok(
  `
  SELECT id, campaign_id, influencer_id, event_type, status, payload, updated_at
  FROM tiktok_advertiser_agent_event
  WHERE id IN (${placeholders})
  ORDER BY id ASC
  `,
  eventIds
);

let appendedCount = 0;
let skippedCount = 0;

for (const event of events || []) {
  const payload = parseJson(event.payload) || {};
  const deliverable = payload.deliverable;
  if (
    event.event_type !== "execution_update_suggested" ||
    event.status === "failed" ||
    !hasConcreteDeliverable(deliverable)
  ) {
    console.log(`- 跳过事件 ${event.id}：不是有效的脚本/视频草稿交付事件`);
    skippedCount += 1;
    continue;
  }

  const rows =
    (await queryTikTok(
      `
      SELECT id, campaign_id, tiktok_username, stage, infl_event_seq,
             infl_card_seq, last_event
      FROM tiktok_campaign_execution
      WHERE campaign_id = ? AND influencer_id = ?
      LIMIT 1
      `,
      [event.campaign_id, event.influencer_id]
    )) || [];
  const execution = rows[0];
  const lastEvent = parseJson(execution?.last_event) || {};
  if (!execution || !lastEvent.quoteApprovedAt) {
    console.log(`- 跳过事件 ${event.id}：执行行缺失或报价尚未确认`);
    skippedCount += 1;
    continue;
  }

  const timeline = Array.isArray(lastEvent.deliverablesTimeline)
    ? lastEvent.deliverablesTimeline
    : [];
  const emailEventId = Number(payload.emailEvent?.id || event.id);
  const kind = deliverable.kind;
  const alreadyRecorded = timeline.some(
    (entry) =>
      Number(entry?.emailEventId) === emailEventId &&
      entry?.role === "influencer" &&
      entry?.type === "submitted" &&
      entry?.kind === kind
  );
  if (alreadyRecorded) {
    console.log(`- 跳过事件 ${event.id}：交付记录已存在`);
    skippedCount += 1;
    continue;
  }

  const attachments = await listInboundAttachmentsByEmailEventId(emailEventId);
  const wantedFilename = deliverable.attachmentFilename;
  let attachment =
    (wantedFilename &&
      attachments.find((item) => item.filename === wantedFilename)) ||
    (!wantedFilename && attachments.length === 1 ? attachments[0] : null);

  const entry = {
    kind,
    role: "influencer",
    type: "submitted",
    content: deliverable.content || null,
    link: deliverable.link || payload.draftLink || null,
    emailSummary: deliverable.emailSummary || null,
    attachment: attachment
      ? {
          inboundAttachmentId: attachment.inboundAttachmentId,
          filename: attachment.filename,
          contentType: attachment.contentType,
        }
      : null,
    at: toIso(payload.emailEvent?.receivedAt || event.updated_at),
    source: "influencer_email",
    emailEventId,
    backfilledAt: new Date().toISOString(),
  };

  const nextLastEvent = {
    ...lastEvent,
    deliverablesTimeline: [...timeline, entry],
  };

  console.log(
    `- ${APPLY ? "回填" : "[DRY-RUN] 将回填"} ${execution.campaign_id} / @${execution.tiktok_username}: ` +
      `${kind}，stage=${execution.stage}（保持不变），emailEventId=${emailEventId}，` +
      `attachment=${entry.attachment?.inboundAttachmentId || "无"}`
  );
  appendedCount += 1;

  if (APPLY) {
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET last_event = ?,
          infl_event_seq = COALESCE(infl_event_seq, 0) + 1,
          infl_card_seq = COALESCE(infl_card_seq, 0) + 1
      WHERE id = ?
      `,
      [JSON.stringify(nextLastEvent), execution.id]
    );
  }
}

console.log(
  `\n[backfill-blocked-deliverables] 可回填 ${appendedCount} 条，跳过 ${skippedCount} 条。` +
    (APPLY ? "已写库。" : "干跑模式，加 --apply 才会写库。")
);
process.exit(0);
