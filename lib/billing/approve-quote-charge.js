/**
 * 同意报价时扣减公司余额（与 stage 推进同一事务）
 * 扣款 = 红人合作费 + 平台服务费（用户导入 1%，平台发现 5%）；默认纯预付费（credit_limit=0）
 */
import { tiktokPool } from "../db/mysql-tiktok.js";
import { getCampaignCoreById, getExecutionRow } from "../db/campaign-dao.js";
import { invalidateExecutionCounts } from "../db/execution-counts-cache.js";
import { getCampaignSessionById } from "../db/campaign-session-dao.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../db/campaign-execution-keys.js";
import { resolveNeedSample } from "../execution/need-sample.js";
import {
  resolveExecutionAgreedTerms,
} from "../execution/agreed-terms.js";
import { normalizeInfluencerSource } from "../influencer/influencer-source.js";
import { normalizeAdvertiserBalance } from "../utils/advertiser-balance.js";
import { splitChargeAmounts } from "./platform-fee.js";
import {
  formatInsufficientBalanceMessage,
  INVALID_QUOTE_MESSAGE,
  NON_USD_QUOTE_MESSAGE,
  WRONG_STAGE_MESSAGE,
} from "./balance-messages.js";

const STAGE_QUOTE_SUBMITTED = "quote_submitted";
const STAGE_PENDING_SHIPPING_ADDRESS = "pending_shipping_address";
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
 * 品牌点「同意」那一刻的条款快照（写入 last_event.approvedTerms）。
 * 币种只从 resolveQuoteApproveCharge 的返回值取，避免在调用方引用未定义变量。
 * @param {{
 *   fixedFeeUsd?: number|null,
 *   commissionPercent?: number|null,
 *   currency?: string|null,
 * }} chargeResolved
 * @param {unknown} chargedAmount
 */
export function buildApprovedTermsSnapshot(chargeResolved, chargedAmount) {
  const n = Number(chargedAmount);
  return {
    fixedFeeUsd: chargeResolved?.fixedFeeUsd ?? 0,
    commissionPercent: chargeResolved?.commissionPercent ?? null,
    currency: String(chargeResolved?.currency || "USD").trim().toUpperCase() || "USD",
    chargedAmount: Number.isFinite(n) ? Math.abs(n) : 0,
  };
}

/**
 * @param {object} campaign
 * @param {object} executionRow
 * @returns {{
 *   ok: true,
 *   chargeAmount: number,
 *   influencerAmount: number,
 *   platformFeeAmount: number,
 *   platformFeeRate: number,
 *   influencerSource: string,
 * } | { ok: false, message: string }}
 */
export function resolveQuoteApproveCharge(campaign, executionRow) {
  // 只认「这条红人自己谈定的条款」（固定费 + 佣金），不再读 campaign 当前的报价策略模式：
  // 报价策略只决定首封邀约口径，红人可以按当初邀约的口径成交。
  const terms = resolveExecutionAgreedTerms(campaign, executionRow);
  const currency = terms.currency;
  if (!isUsdCurrency(currency)) {
    return { ok: false, message: NON_USD_QUOTE_MESSAGE };
  }

  const flatFee = parseMoney(terms.fixedFeeUsd);
  // 纯佣金/纯置换邀约（无固定费）：历史数据里 flat_fee 可能为空，按 0 固定费成交。
  const noFixedFeeByDesign = flatFee == null && terms.isCommissionOnlyInvite;
  const influencerSource = normalizeInfluencerSource(executionRow?.source);

  if (flatFee != null && flatFee > 0) {
    const split = splitChargeAmounts(flatFee, influencerSource);
    return {
      ok: true,
      chargeAmount: split.totalDeduct,
      influencerAmount: split.influencerAmount,
      platformFeeAmount: split.platformFeeAmount,
      platformFeeRate: split.platformFeeRate,
      influencerSource,
      fixedFeeUsd: flatFee,
      commissionPercent: terms.commissionPercent,
      currency,
    };
  }
  // 报价为 0 视为「免费合作 / 产品置换」，各定价模式均可同意且不扣款；
  // 报价为空时，仅「当初按纯佣金/纯置换邀约」的执行允许（无固定费用），其余仍按无效报价拦截。
  if (flatFee === 0 || noFixedFeeByDesign) {
    return {
      ok: true,
      chargeAmount: 0,
      influencerAmount: 0,
      platformFeeAmount: 0,
      platformFeeRate: 0,
      influencerSource,
      fixedFeeUsd: 0,
      commissionPercent: terms.commissionPercent,
      currency,
    };
  }
  return { ok: false, message: INVALID_QUOTE_MESSAGE };
}

/** @param {object | null | undefined} campaign */
async function resolveCampaignDisplayName(campaign) {
  if (!campaign?.sessionId) return campaign?.id ? String(campaign.id) : "";
  const session = await getCampaignSessionById(campaign.sessionId);
  const title = session?.title != null ? String(session.title).trim() : "";
  return title || "未命名 Campaign";
}

/** @param {object} executionRow @param {string} influencerId */
function resolveInfluencerDisplayName(executionRow, influencerId) {
  const snap = parseJson(executionRow.influencer_snapshot) || {};
  const handle = executionRow.tiktok_username || influencerId;
  return snap.name || handle || influencerId;
}

function buildIdempotencyKey(campaignId, influencerId, executionRow = null) {
  const base = `quote_approve:${campaignId}:${String(influencerId).trim()}`;
  if (executionRow?.quote_origin === "commerce_profile_estimate") {
    return `${base}:system_profile`;
  }
  const lastEvent = parseJson(executionRow?.last_event) || executionRow?.lastEvent || {};
  if (executionRow?.quote_origin === "creator_quote" && lastEvent.systemQuoteRefundedAt) {
    const history = parseJson(executionRow?.quote_negotiation);
    const latestCreator = Array.isArray(history)
      ? [...history].reverse().find((entry) => entry?.role === "influencer" && entry?.at)
      : null;
    const suffix = String(latestCreator?.at || lastEvent.systemQuoteRefundedAt)
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 32);
    return `${base}:requote:${suffix || "creator"}`;
  }
  return base;
}

/**
 * 同意报价前余额预检（只读，不扣款、不改 stage）。
 * @param {{
 *   campaignId: string,
 *   influencerId: string,
 *   advertiserId: number,
 * }} opts
 */
export async function precheckQuoteApproveCharge(opts) {
  const campaignId = String(opts.campaignId || "").trim();
  const influencerId = String(opts.influencerId || "").trim();
  const advertiserId = Number(opts.advertiserId);

  if (!campaignId || !influencerId || !Number.isFinite(advertiserId)) {
    return { success: false, message: "缺少 campaignId、influencerId 或 advertiserId" };
  }

  const campaign = await getCampaignCoreById(campaignId);
  if (!campaign) {
    return { success: false, message: "Campaign 不存在" };
  }

  const executionRow = await getExecutionRow(campaignId, influencerId);
  if (!executionRow) {
    return { success: false, message: "红人执行记录不存在" };
  }

  const stage = executionRow.stage || STAGE_QUOTE_SUBMITTED;
  if (stage !== STAGE_QUOTE_SUBMITTED) {
    return { success: false, message: WRONG_STAGE_MESSAGE, code: "wrong_stage" };
  }

  const chargeResolved = resolveQuoteApproveCharge(campaign, executionRow);
  if (!chargeResolved.ok) {
    return { success: false, message: chargeResolved.message };
  }

  const chargeAmount = chargeResolved.chargeAmount;

  const [advRows] = await tiktokPool.execute(
    `SELECT balance_amount, balance_currency, credit_limit FROM tiktok_advertiser WHERE id = ? LIMIT 1`,
    [advertiserId]
  );
  if (!advRows?.length) {
    return { success: false, message: "广告主账户不存在" };
  }

  const balance = normalizeAdvertiserBalance(
    advRows[0].balance_amount,
    advRows[0].balance_currency
  );
  const currentBalance = balance.amount;
  const creditLimit = Number(advRows[0].credit_limit);
  const safeCreditLimit = Number.isFinite(creditLimit) && creditLimit > 0 ? creditLimit : 0;

  if (chargeAmount > 0 && currentBalance - chargeAmount < -safeCreditLimit) {
    return {
      success: false,
      message: formatInsufficientBalanceMessage(chargeAmount, currentBalance),
      code: "insufficient_balance",
      chargeAmount,
      currentBalance,
    };
  }

  const balanceAfter = Math.round((currentBalance - chargeAmount) * 10000) / 10000;

  return {
    success: true,
    chargeAmount,
    currentBalance,
    balanceAfter,
    influencerAmount: chargeResolved.influencerAmount,
    platformFeeAmount: chargeResolved.platformFeeAmount,
  };
}

/**
 * @param {{
 *   campaignId: string,
 *   influencerId: string,
 *   advertiserId: number,
 *   advertiserUserId?: number | null,
 *   contentBrief?: object | null,
 * }} opts
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

  const campaign = await getCampaignCoreById(campaignId);
  if (!campaign) {
    return { success: false, message: "Campaign 不存在" };
  }

  const executionRow = await getExecutionRow(campaignId, influencerId);
  if (!executionRow) {
    return { success: false, message: "红人执行记录不存在" };
  }

  const idempotencyKey = buildIdempotencyKey(campaignId, influencerId, executionRow);
  const stage = executionRow.stage || STAGE_QUOTE_SUBMITTED;

  if (stage !== STAGE_QUOTE_SUBMITTED) {
    const [ledgerRows] = await tiktokPool.execute(
      `SELECT id, amount, balance_after, influencer_amount, platform_fee_amount
       FROM tiktok_advertiser_balance_ledger WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey]
    );
    if (ledgerRows?.length) {
      const bal = Number(ledgerRows[0].balance_after);
      return {
        success: true,
        stage,
        chargedAmount: Math.abs(Number(ledgerRows[0].amount) || 0),
        influencerAmount: Math.abs(Number(ledgerRows[0].influencer_amount) || 0),
        platformFeeAmount: Math.abs(Number(ledgerRows[0].platform_fee_amount) || 0),
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
  const influencerAmount = chargeResolved.influencerAmount;
  const platformFeeAmount = chargeResolved.platformFeeAmount;
  const platformFeeRate = chargeResolved.platformFeeRate;
  const influencerSource = chargeResolved.influencerSource;

  const campaignName = await resolveCampaignDisplayName(campaign);
  const influencerDisplayName = resolveInfluencerDisplayName(executionRow, influencerId);

  const needSample = resolveNeedSample(campaign.productInfo);
  const isSystemSuggestedQuote = executionRow.quote_origin === "commerce_profile_estimate";
  const nextStage = isSystemSuggestedQuote
    ? "pending_creator_confirmation"
    : needSample ? STAGE_PENDING_SHIPPING_ADDRESS : "pending_script";
  const quoteApprovedAt = new Date().toISOString();

  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();

    const [ledgerDup] = await conn.execute(
      `SELECT id, balance_after, amount, influencer_amount, platform_fee_amount
       FROM tiktok_advertiser_balance_ledger
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
        const merged = {
          ...prevLastEvent,
          ...(isSystemSuggestedQuote
            ? { systemQuoteApprovedAt: quoteApprovedAt }
            : { quoteApprovedAt }),
          approvedTerms: buildApprovedTermsSnapshot(chargeResolved, ledgerDup[0].amount),
          ...(opts.contentBrief ? { contentBrief: opts.contentBrief } : {}),
        };
        await conn.execute(
          `UPDATE tiktok_campaign_execution SET stage = ?, last_event = ?
           WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
          [nextStage, JSON.stringify(merged), campaignId, ...paramsExecutionCreatorMatch(influencerId)]
        );
      }
      await conn.commit();
      invalidateExecutionCounts(campaignId);
      const bal = Number(ledgerDup[0].balance_after);
      return {
        success: true,
        stage: currentStage === STAGE_QUOTE_SUBMITTED ? nextStage : currentStage,
        chargedAmount: Math.abs(Number(ledgerDup[0].amount) || 0),
        influencerAmount: Math.abs(Number(ledgerDup[0].influencer_amount) || 0),
        platformFeeAmount: Math.abs(Number(ledgerDup[0].platform_fee_amount) || 0),
        balanceAfter: Number.isFinite(bal) ? bal : 0,
        alreadyProcessed: true,
      };
    }

    const [advRows] = await conn.execute(
      `SELECT balance_amount, balance_currency, credit_limit FROM tiktok_advertiser WHERE id = ? LIMIT 1 FOR UPDATE`,
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
    const creditLimit = Number(advRows[0].credit_limit);
    const safeCreditLimit = Number.isFinite(creditLimit) && creditLimit > 0 ? creditLimit : 0;

    if (chargeAmount > 0 && currentBalance - chargeAmount < -safeCreditLimit) {
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
        (advertiser_id, amount, balance_after, currency, type, campaign_id, influencer_id,
         influencer_amount, platform_fee_amount, platform_fee_rate, influencer_source,
         campaign_name, influencer_display_name, note,
         idempotency_key, created_by_user_id)
       VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        advertiserId,
        chargeAmount > 0 ? -chargeAmount : 0,
        balanceAfter,
        LEDGER_TYPE_QUOTE_APPROVE,
        campaignId,
        influencerId,
        chargeAmount > 0 ? -influencerAmount : 0,
        chargeAmount > 0 ? -platformFeeAmount : 0,
        chargeAmount > 0 ? platformFeeRate : null,
        chargeAmount > 0 ? influencerSource : null,
        campaignName,
        influencerDisplayName,
        `fixed_fee=${chargeResolved.fixedFeeUsd ?? 0}USD; commission=${
          chargeResolved.commissionPercent ?? "-"
        }%`,
        idempotencyKey,
        Number.isFinite(advertiserUserId) ? advertiserUserId : null,
      ]
    );

    const prevLastEvent =
      parseJson(executionRow.last_event) || executionRow.lastEvent || {};
    const merged = {
      ...prevLastEvent,
      ...(isSystemSuggestedQuote
        ? { systemQuoteApprovedAt: quoteApprovedAt }
        : { quoteApprovedAt }),
      // 合同/后续结算的条款快照：以「点击同意那一刻」的执行级条款为准
      approvedTerms: buildApprovedTermsSnapshot(chargeResolved, chargeAmount),
      ...(opts.contentBrief ? { contentBrief: opts.contentBrief } : {}),
    };
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
    invalidateExecutionCounts(campaignId);
    return {
      success: true,
      stage: nextStage,
      chargedAmount: chargeAmount,
      influencerAmount,
      platformFeeAmount,
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
