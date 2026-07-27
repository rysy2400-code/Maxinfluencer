import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function hasColumn(table, column) {
  const rows = await queryTikTok(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return Boolean(rows?.length);
}

async function addColumn(table, column, definition) {
  if (await hasColumn(table, column)) return;
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Added ${table}.${column}`);
}

async function main() {
  await addColumn("tiktok_influencer", "business_profile_markdown", "MEDIUMTEXT NULL COMMENT '红人商务档案（固定 Markdown 模板，唯一内容存储）'");
  await addColumn("tiktok_influencer", "business_profile_updated_at", "DATETIME NULL");
  await addColumn("tiktok_influencer", "business_profile_source_message_id", "VARCHAR(255) NULL");
  await addColumn("tiktok_influencer", "contact_status", "VARCHAR(32) NOT NULL DEFAULT 'contactable'");
  await addColumn("tiktok_influencer", "do_not_contact_at", "DATETIME NULL");
  await addColumn("tiktok_influencer", "do_not_contact_reason", "TEXT NULL");
  await addColumn("tiktok_influencer", "do_not_contact_source_message_id", "VARCHAR(255) NULL");
  await addColumn("tiktok_campaign_execution", "quote_origin", "VARCHAR(32) NULL COMMENT 'creator_quote|commerce_profile_estimate'");
  await queryTikTok(`ALTER TABLE tiktok_campaign_execution MODIFY COLUMN stage ENUM(
    'pending_quote','quote_submitted','pending_creator_confirmation',
    'pending_sample','pending_draft','draft_submitted','published','quote_rejected'
  ) NOT NULL DEFAULT 'pending_quote'`);
  console.log("Influencer business profile schema is ready.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
