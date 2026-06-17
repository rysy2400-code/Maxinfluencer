/**
 * Billing v1 数据库迁移
 * 执行：node scripts/setup-billing-v1.js
 */
import fs from "fs";
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
    console.log(`✅ ${label}`);
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log(`⏭️ ${label} 已存在`);
    } else {
      throw e;
    }
  }
}

async function runStatement(sql) {
  await queryTikTok(sql);
}

async function ensureLedgerColumns() {
  const cols = [
    [
      `ALTER TABLE tiktok_advertiser_balance_ledger ADD COLUMN influencer_amount DECIMAL(14,4) NULL COMMENT '红人合作费'`,
      "ledger.influencer_amount",
    ],
    [
      `ALTER TABLE tiktok_advertiser_balance_ledger ADD COLUMN platform_fee_amount DECIMAL(14,4) NULL COMMENT '平台服务费 5%'`,
      "ledger.platform_fee_amount",
    ],
    [
      `ALTER TABLE tiktok_advertiser_balance_ledger ADD COLUMN campaign_name VARCHAR(255) NULL`,
      "ledger.campaign_name",
    ],
    [
      `ALTER TABLE tiktok_advertiser_balance_ledger ADD COLUMN influencer_display_name VARCHAR(255) NULL`,
      "ledger.influencer_display_name",
    ],
    [
      `ALTER TABLE tiktok_advertiser_balance_ledger ADD COLUMN note TEXT NULL`,
      "ledger.note",
    ],
  ];
  for (const [sql, label] of cols) {
    await ensureColumn(sql, label);
  }
}

async function run() {
  const schemaPath = path.join(projectRoot, "lib/db/billing-schema.sql");
  const raw = fs.readFileSync(schemaPath, "utf8");
  const statements = raw
    .split(";")
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);

  for (const stmt of statements) {
    const preview = stmt.slice(0, 60).replace(/\s+/g, " ");
    try {
      await runStatement(stmt);
      console.log(`✅ ${preview}…`);
    } catch (e) {
      if (/already exists/i.test(e.message)) {
        console.log(`⏭️ ${preview}… 已存在`);
      } else {
        throw e;
      }
    }
  }

  await ensureColumn(
    `ALTER TABLE tiktok_advertiser ADD COLUMN credit_limit DECIMAL(14,4) NOT NULL DEFAULT 0 COMMENT '授信额度，0=纯预付费'`,
    "tiktok_advertiser.credit_limit"
  );

  await ensureLedgerColumns();

  console.log("\nBilling v1 迁移完成。");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
