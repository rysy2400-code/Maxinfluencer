/**
 * 钛动科技历史账单导入（来源：Maxinx钛动科技-合作费用结算表.xlsx）
 *
 * 规则：
 * - 充值 $3,000 → 余额 $3,000
 * - Excel 每行金额为「含 5% 平台费的总扣款」，倒推 influencer = total/1.05
 * - 最终余额 $748
 * - Campaign 名留空；日期为导入日按序递增
 *
 * 执行：node scripts/import-taidong-billing-legacy.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { tiktokPool } from "../lib/db/mysql-tiktok.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const COMPANY = "钛动科技";
const IMPORT_MARKER = "legacy_import:taidong:v1:topup";
const NOTE = "来源：Maxinx钛动科技-合作费用结算表.xlsx（上一版产品历史导入）";

/** Excel 红人合作总扣款（含 5% 平台费） */
const CONSUMPTIONS = [
  { username: "hannahmmark", totalCharge: 100 },
  { username: "sadies.reviews", totalCharge: 300 },
  { username: "itsamvndaa", totalCharge: 300 },
  { username: "maddy.wads", totalCharge: 450 },
  { username: "about.kary", totalCharge: 1102 },
];

const TOP_UP_AMOUNT = 3000;
const EXPECTED_FINAL_BALANCE = 748;

/**
 * 从「含平台费的总扣款」倒推红人费与平台费
 * @param {number} totalCharge
 */
function backfillFromTotalCharge(totalCharge) {
  const influencerAmount = Math.round((totalCharge / 1.05) * 10000) / 10000;
  const platformFeeAmount = Math.round((totalCharge - influencerAmount) * 10000) / 10000;
  return { influencerAmount, platformFeeAmount, totalCharge };
}

async function run() {
  const conn = await tiktokPool.getConnection();
  try {
    const [advRows] = await conn.execute(
      `SELECT id, balance_amount FROM tiktok_advertiser WHERE name = ? LIMIT 1`,
      [COMPANY]
    );
    if (!advRows?.length) {
      throw new Error(`未找到公司：${COMPANY}`);
    }
    const advertiserId = advRows[0].id;

    const [existing] = await conn.execute(
      `SELECT id FROM tiktok_advertiser_balance_ledger WHERE idempotency_key = ? LIMIT 1`,
      [IMPORT_MARKER]
    );
    if (existing?.length) {
      console.log("⏭️ 已导入过，跳过（idempotency_key=%s）", IMPORT_MARKER);
      process.exit(0);
    }

    const splits = CONSUMPTIONS.map((c) => ({
      ...c,
      ...backfillFromTotalCharge(c.totalCharge),
    }));
    const totalConsumption = splits.reduce((s, r) => s + r.totalCharge, 0);
    const finalBalance = Math.round((TOP_UP_AMOUNT - totalConsumption) * 10000) / 10000;

    if (finalBalance !== EXPECTED_FINAL_BALANCE) {
      throw new Error(
        `余额校验失败：计算 ${finalBalance}，期望 ${EXPECTED_FINAL_BALANCE}`
      );
    }

    await conn.beginTransaction();

    const baseTime = new Date();
    baseTime.setHours(10, 0, 0, 0);
    let step = 0;
    const ts = () => {
      const d = new Date(baseTime.getTime() + step * 5 * 60 * 1000);
      step += 1;
      return d.toISOString().slice(0, 19).replace("T", " ");
    };

    let balanceAfter = TOP_UP_AMOUNT;
    await conn.execute(
      `INSERT INTO tiktok_advertiser_balance_ledger
        (advertiser_id, amount, balance_after, currency, type, note, idempotency_key, created_at)
       VALUES (?, ?, ?, 'USD', 'top_up', ?, ?, ?)`,
      [
        advertiserId,
        TOP_UP_AMOUNT,
        balanceAfter,
        `${NOTE}；tecdo 已付款 $3,000`,
        `${IMPORT_MARKER}`,
        ts(),
      ]
    );

    for (const row of splits) {
      balanceAfter = Math.round((balanceAfter - row.totalCharge) * 10000) / 10000;
      await conn.execute(
        `INSERT INTO tiktok_advertiser_balance_ledger
          (advertiser_id, amount, balance_after, currency, type, influencer_id,
           influencer_amount, platform_fee_amount, influencer_display_name, note, idempotency_key, created_at)
         VALUES (?, ?, ?, 'USD', 'quote_approve', ?, ?, ?, ?, ?, ?, ?)`,
        [
          advertiserId,
          -row.totalCharge,
          balanceAfter,
          row.username,
          -row.influencerAmount,
          -row.platformFeeAmount,
          row.username,
          NOTE,
          `${IMPORT_MARKER.replace(':topup', '')}:quote:${row.username}`,
          ts(),
        ]
      );
    }

    await conn.execute(
      `UPDATE tiktok_advertiser SET balance_amount = ?, balance_currency = 'USD' WHERE id = ?`,
      [balanceAfter, advertiserId]
    );

    await conn.commit();

    console.log("✅ 钛动科技账单导入完成");
    console.log("   advertiser_id:", advertiserId);
    console.log("   充值:", TOP_UP_AMOUNT);
    console.log("   消费合计:", totalConsumption);
    console.log("   期末余额:", balanceAfter);
    console.log("\n明细（倒推）：");
    for (const row of splits) {
      console.log(
        `   @${row.username}: 红人 $${row.influencerAmount.toFixed(2)} + 平台 $${row.platformFeeAmount.toFixed(2)} = $${row.totalCharge.toFixed(2)}`
      );
    }
    console.log(
      "\n   红人费合计: $",
      splits.reduce((s, r) => s + r.influencerAmount, 0).toFixed(2)
    );
    console.log(
      "   平台费合计: $",
      splits.reduce((s, r) => s + r.platformFeeAmount, 0).toFixed(2)
    );
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    conn.release();
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
