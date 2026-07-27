import { queryTikTok } from "../db/mysql-tiktok.js";
import { normalizeAdvertiserBalance } from "../utils/advertiser-balance.js";

/** @param {unknown} v @param {number} [fallback] */
function num(v, fallback = 0) {
  const n = v == null || v === "" ? fallback : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {number} advertiserId
 */
export async function getBillingSummary(advertiserId) {
  const [advRows, aggRows] = await Promise.all([
    queryTikTok(
      `SELECT balance_amount, balance_currency FROM tiktok_advertiser WHERE id = ? LIMIT 1`,
      [advertiserId]
    ),
    queryTikTok(
      `
      SELECT
        COALESCE(SUM(CASE WHEN type = 'top_up' THEN amount ELSE 0 END), 0) AS total_top_up,
        GREATEST(-COALESCE(SUM(COALESCE(influencer_amount, 0)), 0), 0) AS total_influencer_spend,
        GREATEST(-COALESCE(SUM(COALESCE(platform_fee_amount, 0)), 0), 0) AS total_platform_fee,
        GREATEST(-COALESCE(SUM(COALESCE(influencer_amount, 0) + COALESCE(platform_fee_amount, 0)), 0), 0) AS total_consumption
      FROM tiktok_advertiser_balance_ledger
      WHERE advertiser_id = ?
    `,
      [advertiserId]
    ),
  ]);

  const balance = normalizeAdvertiserBalance(
    advRows?.[0]?.balance_amount,
    advRows?.[0]?.balance_currency
  );
  const agg = aggRows?.[0] || {};

  return {
    balance,
    totalTopUp: num(agg.total_top_up),
    totalInfluencerSpend: num(agg.total_influencer_spend),
    totalPlatformFee: num(agg.total_platform_fee),
    totalConsumption: num(agg.total_consumption),
  };
}

/**
 * @param {{
 *   advertiserId: number,
 *   page?: number,
 *   pageSize?: number,
 *   from?: string | null,
 *   to?: string | null,
 *   type?: string | null,
 * }} opts
 */
export async function listBillingLedger(opts) {
  const advertiserId = Number(opts.advertiserId);
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const where = ["advertiser_id = ?"];
  const params = [advertiserId];

  if (opts.type) {
    where.push("type = ?");
    params.push(String(opts.type));
  }
  if (opts.from) {
    where.push("created_at >= ?");
    params.push(`${String(opts.from).slice(0, 10)} 00:00:00`);
  }
  if (opts.to) {
    where.push("created_at <= ?");
    params.push(`${String(opts.to).slice(0, 10)} 23:59:59`);
  }

  const whereSql = where.join(" AND ");

  const [countRows, rows] = await Promise.all([
    queryTikTok(`SELECT COUNT(*) AS cnt FROM tiktok_advertiser_balance_ledger WHERE ${whereSql}`, params),
    queryTikTok(
      `
      SELECT id, amount, balance_after, currency, type, campaign_id, influencer_id,
             influencer_amount, platform_fee_amount, platform_fee_rate, influencer_source,
             campaign_name, influencer_display_name,
             note, created_at
      FROM tiktok_advertiser_balance_ledger
      WHERE ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `,
      params
    ),
  ]);

  const total = Number(countRows?.[0]?.cnt) || 0;

  return {
    page,
    pageSize,
    total,
    items: (rows || []).map(mapLedgerRow),
  };
}

/** @param {object} row */
function mapLedgerRow(row) {
  const influencerAmt = num(row.influencer_amount);
  const platformAmt = num(row.platform_fee_amount);
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type,
    amount: num(row.amount),
    balanceAfter: num(row.balance_after),
    currency: row.currency || "USD",
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
    influencerId: row.influencer_id || null,
    influencerDisplayName: row.influencer_display_name || null,
    influencerAmount: influencerAmt,
    platformFeeAmount: platformAmt,
    platformFeeRate: num(row.platform_fee_rate),
    influencerSource: row.influencer_source || null,
    note: row.note || null,
  };
}

/**
 * @param {object} opts same as listBillingLedger without page
 */
export async function listBillingLedgerForExport(opts) {
  const where = ["advertiser_id = ?"];
  const params = [Number(opts.advertiserId)];

  if (opts.type) {
    where.push("type = ?");
    params.push(String(opts.type));
  }
  if (opts.from) {
    where.push("created_at >= ?");
    params.push(`${String(opts.from).slice(0, 10)} 00:00:00`);
  }
  if (opts.to) {
    where.push("created_at <= ?");
    params.push(`${String(opts.to).slice(0, 10)} 23:59:59`);
  }

  const rows = await queryTikTok(
    `
    SELECT id, amount, balance_after, currency, type, campaign_id, influencer_id,
           influencer_amount, platform_fee_amount, platform_fee_rate, influencer_source,
           campaign_name, influencer_display_name,
           note, created_at
    FROM tiktok_advertiser_balance_ledger
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC
    LIMIT 5000
  `,
    params
  );

  return (rows || []).map(mapLedgerRow);
}
