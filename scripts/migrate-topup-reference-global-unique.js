/** 将充值流水号约束调整为全平台唯一。执行：node scripts/migrate-topup-reference-global-unique.js */
import { tiktokPool } from "../lib/db/mysql-tiktok.js";

async function query(sql) {
  const [rows] = await tiktokPool.query(sql);
  return rows;
}

async function run() {
  const duplicates = await query(
    `SELECT bank_reference, COUNT(*) AS cnt, GROUP_CONCAT(advertiser_id ORDER BY advertiser_id) AS advertiser_ids
     FROM tiktok_advertiser_top_up
     WHERE bank_reference IS NOT NULL AND bank_reference <> ''
     GROUP BY bank_reference HAVING COUNT(*) > 1 LIMIT 20`
  );
  if (duplicates?.length) {
    console.error("检测到重复流水号，未修改索引：");
    for (const row of duplicates) console.error(`- ${row.bank_reference}: 公司 ${row.advertiser_ids}`);
    process.exitCode = 2;
    return;
  }
  const indexes = await query("SHOW INDEX FROM tiktok_advertiser_top_up");
  const hasOld = (indexes || []).some((row) => row.Key_name === "uk_topup_bank_ref");
  const hasGlobal = (indexes || []).some((row) => row.Key_name === "uk_topup_bank_ref_global");
  if (!hasGlobal) {
    await query(
      "ALTER TABLE tiktok_advertiser_top_up ADD UNIQUE KEY uk_topup_bank_ref_global (bank_reference)"
    );
    console.log("已添加全平台银行流水号唯一约束");
  } else {
    console.log("全平台银行流水号唯一约束已存在");
  }
  if (hasOld) {
    await query("ALTER TABLE tiktok_advertiser_top_up DROP INDEX uk_topup_bank_ref");
    console.log("已移除公司内流水号唯一约束");
  }
}

run().then(async () => {
  await tiktokPool.end();
  process.exit(process.exitCode || 0);
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
