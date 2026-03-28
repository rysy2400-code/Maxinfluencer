/**
 * 修复已发布会话的 context，确保 campaignId 指向有模拟数据的 campaign
 * 用于解决「右侧未显示模拟数据」的问题
 *
 * 使用方式：node scripts/fix-published-sessions-context.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMP_MOCK = "CAMP-MOCK-001";

async function fix() {
  console.log("检查已发布会话的 context...\n");

  const sessions = await queryTikTok(
    "SELECT id, title, context FROM campaign_sessions WHERE status = 'published'"
  );

  for (const row of sessions || []) {
    let context = {};
    try {
      context = row.context ? JSON.parse(row.context) : {};
    } catch {
      context = {};
    }

    const campaignId = context.campaignId;
    if (!campaignId) {
      console.log(`会话 ${row.id} (${row.title}) 无 campaignId，跳过`);
      continue;
    }

    const count = await queryTikTok(
      "SELECT COUNT(*) as n FROM tiktok_campaign_execution WHERE campaign_id = ?",
      [campaignId]
    );
    const hasData = count && count[0].n > 0;

    if (!hasData) {
      console.log(`会话 ${row.id} (${row.title}) campaignId=${campaignId} 无执行数据`);
      const newContext = { ...context, published: true, campaignId: CAMP_MOCK };
      await queryTikTok(
        "UPDATE campaign_sessions SET context = ? WHERE id = ?",
        [JSON.stringify(newContext), row.id]
      );
      console.log(`  → 已更新 context.campaignId 为 ${CAMP_MOCK}`);
    } else {
      console.log(`会话 ${row.id} (${row.title}) campaignId=${campaignId} 已有 ${count[0].n} 条执行数据`);
    }
  }

  console.log("\n完成。请刷新页面或重新点击该会话。");
}

fix().catch((e) => {
  console.error(e);
  process.exit(1);
});
