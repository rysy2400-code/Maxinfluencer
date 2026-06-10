/** node scripts/setup-admin-action-log.js */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

async function run() {
  await queryTikTok(`
    CREATE TABLE IF NOT EXISTS admin_action_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      real_advertiser_user_id INT NOT NULL COMMENT '实际操作人 tiktok_advertiser_user.id',
      effective_advertiser_user_id INT NOT NULL COMMENT '生效身份 user.id',
      action VARCHAR(64) NOT NULL,
      resource_type VARCHAR(32) NULL,
      resource_id VARCHAR(128) NULL,
      meta JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_admin_log_real (real_advertiser_user_id),
      KEY idx_admin_log_effective (effective_advertiser_user_id),
      KEY idx_admin_log_action (action),
      KEY idx_admin_log_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log("✅ admin_action_log 表已就绪");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
