/**
 * Billing v1.1 — invoice email columns
 * 执行：node scripts/setup-billing-v1.1-invoice-email.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
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

async function run() {
  await ensureColumn(
    `ALTER TABLE tiktok_advertiser_invoice ADD COLUMN email_sent_at TIMESTAMP NULL`,
    "invoice.email_sent_at"
  );
  await ensureColumn(
    `ALTER TABLE tiktok_advertiser_invoice ADD COLUMN email_error TEXT NULL`,
    "invoice.email_error"
  );
  console.log("Billing v1.1 invoice email columns done.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
