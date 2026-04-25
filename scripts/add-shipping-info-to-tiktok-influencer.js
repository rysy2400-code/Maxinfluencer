/**
 * 可选迁移：为 tiktok_influencer 增加 shipping_info 字段（红人常用寄样信息）
 *
 * 说明：
 * - 红人地址通常较稳定，建议在红人表存一份“常用地址”
 * - 每次 campaign 寄样仍建议在 tiktok_campaign_execution.shipping_info 里存“本次寄样快照”
 *
 * 使用方式：
 *   node scripts/add-shipping-info-to-tiktok-influencer.js
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
      ALTER TABLE tiktok_influencer
      ADD COLUMN shipping_info JSON NULL COMMENT '红人常用寄样信息（地址/收件人/电话/备注等）' AFTER influencer_email
    `
    );
    console.log("[add-shipping-info] 已为 tiktok_influencer 增加 shipping_info 字段。");
  } catch (err) {
    if (err.code === "ER_DUP_FIELDNAME") {
      console.log("[add-shipping-info] shipping_info 字段已存在，无需重复添加。");
      return;
    }
    console.error("[add-shipping-info] 执行 ALTER TABLE 失败：", err?.message || err);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[add-shipping-info] 脚本运行出错：", err?.message || err);
    process.exit(1);
  });

