/**
 * 同意报价时扣减公司余额（与 stage 推进同一事务）
 */
import { tiktokPool } from "../db/mysql-tiktok.js";
import { getCampaignById, getExecutionRow } from "../db/campaign-dao.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../db/campaign-execution-keys.js";
import { resolveNeedSample } from "../execution/need-sample.js";
import {
  normalizeInfluencerPricing,
  PRICING_MODE_COMMISSION_ONLY,
} from "../campaign/influencer-pricing.js";
import { normalizeAdvertiserBalance } from "../utils/advertiser-balance.js";
import {
  formatInsufficientBalanceMessage,
  INVALID_QUOTE_MESSAGE,
  NON_USD_QUOTE_MESSAGE,
  WRONG_STAGE_MESSAGE,
} from "./balance-messages.js";

const STAGE_QUOTE_SUBMITTED = "quote_submitted";
const LEDGER_TYPE_QUOTE_APPROVE = "quote_approve";

/** @param {unknown} v */
function parseMoney(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

/** @param {unknown} currency */
function isUsdCurrency(currency) {
  const s = String(currency || "")
    .trim()
    .toUpperCase();
  return !s || s === "USD";
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * @param {object} campaign
 * @param {object} executionRow
 * @returns {{ ok: true, chargeAmount: number } | { ok: false, message: string }}
 */
export function resolveQuoteApproveCharge(campaign, executionRow) {
  const currency = executionRow?.currency ?? executionRow?.lastEvent?.currency;
  if (!isUsdCurrency(currency)) {
    return { ok: false, message: NON_USD_QUOTE_MESSAGE };
  }

  const pricing = normalizeInfluencerPricing(campaign?.campaignInfo?.influencerPricing);
  const isCommissionOnly = pricing.mode === PRICING_MODE_COMMISSION_ONLY;
  const flatFee = parseMoney(executionRow?.flat_fee);

  if (flatFee != null && flatFee > 0) {
    return { ok: true, chargeAmount: flatFee };
  }
  if (isCommissionOnly && (flatFee == null || flatFee === 0)) {
    return { ok: true, chargeAmount: 0 };
  }
  return { ok: false, message: INVALID_QUOTE_MESSAGE };
}

function buildIdempotencyKey(campaignId, influencerId) {
  return `quote_approve:${campaignId}:${String(influencerId).trim()}`;
}

/**
 * @param {{
 *   campaignId: string,
 *   influencerId: string,
 *   advertiserId: number,
 *   advertiserUserId?: number | null,
 * }} opts
 * @returns {Promise<{
 *   success: true,
 *   stage: string,
 *   chargedAmount: number,
 *   balanceAfter: number,
 *   alreadyProcessed?: boolean,
 * } | { success: false, message: string, code?: string }>}
 */
export async function approveQuoteWithCharge(opts) {
  const campaignId = String(opts.campaignId || "").trim();
  const influencerId = String(opts.influencerId || "").trim();
  const advertiserId = Number(opts.advertiserId);
  const advertiserUserId =
    opts.advertiserUserId != null ? Number(opts.advertiserUserId) : null;

  if (!campaignId || !influencerId || !Number.isFinite(advertiserId)) {
    return { success: false, message: "缺少 campaignId、influencerId 或 advertiserId" };
  }

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return { success: false, message: "Campaign 不存在" };
  }

  const executionRow = await getExecutionRow(campaignId, influencerId);
  if (!executionRow) {
    return { success: false, message: "红人执行记录不存在" };
  }

  const idempotencyKey = buildIdempotencyKey(campaignId, influencerId);
  const stage = executionRow.stage || STAGE_QUOTE_SUBMITTED;

  if (stage !== STAGE_QUOTE_SUBMITTED) {
    const [ledgerRows] = await tiktokPool.execute(
      `SELECT id, amount, balance_after FROM tiktok_advertiser_balance_ledger WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey]
    );
    if (ledgerRows?.length) {
      const bal = Number(ledgerRows[0].balance_after);
      return {
        success: true,
        stage,
        chargedAmount: Math.abs(Number(ledgerRows[0].amount) || 0),
        balanceAfter: Number.isFinite(bal) ? bal : 0,
        alreadyProcessed: true,
      };
    }
    return { success: false, message: WRONG_STAGE_MESSAGE, code: "wrong_stage" };
  }

  const chargeResolved = resolveQuoteApproveCharge(campaign, executionRow);
  if (!chargeResolved.ok) {
    return { success: false, message: chargeResolved.message };
  }
  const chargeAmount = chargeResolved.chargeAmount;

  const needSample = resolveNeedSample(campaign.productInfo);
  const nextStage = needSample ? "pending_sample" : "pending_draft";
  const quoteApprovedAt = new Date().toISOString();

  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();

    const [ledgerDup] = await conn.execute(
      `SELECT id, balance_after, amount FROM tiktok_advertiser_balance_ledger
       WHERE idempotency_key = ? LIMIT 1 FOR UPDATE`,
      [idempotencyKey]
    );
    if (ledgerDup?.length) {
      const [execNow] = await conn.execute(
        `SELECT stage FROM tiktok_campaign_execution
         WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
        [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
      );
      const currentStage = execNow?.[0]?.stage || nextStage;
      if (currentStage === STAGE_QUOTE_SUBMITTED) {
        const prevLastEvent =
          parseJson(executionRow.last_event) || executionRow.lastEvent || {};
        const merged = { ...prevLastEvent, quoteApprovedAt };
        await conn.execute(
          `UPDATE tiktok_campaign_execution SET stage = ?, last_event = ?
           WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
          [nextStage, JSON.stringify(merged), campaignId, ...paramsExecutionCreatorMatch(influencerId)]
        );
      }
      await conn.commit();
      const bal = Number(ledgerDup[0].balance_after);
      return {
        success: true,
        stage: currentStage === STAGE_QUOTE_SUBMITTED ? nextStage : currentStage,
        chargedAmount: Math.abs(Number(ledgerDup[0].amount) || 0),
        balanceAfter: Number.isFinite(bal) ? bal : 0,
        alreadyProcessed: true,
      };
    }

    const [advRows] = await conn.execute(
      `SELECT balance_amount, balance_currency FROM tiktok_advertiser WHERE id = ? LIMIT 1 FOR UPDATE`,
      [advertiserId]
    );
    if (!advRows?.length) {
      await conn.rollback();
      return { success: false, message: "广告主账户不存在" };
    }

    const balance = normalizeAdvertiserBalance(
      advRows[0].balance_amount,
      advRows[0].balance_currency
    );
    const currentBalance = balance.amount;

    if (chargeAmount > 0 && currentBalance < chargeAmount) {
      await conn.rollback();
      return {
        success: false,
        message: formatInsufficientBalanceMessage(chargeAmount, currentBalance),
        code: "insufficient_balance",
      };
    }

    const balanceAfter = Math.round((currentBalance - chargeAmount) * 10000) / 10000;

    if (chargeAmount > 0) {
      await conn.execute(
        `UPDATE tiktok_advertiser SET balance_amount = ?, balance_currency = 'USD' WHERE id = ?`,
        [balanceAfter, advertiserId]
      );
    }

    await conn.execute(
      `INSERT INTO tiktok_advertiser_balance_ledger
        (advertiser_id, amount, balance_after, currency, type, campaign_id, influencer_id, idempotency_key, created_by_user_id)
       VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?)`,
      [
        advertiserId,
        chargeAmount > 0 ? -chargeAmount : 0,
        balanceAfter,
        LEDGER_TYPE_QUOTE_APPROVE,
        campaignId,
        influencerId,
        idempotencyKey,
        Number.isFinite(advertiserUserId) ? advertiserUserId : null,
      ]
    );

    const prevLastEvent =
      parseJson(executionRow.last_event) || executionRow.lastEvent || {};
    const merged = { ...prevLastEvent, quoteApprovedAt };
    const [upd] = await conn.execute(
      `UPDATE tiktok_campaign_execution SET stage = ?, last_event = ?
       WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH} AND stage = ?`,
      [
        nextStage,
        JSON.stringify(merged),
        campaignId,
        ...paramsExecutionCreatorMatch(influencerId),
        STAGE_QUOTE_SUBMITTED,
      ]
    );
    if (!upd?.affectedRows) {
      await conn.rollback();
      return { success: false, message: WRONG_STAGE_MESSAGE, code: "wrong_stage" };
    }

    await conn.commit();
    return {
      success: true,
      stage: nextStage,
      chargedAmount: chargeAmount,
      balanceAfter,
    };
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
