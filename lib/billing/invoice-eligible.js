import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  getInvoicedConsumptionPeriods,
  getInvoicedInfluencerLedgerIds,
  getInvoicedRechargeLedgerIds,
} from "./invoice-dao.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} advertiserId
 */
export async function getEligibleInvoiceOptions(advertiserId) {
  const [invoicedLedgerIds, invoicedPeriods, invoicedInfluencerLedgerIds] = await Promise.all([
    getInvoicedRechargeLedgerIds(advertiserId),
    getInvoicedConsumptionPeriods(advertiserId),
    getInvoicedInfluencerLedgerIds(advertiserId),
  ]);

  const topUpRows = await queryTikTok(
    `
    SELECT id, amount, balance_after, created_at
    FROM tiktok_advertiser_balance_ledger
    WHERE advertiser_id = ? AND type = 'top_up'
    ORDER BY created_at ASC, id ASC
  `,
    [advertiserId]
  );

  const rechargeOptions = (topUpRows || [])
    .filter((row) => !invoicedLedgerIds.has(Number(row.id)))
    .map((row) => ({
      ledgerId: Number(row.id),
      amountUsd: num(row.amount),
      createdAt: row.created_at,
    }));

  const monthRows = await queryTikTok(
    `
    SELECT DATE_FORMAT(q.created_at, '%Y%m') AS period_yyyymm,
           COUNT(*) AS row_count,
           COALESCE(SUM(ABS(influencer_amount)), 0) AS influencer_total,
           COALESCE(SUM(ABS(platform_fee_amount)), 0) AS platform_total,
           COALESCE(SUM(ABS(amount)), 0) AS consumption_total
    FROM tiktok_advertiser_balance_ledger q
    WHERE q.advertiser_id = ? AND q.type = 'quote_approve'
      AND NOT EXISTS (
        SELECT 1 FROM tiktok_advertiser_balance_ledger r
        WHERE r.idempotency_key = CONCAT('system_quote_refund:', q.campaign_id, ':', q.influencer_id)
      )
    GROUP BY period_yyyymm
    ORDER BY period_yyyymm DESC
  `,
    [advertiserId]
  );

  const consumptionOptions = (monthRows || [])
    .filter((row) => !invoicedPeriods.has(String(row.period_yyyymm)))
    .map((row) => ({
      periodYyyymm: String(row.period_yyyymm),
      periodLabel: `${row.period_yyyymm.slice(0, 4)}-${row.period_yyyymm.slice(4, 6)}`,
      rowCount: Number(row.row_count) || 0,
      influencerTotalUsd: num(row.influencer_total),
      platformTotalUsd: num(row.platform_total),
      amountUsd: num(row.consumption_total),
    }));

  const quoteRows = await queryTikTok(
    `
    SELECT q.id, q.campaign_id, q.influencer_id, q.influencer_display_name,
           q.campaign_name, q.influencer_amount, q.platform_fee_amount,
           q.amount, q.created_at
    FROM tiktok_advertiser_balance_ledger q
    WHERE q.advertiser_id = ? AND q.type = 'quote_approve'
      AND q.influencer_id IS NOT NULL AND q.influencer_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM tiktok_advertiser_balance_ledger r
        WHERE r.idempotency_key = CONCAT('system_quote_refund:', q.campaign_id, ':', q.influencer_id)
      )
    ORDER BY q.created_at DESC, q.id DESC
  `,
    [advertiserId]
  );

  const influencerOptions = (quoteRows || [])
    .filter((row) => !invoicedInfluencerLedgerIds.has(Number(row.id)))
    .map((row) => {
      const influencerFee = Math.abs(num(row.influencer_amount));
      const platformFee = Math.abs(num(row.platform_fee_amount));
      const total = Math.abs(num(row.amount)) || influencerFee + platformFee;
      return {
        ledgerId: Number(row.id),
        influencerId: String(row.influencer_id || ""),
        influencerName: String(row.influencer_display_name || "—"),
        campaignId: String(row.campaign_id || ""),
        campaignName: String(row.campaign_name || "—"),
        influencerFeeUsd: influencerFee,
        platformFeeUsd: platformFee,
        amountUsd: total,
        createdAt: row.created_at,
      };
    });

  return { rechargeOptions, consumptionOptions, influencerOptions };
}

/**
 * @param {number} advertiserId
 * @param {number} ledgerId
 */
export async function getRechargeLedgerRow(advertiserId, ledgerId) {
  const rows = await queryTikTok(
    `
    SELECT id, amount, created_at
    FROM tiktok_advertiser_balance_ledger
    WHERE advertiser_id = ? AND id = ? AND type = 'top_up'
    LIMIT 1
  `,
    [advertiserId, ledgerId]
  );
  return rows?.[0] || null;
}

/**
 * 单个 quote_approve 明细（红人 × 活动的一次合作）
 *
 * @param {number} advertiserId
 * @param {number} ledgerId
 */
export async function getQuoteLedgerRow(advertiserId, ledgerId) {
  const rows = await queryTikTok(
    `
    SELECT q.id, q.campaign_id, q.influencer_id, q.influencer_display_name,
           q.campaign_name, q.influencer_amount, q.platform_fee_amount,
           q.amount, q.created_at
    FROM tiktok_advertiser_balance_ledger q
    WHERE q.advertiser_id = ? AND q.id = ? AND q.type = 'quote_approve'
      AND q.influencer_id IS NOT NULL AND q.influencer_id != ''
    LIMIT 1
  `,
    [advertiserId, ledgerId]
  );
  return rows?.[0] || null;
}

/**
 * @param {number} advertiserId
 * @param {string} periodYyyymm
 */
export async function getConsumptionLedgerRows(advertiserId, periodYyyymm) {
  const y = periodYyyymm.slice(0, 4);
  const m = periodYyyymm.slice(4, 6);
  const from = `${y}-${m}-01 00:00:00`;
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const to = `${y}-${m}-${String(lastDay).padStart(2, "0")} 23:59:59`;

  const rows = await queryTikTok(
    `
    SELECT id, influencer_amount, platform_fee_amount, amount,
           influencer_display_name, campaign_name, created_at
    FROM tiktok_advertiser_balance_ledger q
    WHERE q.advertiser_id = ? AND q.type = 'quote_approve'
      AND q.created_at >= ? AND q.created_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM tiktok_advertiser_balance_ledger r
        WHERE r.idempotency_key = CONCAT('system_quote_refund:', q.campaign_id, ':', q.influencer_id)
      )
    ORDER BY q.created_at ASC, q.id ASC
  `,
    [advertiserId, from, to]
  );
  return rows || [];
}
