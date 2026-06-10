/**
 * 创建广告主余额流水表 tiktok_advertiser_balance_ledger。
 * 执行：node scripts/setup-advertiser-balance-ledger.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function run() {
  await queryTikTok(`
    CREATE TABLE IF NOT EXISTS tiktok_advertiser_balance_ledger (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      advertiser_id INT NOT NULL,
      amount DECIMAL(14,4) NOT NULL COMMENT '变动金额，扣款为负',
      balance_after DECIMAL(14,4) NOT NULL COMMENT '变动后余额',
      currency VARCHAR(16) NOT NULL DEFAULT 'USD',
      type VARCHAR(64) NOT NULL COMMENT '业务类型，如 quote_approve',
      campaign_id VARCHAR(64) NULL,
      influencer_id VARCHAR(255) NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      created_by_user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_idempotency_key (idempotency_key),
      KEY idx_advertiser_id (advertiser_id),
      KEY idx_campaign_influencer (campaign_id, influencer_id),
      CONSTRAINT fk_balance_ledger_advertiser
        FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='广告主余额流水'
  `);
  console.log("✅ tiktok_advertiser_balance_ledger 已就绪");
  console.log("\n完成。");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
