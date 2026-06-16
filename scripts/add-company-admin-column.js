/**
 * 为 tiktok_advertiser_user 增加 is_company_admin 列（公司管理员，可切换本公司普通成员）
 *
 * 执行：node scripts/add-company-admin-column.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

async function run() {
  try {
    await queryTikTok(
      `ALTER TABLE tiktok_advertiser_user ADD COLUMN is_company_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=本公司内可切换普通成员' AFTER is_admin`
    );
    console.log("✅ tiktok_advertiser_user.is_company_admin 已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ tiktok_advertiser_user.is_company_admin 已存在");
    } else {
      throw e;
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
