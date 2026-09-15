/**
 * 回填 last_event.publishedVideos：把红人来信里的多平台发布链接补进执行行。
 *
 * 背景：改造前只保留最后一次回传的单个 videoLink，多平台链接会互相覆盖；
 * 本脚本从「红人来信正文」（对话记忆 + 邮件事件表）补齐缺失的平台条目。
 *
 * 安全策略：
 * - 默认 dry-run，只打印将要写入的内容；加 --apply 才写库；
 * - 只新增，不删除已有条目、不覆盖已抓到的 metrics；
 * - 只扫描发布时间窗口 ±10 天内的红人来信，避免串到其它 campaign。
 *
 * 用法：
 *   node scripts/backfill-published-videos.mjs
 *   node scripts/backfill-published-videos.mjs --campaign=CAMP-xxx
 *   node scripts/backfill-published-videos.mjs --apply
 */

import dotenv from "dotenv";
import path from "path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";
import { extractPublishedLinksFromEmailBody } from "../lib/execution/published-link-extraction.js";
import {
  resolvePublishedVideos,
  mergePublishedVideos,
} from "../lib/execution/published-videos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const WINDOW_DAYS = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const campaignArg = args.find((a) => a.startsWith("--campaign="));
  return {
    apply,
    campaignId: campaignArg ? campaignArg.split("=")[1] : null,
  };
}

async function loadPublishedRows(campaignId) {
  const where = ["e.stage = 'published'", "c.deleted_at IS NULL"];
  const params = [];
  if (campaignId) {
    where.push("e.campaign_id = ?");
    params.push(campaignId);
  }
  return queryTikTok(
    `
    SELECT
      e.campaign_id,
      e.tiktok_username,
      e.influencer_id,
      e.video_link,
      e.last_event
    FROM tiktok_campaign_execution e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
    WHERE ${where.join(" AND ")}
    ORDER BY e.updated_at DESC
    `,
    params
  );
}

/** 时间窗口内该红人的来信正文（对话记忆 + 邮件事件表，按 message_id 去重） */
async function loadInboundEmailBodies({ influencerId, fromIso, toIso }) {
  const out = new Map();
  const [convRows, eventRows] = await Promise.all([
    queryTikTok(
      `
      SELECT message_id, body_text, sent_at
      FROM tiktok_influencer_conversation_messages
      WHERE influencer_id = ?
        AND direction = 'influencer'
        AND sent_at BETWEEN ? AND ?
      ORDER BY sent_at ASC
      LIMIT 500
      `,
      [influencerId, fromIso, toIso]
    ),
    queryTikTok(
      `
      SELECT message_id, body_text, received_at
      FROM tiktok_influencer_email_events
      WHERE influencer_id = ?
        AND received_at BETWEEN ? AND ?
      ORDER BY received_at ASC
      LIMIT 500
      `,
      [influencerId, fromIso, toIso]
    ).catch(() => []),
  ]);
  for (const row of [...(convRows || []), ...(eventRows || [])]) {
    const key =
      row.message_id || `body:${String(row.body_text || "").slice(0, 120)}`;
    if (!row.body_text || out.has(key)) continue;
    out.set(key, row.body_text);
  }
  return [...out.values()];
}

function windowForEntries(entries) {
  const times = entries
    .map((e) => (e.publishedAt ? new Date(e.publishedAt).getTime() : null))
    .filter((t) => Number.isFinite(t));
  const anchor = times.length ? Math.max(...times) : Date.now();
  const earliest = times.length ? Math.min(...times) : anchor;
  return {
    from: new Date(earliest - WINDOW_DAYS * 86400 * 1000).toISOString(),
    to: new Date(anchor + WINDOW_DAYS * 86400 * 1000).toISOString(),
  };
}

async function processRow(row, { apply }) {
  const lastEvent =
    row.last_event && typeof row.last_event === "object"
      ? row.last_event
      : JSON.parse(row.last_event || "{}");
  const existing = resolvePublishedVideos(lastEvent, {
    videoLink: row.video_link,
  });
  const { from, to } = windowForEntries(existing);
  const bodies = await loadInboundEmailBodies({
    influencerId: row.influencer_id || row.tiktok_username,
    fromIso: from,
    toIso: to,
  });

  const found = [];
  for (const body of bodies) {
    for (const link of extractPublishedLinksFromEmailBody(body)) found.push(link);
  }

  const merged = mergePublishedVideos(existing, found);
  const before = new Set(existing.map((e) => `${e.platform}|${e.url}`));
  const added = merged.filter((e) => !before.has(`${e.platform}|${e.url}`));

  console.log(
    `\n[${row.campaign_id}] @${row.tiktok_username} 来信 ${bodies.length} 封；现有 ${existing.length} 条 → 合并后 ${merged.length} 条`
  );
  for (const e of merged) {
    const isNew = added.some((a) => a.platform === e.platform && a.url === e.url);
    console.log(`  ${isNew ? "＋新增" : "  已有"} ${String(e.platform).padEnd(9)} ${e.url}`);
  }

  if (!added.length) return { added: 0, written: false };
  if (!apply) return { added: added.length, written: false };

  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET last_event = ?,
        video_link = COALESCE(?, video_link)
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
    `,
    [
      JSON.stringify({ ...lastEvent, publishedVideos: merged }),
      row.video_link || merged[0]?.url || null,
      row.campaign_id,
      ...paramsExecutionCreatorMatch(row.influencer_id || row.tiktok_username),
    ]
  );
  return { added: added.length, written: true };
}

async function main() {
  const { apply, campaignId } = parseArgs();
  const rows = await loadPublishedRows(campaignId);
  console.log(
    `[BackfillPublishedVideos] ${apply ? "APPLY" : "DRY-RUN"}：published 执行行 ${rows.length} 条。`
  );

  let totalAdded = 0;
  let totalWritten = 0;
  for (const row of rows) {
    const r = await processRow(row, { apply });
    totalAdded += r.added;
    if (r.written) totalWritten += 1;
  }

  console.log(
    `\n[BackfillPublishedVideos] 完成：新增 ${totalAdded} 条平台链接，写库 ${totalWritten} 行。${
      apply ? "" : "（dry-run，未写库；加 --apply 生效）"
    }`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[BackfillPublishedVideos] 运行出错:", err);
    process.exit(1);
  });
