/**
 * 增加 pending_shipping_address 阶段，并确保红人常用 shipping_info 字段存在。
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function addColumnIfMissing() {
  try {
    await queryTikTok(
      `ALTER TABLE tiktok_influencer
       ADD COLUMN shipping_info JSON NULL COMMENT '红人常用寄样信息（地址/收件人/电话/备注等）' AFTER influencer_email`
    );
    console.log("[shipping-stage] 已增加 tiktok_influencer.shipping_info");
  } catch (err) {
    if (err?.code === "ER_DUP_FIELDNAME") {
      console.log("[shipping-stage] tiktok_influencer.shipping_info 已存在");
      return;
    }
    throw err;
  }
}

async function main() {
  await queryTikTok(
    `ALTER TABLE tiktok_campaign_execution
     MODIFY COLUMN stage ENUM(
       'pending_quote',
       'quote_submitted',
       'pending_creator_confirmation',
       'pending_shipping_address',
       'pending_sample',
       'pending_draft',
       'draft_submitted',
       'published',
       'quote_rejected'
     ) NOT NULL DEFAULT 'pending_quote' COMMENT '执行阶段'`
  );
  console.log("[shipping-stage] 已更新 tiktok_campaign_execution.stage ENUM");
  await addColumnIfMissing();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[shipping-stage] 迁移失败:", err?.message || err);
    process.exit(1);
  });
