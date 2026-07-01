/**
 * 执行表 source 字段 + 扣款明细审计字段
 * 执行：node scripts/setup-execution-source.js
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
    `ALTER TABLE tiktok_campaign_execution
     ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'web_search'
     COMMENT '红人来源：user_upload=用户导入，web_search=平台发现'`,
    "execution.source"
  );

  const backfill = await queryTikTok(
    `
    UPDATE tiktok_campaign_execution e
    INNER JOIN tiktok_campaign_influencer_candidates c
      ON e.campaign_id = c.campaign_id AND e.tiktok_username = c.tiktok_username
    SET e.source = CASE
      WHEN c.source = 'user_upload' THEN 'user_upload'
      ELSE 'web_search'
    END
    `
  );
  const backfillRows =
    typeof backfill?.affectedRows === "number" ? backfill.affectedRows : 0;
  console.log(`✅ 回填 execution.source（${backfillRows} 行）`);

  await ensureColumn(
    `ALTER TABLE tiktok_advertiser_balance_ledger
     ADD COLUMN influencer_source VARCHAR(32) NULL
     COMMENT '扣款时红人来源快照 user_upload|web_search'`,
    "ledger.influencer_source"
  );
  await ensureColumn(
    `ALTER TABLE tiktok_advertiser_balance_ledger
     ADD COLUMN platform_fee_rate DECIMAL(8,6) NULL
     COMMENT '扣款时平台服务费率快照，如 0.01 / 0.05'`,
    "ledger.platform_fee_rate"
  );

  console.log("✅ setup-execution-source 完成");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
