/**
 * 补发「带资料附件」的特殊请求（用于修复历史丢附件的请求）。
 *
 * 背景：正常路径由 Bin 的 ask_influencer_special_request 工具写入事件表；
 * 本脚本用于「已经发过一次、但附件被丢掉」的特殊请求补发。
 *
 * 默认 dry-run（只打印将要写入的 payload，不写库）；确认无误后加 --send 才入队。
 * 入队后由 scripts/process-influencer-agent-events.js 真正发信。
 *
 * 用法：
 *   1) 先干跑，确认 payload：
 *      node scripts/resend-special-request-with-attachments.mjs --from-event 70059 \
 *        --attachment "<storageKey>=<fileName>"
 *   2) 确认后正式入队：同上再加 --send
 *   3) 触发 worker 发信：node scripts/process-influencer-agent-events.js --only-event <eventId>
 *
 * 参数：
 *   --from-event <id>        复用已存在的 ask_influencer_special_request 事件
 *                            （取 campaignId / influencerId / requestType / brandMessage）
 *   --campaign <id>          未用 --from-event 时必填
 *   --handle <handle>        未用 --from-event 时必填（可带 @）
 *   --message <text>         未用 --from-event 时必填（brandMessage）
 *   --request-type <type>    默认 other（adjust_price / delay_publish / change_content / other）
 *   --attachment <key=name>  可重复；storageKey=文件名
 *   --send                   真正入队（缺省只干跑）
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok, tiktokPool } from "../lib/db/mysql-tiktok.js";
import { enqueueAskInfluencerSpecialRequest } from "../lib/execution/special-request-events.js";
import { readSessionImportFile } from "../lib/influencer/session-import-storage.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  normalizeAttachmentContentType,
} from "../lib/influencer/attachment-file-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function parseArgs(argv) {
  const args = { attachments: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--send") args.send = true;
    else if (arg === "--dry-run") args.send = false;
    else if (arg === "--from-event") args.fromEvent = argv[++i];
    else if (arg === "--campaign") args.campaign = argv[++i];
    else if (arg === "--handle") args.handle = argv[++i];
    else if (arg === "--message") args.message = argv[++i];
    else if (arg === "--request-type") args.requestType = argv[++i];
    else if (arg === "--attachment") args.attachments.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else console.warn(`[resend] 忽略未知参数：${arg}`);
  }
  return args;
}

function usage() {
  console.log(
    [
      "用法：node scripts/resend-special-request-with-attachments.mjs",
      "  [--from-event <eventId>] [--campaign <id>] [--handle <handle>] [--message <text>]",
      "  [--request-type <type>] [--attachment <storageKey=fileName>] [--send]",
    ].join("\n")
  );
}

function parseAttachment(raw) {
  const text = String(raw || "");
  const eq = text.indexOf("=");
  if (eq <= 0) return null;
  const storageKey = text.slice(0, eq).trim();
  const fileName = text.slice(eq + 1).trim();
  if (!storageKey || !fileName) return null;
  return { storageKey, fileName };
}

async function loadFromEvent(eventId) {
  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, event_type, payload
    FROM tiktok_influencer_agent_event
    WHERE id = ?
    LIMIT 1
  `,
    [eventId]
  );
  if (!rows?.length) throw new Error(`事件 ${eventId} 不存在`);
  const row = rows[0];
  if (row.event_type !== "ask_influencer_special_request") {
    throw new Error(`事件 ${eventId} 类型是 ${row.event_type}，不是特殊请求`);
  }
  const payload =
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload || {};
  return {
    campaignId: payload.campaignId || row.campaign_id,
    handle: payload.influencerId,
    requestType: payload.requestType || "other",
    brandMessage: payload.brandMessage || "",
    sourceSpecialRequestId: payload.specialRequestId || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  let campaignId = args.campaign;
  let handle = args.handle;
  let requestType = args.requestType || "other";
  let brandMessage = args.message;
  let sourceSpecialRequestId = null;

  if (args.fromEvent) {
    const fromEvent = await loadFromEvent(args.fromEvent);
    campaignId = campaignId || fromEvent.campaignId;
    handle = handle || fromEvent.handle;
    requestType = args.requestType || fromEvent.requestType;
    brandMessage = brandMessage || fromEvent.brandMessage;
    sourceSpecialRequestId = fromEvent.sourceSpecialRequestId;
    console.log(
      `[resend] 复用事件 ${args.fromEvent}（原 specialRequestId: ${sourceSpecialRequestId || "无"}）`
    );
  }

  if (!campaignId || !handle || !brandMessage) {
    usage();
    throw new Error("缺少 campaignId / handle / brandMessage");
  }

  const attachments = [];
  for (const raw of args.attachments) {
    const parsed = parseAttachment(raw);
    if (!parsed) {
      throw new Error(`--attachment 格式应为 storageKey=fileName，收到：${raw}`);
    }
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`单封最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
    }
    attachments.push({
      ...parsed,
      contentType: normalizeAttachmentContentType(parsed.fileName, ""),
    });
  }

  // 附件文件必须先在本机 data/session-imports 里读得到，否则 worker 发信会失败。
  for (const att of attachments) {
    const buffer = readSessionImportFile(att.storageKey);
    if (!buffer?.length) {
      throw new Error(
        `附件「${att.fileName}」在本机读不到（storageKey=${att.storageKey}）。` +
          "请确认该文件仍在 Web/worker 机器的 data/session-imports 下。"
      );
    }
    att.sizeBytes = buffer.length;
    console.log(`[resend] 附件就绪：${att.fileName}（${buffer.length} bytes）`);
  }

  console.log("\n[resend] 将写入的特殊请求：");
  console.log(
    JSON.stringify(
      {
        campaignId,
        influencerId: String(handle).replace(/^@/, ""),
        requestType,
        brandMessage,
        attachments,
      },
      null,
      2
    )
  );

  if (!args.send) {
    console.log("\n[resend] dry-run：未写库。确认无误后加 --send 正式入队。");
    return;
  }

  const result = await enqueueAskInfluencerSpecialRequest({
    campaignId,
    influencerHandle: handle,
    requestType,
    brandMessage,
    attachments,
  });

  console.log("\n[resend] 已入队 tiktok_influencer_agent_event");
  console.log("  specialRequestId:", result.specialRequestId);
  console.log("  eventId:", result.eventId);
  console.log("  platformInfluencerId:", result.platformInfluencerId);
  console.log(
    "  attachments:",
    (result.payload.attachments || []).map((a) => a.fileName).join("、") || "（无）"
  );
  console.log(
    `\n请触发 worker 发信：node scripts/process-influencer-agent-events.js --only-event ${result.eventId}`
  );
}

main()
  .catch((err) => {
    console.error("[resend] 失败：", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await tiktokPool.end().catch(() => {});
  });
