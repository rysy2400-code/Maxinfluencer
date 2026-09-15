/**
 * 回填执行级条款（佣金 / 纯佣金邀约的 0 固定费）
 *
 * 背景：佣金原先只存在 campaign 级；执行级新增 commission_percent 后，
 * 存量「按纯佣金口径邀约」的执行行需要回填，才能让卡片与审批拿到同一条款口径。
 *
 * 规则（只处理有明确线索的行）：
 * - last_event.outreachEmail.pricingMode = 'commission_only' 且**已过待报价阶段**的执行行
 *   （待报价阶段还没谈成，保持空白，等红人确认后再落库，与 flat_fee 同规则）：
 *   - commission_percent 为空 → 回填 campaign.commission
 *   - flat_fee 为空 → 回填 0（无固定费是邀约口径本身）
 *
 * 默认 dry-run，传 --apply 才写库。
 *
 *   node scripts/backfill-execution-commission-terms.mjs
 *   node scripts/backfill-execution-commission-terms.mjs --apply
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const apply = process.argv.includes("--apply");

const rows = await queryTikTok(
  `
  SELECT e.id,
         e.campaign_id,
         e.tiktok_username,
         e.stage,
         e.flat_fee,
         e.commission_percent,
         c.commission AS campaign_commission
  FROM tiktok_campaign_execution e
  JOIN tiktok_campaign c ON c.id = e.campaign_id
  WHERE JSON_UNQUOTE(JSON_EXTRACT(e.last_event, '$.outreachEmail.pricingMode')) = 'commission_only'
    AND e.stage <> 'pending_quote'
    AND (e.commission_percent IS NULL
         OR e.flat_fee IS NULL)
  ORDER BY e.id
`,
  []
);

const plans = [];
for (const row of rows || []) {
  const commission =
    row.commission_percent != null
      ? Number(row.commission_percent)
      : row.campaign_commission != null
        ? Number(row.campaign_commission)
        : null;
  const setCommission = row.commission_percent == null && Number.isFinite(commission);
  const setZeroFlatFee =
    row.stage !== "pending_quote" && row.flat_fee == null;
  if (!setCommission && !setZeroFlatFee) continue;
  plans.push({
    id: row.id,
    campaignId: row.campaign_id,
    username: row.tiktok_username,
    stage: row.stage,
    setCommission,
    setZeroFlatFee,
    commission: setCommission ? commission : Number(row.commission_percent),
    flatFee: setZeroFlatFee
      ? 0
      : row.flat_fee == null
        ? null
        : Number(row.flat_fee),
  });
}

console.log(`${apply ? "APPLY" : "DRY-RUN"}: ${plans.length} row(s) eligible`);
for (const p of plans) {
  console.log(
    `${p.campaignId} @${p.username} (${p.stage}) → ` +
      `${p.setZeroFlatFee ? "flat_fee=0" : "flat_fee 不动"}` +
      `${p.setCommission ? `, commission_percent=${p.commission}` : ""}`
  );
  if (!apply) continue;
  if (p.setCommission) {
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
          SET commission_percent = ?
        WHERE id = ? AND commission_percent IS NULL`,
      [p.commission, p.id]
    );
  }
  if (p.setZeroFlatFee) {
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
          SET flat_fee = 0
        WHERE id = ? AND flat_fee IS NULL AND stage <> 'pending_quote'`,
      [p.id]
    );
  }
}

console.log(
  apply
    ? "执行级条款回填完成。"
    : "未写入任何数据，确认无误后加 --apply 重跑。"
);
process.exit(0);
