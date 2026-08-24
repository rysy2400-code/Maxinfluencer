#!/usr/bin/env node
/**
 * 执行阶段 v2 迁移（用户已确认规则）：
 * - 新增 stage：pending_script / script_review / video_review / pending_video
 * - 旧 draft_submitted 按交付时间线拆分：
 *     最新 submitted kind=video_draft -> video_review
 *     已有 scriptApprovedAt / 时间线脚本通过 -> pending_video
 *     最新 submitted kind=script -> script_review
 *     无 submitted 但有 draftLink（遗留）-> script_review
 *     其它 -> pending_script
 * - 旧 pending_draft 改名：
 *     最新 submitted kind=video_draft -> video_review
 *     已有 scriptApprovedAt -> pending_video
 *     最新 submitted kind=script -> script_review
 *     无 submitted 但有 draftLink（遗留）-> script_review
 *     其它（等待脚本）-> pending_script
 *
 * 用法：
 *   node scripts/migrate-execution-stage-v2.mjs            # dry-run
 *   node scripts/migrate-execution-stage-v2.mjs --apply    # 执行（会先 ALTER 枚举，再逐行回填）
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const APPLY = process.argv.includes("--apply");

const OLD_STAGES = ["pending_draft", "draft_submitted"];
const STAGE_ENUM = [
  "pending_quote",
  "quote_submitted",
  "pending_creator_confirmation",
  "pending_shipping_address",
  "pending_sample",
  "pending_draft",
  "draft_submitted",
  "pending_script",
  "script_review",
  "video_review",
  "pending_video",
  "published",
  "quote_rejected",
];

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function classify(row) {
  const lastEvent = parseJson(row.last_event) || {};
  const timeline = Array.isArray(lastEvent.deliverablesTimeline)
    ? lastEvent.deliverablesTimeline
    : [];
  const submitted = [...timeline]
    .reverse()
    .find((e) => e?.role === "influencer" && e?.type === "submitted");
  const latestKind = submitted?.kind || null;
  const hasScriptApproved = Boolean(
    lastEvent.scriptApprovedAt ||
      timeline.some((e) => e?.kind === "script" && e?.type === "approved")
  );
  const hasDraftLink = Boolean(lastEvent.draftLink);

  if (latestKind === "video_draft") return "video_review";
  if (hasScriptApproved) return "pending_video";
  if (latestKind === "script") return "script_review";
  if (hasDraftLink) return "script_review";
  return "pending_script";
}

async function main() {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.DB_HOST,
    port: parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || "3306", 10),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "tiktok",
    connectTimeout: 10000,
  });

  const [rows] = await c.query(
    `SELECT id, campaign_id, tiktok_username, stage, last_event
     FROM tiktok_campaign_execution
     WHERE stage IN (?, ?)`,
    OLD_STAGES
  );
  console.log(`待迁移行数：${rows.length}`);

  const bucket = { pending_script: [], script_review: [], video_review: [], pending_video: [] };
  for (const r of rows || []) {
    bucket[classify(r)].push(r);
  }

  const summary = Object.fromEntries(
    Object.entries(bucket).map(([k, v]) => [k, v.length])
  );
  console.log("回填分布：", JSON.stringify(summary, null, 2));

  if (!APPLY) {
    console.log("dry-run：未修改任何数据。加 --apply 执行。");
    await c.end();
    return;
  }

  console.log("Step 1: ALTER TABLE 扩展 stage 枚举（保留旧值以便回滚）…");
  await c.query("SET SESSION lock_wait_timeout = 120");
  await c.query(
    `ALTER TABLE tiktok_campaign_execution
     MODIFY COLUMN stage ENUM(${STAGE_ENUM.map((s) => `'${s}'`).join(",")})
     NOT NULL DEFAULT 'pending_quote' COMMENT '执行阶段'`
  );

  let updated = 0;
  for (const [target, list] of Object.entries(bucket)) {
    if (!list.length) continue;
    const ids = list.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await c.query(
        `UPDATE tiktok_campaign_execution SET stage = ?, updated_at = NOW()
         WHERE id IN (${chunk.map(() => "?").join(",")})`,
        [target, ...chunk]
      );
      updated += chunk.length;
    }
  }
  console.log(`已回填 ${updated} 行`);

  const [left] = await c.query(
    `SELECT stage, COUNT(*) n FROM tiktok_campaign_execution
     WHERE stage IN (?, ?) GROUP BY stage`,
    OLD_STAGES
  );
  console.log("迁移后旧 stage 剩余：", JSON.stringify(left || []));

  const [newDist] = await c.query(
    `SELECT stage, COUNT(*) n FROM tiktok_campaign_execution
     WHERE stage IN ('pending_script','script_review','video_review','pending_video')
     GROUP BY stage ORDER BY stage`
  );
  console.log("迁移后新 stage 分布：", JSON.stringify(newDist || []));

  await c.end();
  console.log("完成。");
}

main().catch((e) => {
  console.error("迁移失败:", e);
  process.exit(1);
});
