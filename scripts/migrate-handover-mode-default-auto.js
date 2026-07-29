/**
 * 将红人托管模式默认值切换为 auto，并按产品口径把历史 assist 批量改为 auto。
 *
 * 使用方式：
 *   node scripts/migrate-handover-mode-default-auto.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  await queryTikTok(
    `
    ALTER TABLE tiktok_influencer
    MODIFY COLUMN handover_mode ENUM('auto','assist') NOT NULL DEFAULT 'auto'
    COMMENT '红人对话托管模式：auto=全托管，assist=半托管'
  `
  );
  console.log("[handover-mode-auto] 已将 handover_mode 默认值设为 auto。");

  const result = await queryTikTok(
    `
    UPDATE tiktok_influencer
    SET handover_mode = 'auto'
    WHERE handover_mode = 'assist'
  `
  );
  console.log(
    `[handover-mode-auto] 已批量更新 assist -> auto：${result?.affectedRows || 0} 行。`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[handover-mode-auto] 运行失败：", err?.message || err);
    process.exit(1);
  });
