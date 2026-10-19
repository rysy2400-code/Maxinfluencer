#!/usr/bin/env node
/**
 * 把历史发信时间回填到 op_contacts.last_send_date。
 *
 * 首封选号改为只读 op_contacts.last_send_date 做 40 分钟冷却；
 * 本脚本用于兼容该优化上线前已有的发信记录。
 *
 * 用法：
 *   node scripts/backfill-outreach-sender-last-send-date.mjs
 *   node scripts/backfill-outreach-sender-last-send-date.mjs --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
const apply = process.argv.includes("--apply");

const sql = `
  UPDATE op_contacts o
  JOIN (
    SELECT
      LOWER(TRIM(from_email)) AS email,
      MAX(COALESCE(sent_at, created_at)) AS last_at
    FROM tiktok_influencer_conversation_messages
    WHERE direction = 'bin'
      AND channel = 'email'
      AND from_email IS NOT NULL
      AND TRIM(from_email) <> ''
    GROUP BY LOWER(TRIM(from_email))
  ) m
    ON LOWER(TRIM(o.email)) COLLATE utf8mb4_unicode_ci =
       m.email COLLATE utf8mb4_unicode_ci
  SET o.last_send_date = GREATEST(
    COALESCE(o.last_send_date, '1970-01-01'),
    m.last_at
  )
`;

try {
  if (!apply) {
    console.log("[backfill-last-send] dry-run; add --apply to write");
  } else {
    const result = await queryTikTok(sql);
    console.log(
      `[backfill-last-send] matched=${result.affectedRows} changed=${result.changedRows}`
    );
  }
} finally {
  await tiktokPool.end?.();
}
