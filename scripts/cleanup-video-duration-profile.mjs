#!/usr/bin/env node
/**
 * 清理存量 influencer_profile.videoDuration（已从产品链路移除的字段）。
 *
 * 策略：
 * - 只处理 influencer_profile JSON 中仍含 videoDuration 键的行（campaigns / tiktok_campaign）。
 * - 先将受影响行完整备份到 data/backups/ 下，再更新。
 * - 若该行已有 accountType，把时长要求并入 accountType（如「...，视频时长要求：8分钟以上」），
 *   避免运行中的 campaign 静默丢失时长筛选；无 accountType 时直接删除该键。
 *
 * 用法：node scripts/cleanup-video-duration-profile.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const TABLES = ["campaigns", "tiktok_campaign"];

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function main() {
  const backupDir = path.join(projectRoot, "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `video-duration-profile-cleanup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  const affected = [];
  for (const table of TABLES) {
    const rows = await queryTikTok(
      `SELECT id, influencer_profile FROM ${table} WHERE JSON_CONTAINS_PATH(influencer_profile, 'one', '$.videoDuration')`
    );
    for (const row of rows) {
      const profile = parseJson(row.influencer_profile);
      if (!profile) {
        console.warn(`[${table}:${row.id}] 无法解析 influencer_profile，跳过`);
        continue;
      }
      affected.push({
        table,
        id: row.id,
        videoDuration: profile.videoDuration ?? null,
        influencer_profile: profile,
      });
    }
  }

  if (!affected.length) {
    console.log("没有发现含 videoDuration 的存量数据，无需清理。");
    process.exit(0);
    return;
  }

  fs.writeFileSync(backupPath, JSON.stringify(affected, null, 2), "utf8");
  console.log(`已备份 ${affected.length} 行到 ${backupPath}`);

  let updated = 0;
  for (const item of affected) {
    const profile = { ...item.influencer_profile };
    const duration = item.videoDuration;
    const accountType = typeof profile.accountType === "string" ? profile.accountType.trim() : "";
    if (duration && accountType && !accountType.includes(String(duration))) {
      profile.accountType = `${accountType}，视频时长要求：${duration}`;
    }
    delete profile.videoDuration;

    await queryTikTok(
      `UPDATE ${item.table} SET influencer_profile = ? WHERE id = ?`,
      [JSON.stringify(profile), item.id]
    );
    updated++;
    console.log(
      `[${item.table}:${item.id}] videoDuration="${item.videoDuration}" -> 已移除；accountType="${profile.accountType}"`
    );
  }

  console.log(`清理完成：更新 ${updated} 行。备份文件：${backupPath}`);
  // mysql2 连接池 keep-alive 会挂住事件循环，显式退出避免进程不结束
  process.exit(0);
}

main().catch((error) => {
  console.error("清理失败:", error);
  process.exit(1);
});
