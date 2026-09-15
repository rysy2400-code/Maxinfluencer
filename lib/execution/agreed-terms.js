/**
 * 执行级「已谈定条款」：固定费（fixed fee）+ 佣金（commission）。
 *
 * 语义（与 UI / 合同 / 扣款共用，务必一致）：
 * - 固定费：复用 tiktok_campaign_execution.flat_fee（优先取 quote_negotiation 中最近一条红人报价）
 * - 佣金：tiktok_campaign_execution.commission_percent
 * - 数值（含 0）= 已谈定；null = 尚未谈定。
 *   **禁止**用 0 表示「未谈定」——0 是「明确谈定为零」。
 *
 * campaign 上的「单位红人报价策略」（ask_creator_quote / commission_only / ecpm_with_cap）
 * 只决定首封邀约口径；审批、合同、卡片一律不再读它。
 */
import { resolveLatestInfluencerQuoteFromRow } from "./quote-resolution.js";

export const PRICING_MODE_COMMISSION_ONLY = "commission_only";

/** 固定费：>= 0 的美元数值；null/空/非法 → null（未谈定） */
export function normalizeFixedFeeUsd(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10000) / 10000;
}

/** 佣金百分比：0–100；null/空/非法/超范围 → null（未谈定） */
export function normalizeCommissionPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10000) / 10000;
}

/** campaign 级配置的佣金（作为「佣金没单独谈过」时的口径） */
export function campaignCommissionPercent(campaign) {
  return (
    normalizeCommissionPercent(campaign?.commissionPercent) ??
    normalizeCommissionPercent(campaign?.campaignInfo?.commission) ??
    normalizeCommissionPercent(campaign?.commission)
  );
}

/** 首封邀约口径：记录在 last_event.outreachEmail.pricingMode（存量数据的唯一执行级线索） */
export function resolveInvitePricingMode(executionRow) {
  const lastEvent =
    executionRow?.lastEvent && typeof executionRow.lastEvent === "object"
      ? executionRow.lastEvent
      : parseJsonObject(executionRow?.last_event);
  const mode = lastEvent?.outreachEmail?.pricingMode;
  return mode == null ? null : String(mode).trim() || null;
}

function parseJsonObject(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const o = JSON.parse(value);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/**
 * 解析某条执行记录已谈定的条款。
 * @returns {{
 *   fixedFeeUsd: number|null,
 *   commissionPercent: number|null,
 *   currency: string,
 *   invitePricingMode: string|null,
 *   isCommissionOnlyInvite: boolean,
 *   hasFixedFee: boolean,
 *   hasCommission: boolean,
 *   isQuoteReady: boolean,
 * }}
 */
export function resolveExecutionAgreedTerms(campaign, executionRow) {
  const latestQuote = resolveLatestInfluencerQuoteFromRow(executionRow);
  const invitePricingMode = resolveInvitePricingMode(executionRow);
  const isCommissionOnlyInvite =
    invitePricingMode === PRICING_MODE_COMMISSION_ONLY ||
    (invitePricingMode == null &&
      campaign?.campaignInfo?.influencerPricing?.mode === PRICING_MODE_COMMISSION_ONLY);
  // 纯佣金/纯置换邀约本身就把固定费定为 0：红人接受邀约即为「确定价格」，无需再追问固定费。
  const fixedFeeUsd =
    normalizeFixedFeeUsd(latestQuote?.amount) ??
    (isCommissionOnlyInvite ? 0 : null);
  const executionCommission = normalizeCommissionPercent(
    executionRow?.commissionPercent ?? executionRow?.commission_percent
  );
  // 佣金在 campaign 上本就是品牌配置的固定条款，执行级没单独谈过时按 campaign 口径；
  // 固定费没有这个兜底：它必须逐条谈定。
  const commissionPercent = executionCommission ?? campaignCommissionPercent(campaign);

  const currency = String(
    latestQuote?.currency ||
      executionRow?.currency ||
      "USD"
  )
    .trim()
    .toUpperCase() || "USD";

  return {
    fixedFeeUsd,
    commissionPercent,
    currency,
    invitePricingMode,
    isCommissionOnlyInvite,
    hasFixedFee: fixedFeeUsd != null,
    hasCommission: commissionPercent != null,
    isQuoteReady: fixedFeeUsd != null && commissionPercent != null,
  };
}

/**
 * 硬准入：进 quote_submitted（待审核价格）前，固定费与佣金都必须是明确值（可以是 0）。
 * @returns {{ ready: boolean, reason?: string }}
 */
export function validateQuoteSubmittedAdmission(terms) {
  const fixed = normalizeFixedFeeUsd(terms?.fixedFeeUsd);
  const commission = normalizeCommissionPercent(terms?.commissionPercent);
  if (fixed == null && commission == null) {
    return {
      ready: false,
      reason: "红人尚未确认固定费与佣金，继续保持待报价并继续与红人确认价格。",
    };
  }
  if (fixed == null) {
    return {
      ready: false,
      reason: "红人尚未确认固定费（可为 0，但必须明确），继续保持待报价。",
    };
  }
  if (commission == null) {
    return {
      ready: false,
      reason: "红人尚未确认佣金比例（可为 0，但必须明确），继续保持待报价。",
    };
  }
  return { ready: true };
}
