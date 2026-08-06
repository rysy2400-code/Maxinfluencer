#!/usr/bin/env node
/**
 * 爬虫机本地 guard 的活性探针（运行在每台 crawler VM 上）。
 * 用途：guard 在“进程是否存在”之外，判断进程是否真的在工作。
 *
 * usage:
 *   node crawler-activity-probe.mjs worker <publicIp> <staleMinutes> <platform1,platform2,...>
 *   node crawler-activity-probe.mjs health <publicIp> <staleMinutes>
 *
 * exit code:
 *   0 = 健康（最近有活动 / 无任务可做，不需要重启）
 *   1 = 僵尸（guard 应强杀重启）
 *   2 = 查询失败（DB 不可达等，guard 应跳过本轮，不杀进程）
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryTikTok, tiktokPool } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

function ageMinutes(dateValue) {
  if (!dateValue) return null;
  const ms = new Date(dateValue).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return (Date.now() - ms) / 60000;
}

const [mode, ip, staleStr, platformsRaw] = process.argv.slice(2);
const staleMinutes = Math.max(1, Number(staleStr) || 15);
const workerIp = String(ip || "").trim();
const platforms = String(platformsRaw || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

try {
  if (mode === "health") {
    const rows = await queryTikTok(
      `SELECT last_seen_at FROM tiktok_crawler_worker_health
       WHERE worker_ip = ? ORDER BY last_seen_at DESC LIMIT 1`,
      [workerIp]
    );
    if (!rows?.length) {
      console.log("[probe] health:no_row_skip");
      process.exit(2);
    }
    const age = ageMinutes(rows[0].last_seen_at);
    if (age == null) {
      console.log("[probe] health:bad_ts_skip");
      process.exit(2);
    }
    console.log(`[probe] health:age_min=${age.toFixed(1)}`);
    process.exit(age > staleMinutes ? 1 : 0);
  }

  // worker 模式：只有该平台存在“积压 >5 分钟”的任务时才值得判僵尸。
  // 空队列的机器（健康但没活干）不算僵尸，避免误杀。
  if (platforms.length) {
    const placeholders = platforms.map(() => "?").join(",");
    const pending = await queryTikTok(
      `SELECT COUNT(*) AS c FROM tiktok_influencer_search_task
       WHERE status='pending' AND platform IN (${placeholders})
         AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
      platforms
    );
    if (Number(pending?.[0]?.c || 0) === 0) {
      console.log("[probe] worker:idle_no_pending");
      process.exit(0);
    }
  }

  const rows = await queryTikTok(
    `SELECT MAX(GREATEST(COALESCE(started_at, created_at), COALESCE(last_progress_at, created_at))) AS last_activity
     FROM tiktok_influencer_search_task
     WHERE worker_ip = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)`,
    [workerIp]
  );
  const lastActivity = rows?.[0]?.last_activity;
  if (!lastActivity) {
    console.log("[probe] worker:no_recent_activity");
    process.exit(1);
  }
  const age = ageMinutes(lastActivity);
  console.log(`[probe] worker:age_min=${age.toFixed(1)}`);
  process.exit(age > staleMinutes ? 1 : 0);
} catch (error) {
  console.error(`[probe] db_error:${error?.message || error}`);
  process.exit(2);
} finally {
  try {
    await tiktokPool.end();
  } catch {}
}
