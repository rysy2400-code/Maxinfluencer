/**
 * 一次性脚本：为 tiktok_influencer_email_events 表增加 received_at 字段
 *
 * 使用方式：
 *   node scripts/add-received-at-to-tiktok-influencer-email-events.js
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
  try {
    await queryTikTok(
      `
      ALTER TABLE tiktok_influencer_email_events
      ADD COLUMN received_at TIMESTAMP NULL DEFAULT NULL COMMENT '邮件在服务器上的接收时间（IMAP INTERNALDATE）' AFTER in_reply_to,
      ADD INDEX idx_received_at (received_at DESC)
    `
    );
    console.log(
      "[add-received-at] 已为 tiktok_influencer_email_events 增加 received_at 字段。"
    );
  } catch (err) {
    if (err.code === "ER_DUP_FIELDNAME") {
      console.log(
        "[add-received-at] received_at 字段已存在，无需重复添加。"
      );
      return;
    }
    console.error("[add-received-at] 执行 ALTER TABLE 失败：", err);
    process.exit(1);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[add-received-at] 脚本运行出错：", err);
    process.exit(1);
  });

