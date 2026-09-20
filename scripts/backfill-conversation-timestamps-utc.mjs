/**
 * 修复 tiktok_influencer_conversation_messages 的历史时间偏移（少 8 小时）
 *
 * 背景：
 * - 旧的入库代码把 UTC naive 字符串直接写进 TIMESTAMP 列，MySQL 按会话时区（+08:00）解释，
 *   导致库里存的瞬间比真实时间早 8 小时（event_time / sent_at 都是）。
 * - 入库代码已改为 CONVERT_TZ(?, '+00:00', @@session.time_zone)（见 influencer-conversation-dao），
 *   新数据已经正确，老数据需要一次性 +8 小时回填。
 *
 * 判定规则（只改证据明确的行，可重复执行）：
 * - 来信行（payload.imap.receivedAt 存在）：以邮件原始收信时间为准，少 8 小时的行 +8 小时。
 * - 其余行（我方发出 / agent 动作等）：以 created_at（入库时刻）为准，比入库早 8 小时的行 +8 小时。
 *
 * 用法：
 *   node scripts/backfill-conversation-timestamps-utc.mjs            # 干跑，只统计
 *   node scripts/backfill-conversation-timestamps-utc.mjs --apply    # 实际回填
 *   node scripts/backfill-conversation-timestamps-utc.mjs --verify   # 回填后校验
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TABLE = "tiktok_influencer_conversation_messages";
const SHIFT_HOURS = 8;
const SHIFT_MINUTES = SHIFT_HOURS * 60;
const TOLERANCE_MINUTES = 10;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const verifyOnly = args.includes("--verify");
const batchSize = (() => {
  const raw = args.find((a) => a.startsWith("--batch="));
  const n = raw ? Number(raw.split("=")[1]) : 50000;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200000) : 50000;
})();

/** payload.imap.receivedAt（ISO UTC，可能带毫秒）→ DATETIME（UTC 墙钟），用于与 CONVERT_TZ 后的列比较 */
const TRUTH_EXPR = `STR_TO_DATE(
  LEFT(REPLACE(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.imap.receivedAt')), 'T', ' '), 'Z', ''), 19),
  '%Y-%m-%d %H:%i:%s'
)`;
const HAS_TRUTH = `payload IS NOT NULL AND JSON_EXTRACT(payload, '$.imap.receivedAt') IS NOT NULL`;
/** 列值 → UTC 墙钟 DATETIME（截掉毫秒，避免 STRICT 模式下 STR_TO_DATE 截断报错） */
const AS_UTC = (col) => `LEFT(CONVERT_TZ(${col}, @@session.time_zone, '+00:00'), 19)`;

/** 来信行：比真实收信时间早 8 小时 */
const INBOUND_OFFSET = `TIMESTAMPDIFF(MINUTE, ${TRUTH_EXPR}, ${AS_UTC("event_time")}) BETWEEN -${
  SHIFT_MINUTES + TOLERANCE_MINUTES
} AND -${SHIFT_MINUTES - TOLERANCE_MINUTES}`;

/** 其余行：比入库时刻早 8 小时 */
const INSERT_OFFSET = (col) =>
  `TIMESTAMPDIFF(MINUTE, ${AS_UTC(col)}, ${AS_UTC("created_at")}) BETWEEN ${
    SHIFT_MINUTES - TOLERANCE_MINUTES
  } AND ${SHIFT_MINUTES + TOLERANCE_MINUTES}`;

function offsetCondition(col) {
  return `(
    (${HAS_TRUTH} AND TIMESTAMPDIFF(MINUTE, ${TRUTH_EXPR}, ${AS_UTC(col)}) BETWEEN -${
    SHIFT_MINUTES + TOLERANCE_MINUTES
  } AND -${SHIFT_MINUTES - TOLERANCE_MINUTES})
    OR
    (NOT (${HAS_TRUTH}) AND created_at IS NOT NULL AND ${INSERT_OFFSET(col)})
  )`;
}

async function tableBounds() {
  const rows = await queryTikTok(`SELECT MIN(id) AS minId, MAX(id) AS maxId FROM ${TABLE}`);
  return { minId: Number(rows?.[0]?.minId || 0), maxId: Number(rows?.[0]?.maxId || 0) };
}

async function countMatching(column, fromId, toId) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM ${TABLE}
     WHERE id >= ? AND id < ? AND ${column} IS NOT NULL AND ${offsetCondition(column)}`,
    [fromId, toId]
  );
  return Number(rows?.[0]?.n || 0);
}

async function shiftColumn(column, fromId, toId) {
  const res = await queryTikTok(
    `UPDATE ${TABLE}
     SET ${column} = DATE_ADD(${column}, INTERVAL ${SHIFT_HOURS} HOUR)
     WHERE id >= ? AND id < ? AND ${column} IS NOT NULL AND ${offsetCondition(column)}`,
    [fromId, toId]
  );
  return Number(res?.affectedRows || 0);
}

async function verify() {
  const inbound = await queryTikTok(
    `SELECT
       COUNT(*) AS n,
       SUM(CASE WHEN d BETWEEN -2 AND 2 THEN 1 ELSE 0 END) AS aligned,
       SUM(CASE WHEN d BETWEEN -482 AND -478 THEN 1 ELSE 0 END) AS minus8,
       SUM(CASE WHEN d IS NULL THEN 1 ELSE 0 END) AS unknown
     FROM (
       SELECT TIMESTAMPDIFF(MINUTE, ${TRUTH_EXPR}, ${AS_UTC("event_time")}) AS d
       FROM ${TABLE} WHERE event_type = 'email_inbound'
     ) t`
  );
  const outbound = await queryTikTok(
    `SELECT
       COUNT(*) AS n,
       SUM(CASE WHEN d BETWEEN -2 AND 2 THEN 1 ELSE 0 END) AS aligned,
       SUM(CASE WHEN d BETWEEN 478 AND 482 THEN 1 ELSE 0 END) AS plus8
     FROM (
       SELECT TIMESTAMPDIFF(MINUTE, ${AS_UTC("event_time")}, ${AS_UTC("created_at")}) AS d
       FROM ${TABLE} WHERE event_type <> 'email_inbound'
     ) t`
  );
  console.log("[verify] 来信行（应全部 aligned，minus8=0）:", JSON.stringify(inbound[0]));
  console.log("[verify] 我方/动作行（应全部 aligned，plus8=0）:", JSON.stringify(outbound[0]));
}

async function main() {
  if (verifyOnly) {
    await verify();
    return;
  }

  const { minId, maxId } = await tableBounds();
  const total = await queryTikTok(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  console.log(
    `[backfill] 表 ${TABLE}：${total[0].n} 行，id ${minId}~${maxId}，批次 ${batchSize}，模式 ${
      apply ? "APPLY（写库）" : "DRY-RUN"
    }`
  );

  let eventTimeRows = 0;
  let sentAtRows = 0;
  for (let from = minId; from <= maxId; from += batchSize) {
    const to = from + batchSize;
    if (apply) {
      const ev = await shiftColumn("event_time", from, to);
      const sa = await shiftColumn("sent_at", from, to);
      eventTimeRows += ev;
      sentAtRows += sa;
      if (ev || sa) {
        console.log(`[backfill] id ${from}~${to}: event_time +${ev}, sent_at +${sa}`);
      }
    } else {
      const ev = await countMatching("event_time", from, to);
      const sa = await countMatching("sent_at", from, to);
      eventTimeRows += ev;
      sentAtRows += sa;
      if (ev || sa) {
        console.log(`[dry-run] id ${from}~${to}: event_time ${ev}, sent_at ${sa}`);
      }
    }
  }

  console.log(
    `[backfill] ${apply ? "已回填" : "待回填"}：event_time ${eventTimeRows} 行，sent_at ${sentAtRows} 行`
  );
  if (!apply) {
    console.log("[backfill] 干跑结束，未写库。加 --apply 实际执行。");
    return;
  }
  await verify();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] 失败:", err?.message || err);
    process.exit(1);
  });
