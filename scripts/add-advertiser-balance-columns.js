/**
 * 为 tiktok_advertiser 增加公司共享余额字段。
 * 执行：node scripts/add-advertiser-balance-columns.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function ensureColumn(sql, label) {
  try {
    await queryTikTok(sql);
    console.log(`✅ ${label} 已添加`);
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log(`⏭️ ${label} 已存在`);
    } else {
      throw e;
    }
  }
}

async function run() {
  await ensureColumn(
    `ALTER TABLE tiktok_advertiser ADD COLUMN balance_amount DECIMAL(14,4) NULL COMMENT '公司共享余额，NULL 视为 0'`,
    "tiktok_advertiser.balance_amount"
  );
  await ensureColumn(
    `ALTER TABLE tiktok_advertiser ADD COLUMN balance_currency VARCHAR(16) NULL DEFAULT 'USD' COMMENT '余额币种/单位'`,
    "tiktok_advertiser.balance_currency"
  );
  console.log("\n完成。");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
