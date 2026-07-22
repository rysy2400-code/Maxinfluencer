/**
 * 修复广告主还价错误覆盖 flat_fee 的历史记录。
 * 默认 dry-run；传 --apply 才写库。
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { parseQuoteNegotiation } from "../lib/execution/quote-resolution.js";

const apply = process.argv.includes("--apply");
const rows = await queryTikTok(
  `SELECT campaign_id, tiktok_username, flat_fee, currency, quote_negotiation
   FROM tiktok_campaign_execution
   WHERE quote_negotiation IS NOT NULL`,
  []
);

const repairs = [];
for (const row of rows || []) {
  const history = parseQuoteNegotiation(row.quote_negotiation);
  const latest = history[history.length - 1];
  if (latest?.role !== "advertiser" || latest?.type !== "counter") continue;
  if (!Number.isFinite(Number(latest.amount))) continue;
  if (Number(row.flat_fee) !== Number(latest.amount)) continue;

  const priorInfluencerQuotes = history
    .slice(0, -1)
    .filter(
      (entry) =>
        entry?.role === "influencer" &&
        entry.amount != null &&
        Number.isFinite(Number(entry.amount))
    );
  const influencerQuote = priorInfluencerQuotes[priorInfluencerQuotes.length - 1];
  if (!influencerQuote) continue;

  repairs.push({
    campaignId: row.campaign_id,
    username: row.tiktok_username,
    fromAmount: Number(row.flat_fee),
    toAmount: Number(influencerQuote.amount),
    currency: String(influencerQuote.currency || row.currency || "USD").toUpperCase(),
  });
}

console.log(`${apply ? "APPLY" : "DRY-RUN"}: ${repairs.length} row(s) eligible`);
for (const repair of repairs) {
  console.log(
    `${repair.campaignId} @${repair.username}: ${repair.fromAmount} -> ${repair.toAmount} ${repair.currency}`
  );
  if (apply) {
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
       SET flat_fee = ?, currency = ?
       WHERE campaign_id = ? AND tiktok_username = ? AND flat_fee = ?`,
      [
        repair.toAmount,
        repair.currency,
        repair.campaignId,
        repair.username,
        repair.fromAmount,
      ]
    );
  }
}

console.log(apply ? "Historical quote repair completed." : "No data changed. Re-run with --apply to repair.");
process.exit(0);
