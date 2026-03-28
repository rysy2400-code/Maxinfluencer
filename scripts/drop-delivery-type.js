/**
 * 删除 campaigns 表中历史遗留的 deliveryType 列
 * 修复报错：Field 'deliveryType' doesn't have a default value
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

async function run() {
  try {
    await queryTikTok("ALTER TABLE campaigns DROP COLUMN deliveryType");
    console.log("✅ 已删除 campaigns.deliveryType 列");
  } catch (e) {
    console.error("❌ 删除 deliveryType 失败:", e.message);
  } finally {
    process.exit(0);
  }
}

run();

