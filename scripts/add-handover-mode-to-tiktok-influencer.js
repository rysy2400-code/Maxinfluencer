/**
 * 一次性脚本：为 tiktok_influencer 增加 handover_mode 字段（auto/assist）
 *
 * 使用方式：
 *   node scripts/add-handover-mode-to-tiktok-influencer.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function columnExists() {
  const rows = await queryTikTok(
    `
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tiktok_influencer'
      AND COLUMN_NAME = 'handover_mode'
    LIMIT 1
  `
  );
  return rows && rows.length > 0;
}

async function main() {
  const exists = await columnExists();
  if (exists) {
    console.log("[add-handover-mode] handover_mode 已存在，跳过。");
    return;
  }

  await queryTikTok(
    `
    ALTER TABLE tiktok_influencer
    ADD COLUMN handover_mode ENUM('auto','assist') NOT NULL DEFAULT 'assist'
    COMMENT '红人对话托管模式：auto=全托管，assist=半托管'
  `
  );

  console.log("[add-handover-mode] 已添加 handover_mode 字段。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[add-handover-mode] 运行失败：", err?.message || err);
    process.exit(1);
  });

