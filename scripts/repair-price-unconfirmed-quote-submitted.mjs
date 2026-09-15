/**
 * 修正历史数据：把「还没谈定价格却进了待审核价格」的执行行退回待报价。
 *
 * 规则（与新的硬准入一致）：进 quote_submitted 必须固定费与佣金都明确（可为 0）；
 * 固定费为空、且不是纯佣金口径邀约的行，属于历史脏数据 —— 退回 pending_quote，
 * 由红人沟通侧继续确认价格。
 *
 * 默认只处理仍在 running 的 campaign，且默认 dry-run：
 *   node scripts/repair-price-unconfirmed-quote-submitted.mjs
 *   node scripts/repair-price-unconfirmed-quote-submitted.mjs --apply
 *   node scripts/repair-price-unconfirmed-quote-submitted.mjs --apply --all
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const apply = process.argv.includes("--apply");
const includeAll = process.argv.includes("--all");

const rows = await queryTikTok(
  `
  SELECT e.id,
         e.campaign_id,
         e.tiktok_username,
         e.stage,
         e.flat_fee,
         e.commission_percent,
         e.last_event,
         c.status AS campaign_status
  FROM tiktok_campaign_execution e
  JOIN tiktok_campaign c ON c.id = e.campaign_id
  WHERE e.stage = 'quote_submitted'
    AND e.flat_fee IS NULL
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.last_event, '$.outreachEmail.pricingMode')), '') <> 'commission_only'
  ORDER BY e.id
`,
  []
);

const plans = (rows || []).filter((row) => includeAll || row.campaign_status === "running");

console.log(
  `${apply ? "APPLY" : "DRY-RUN"}: ${plans.length} row(s) eligible` +
    (includeAll ? " (含非 running campaign)" : " (仅 running campaign)")
);
for (const row of plans) {
  console.log(
    `${row.campaign_id} @${row.tiktok_username} (campaign=${row.campaign_status}) → quote_submitted 退回 pending_quote`
  );
  if (!apply) continue;
  let lastEvent = row.last_event;
  if (typeof lastEvent === "string") {
    try {
      lastEvent = JSON.parse(lastEvent);
    } catch {
      lastEvent = {};
    }
  }
  const merged = {
    ...(lastEvent && typeof lastEvent === "object" ? lastEvent : {}),
    quoteAdmissionBlocked: true,
    priceAdmissionRollbackAt: new Date().toISOString(),
    priceAdmissionRollbackReason:
      "历史数据修正：固定费尚未与红人确认，退回待报价继续确认价格。",
  };
  await queryTikTok(
    `UPDATE tiktok_campaign_execution
        SET stage = 'pending_quote',
            last_event = ?
      WHERE id = ? AND stage = 'quote_submitted' AND flat_fee IS NULL`,
    [JSON.stringify(merged), row.id]
  );
}

console.log(
  apply ? "历史数据修正完成。" : "未写入任何数据，确认无误后加 --apply 重跑。"
);
process.exit(0);
