import {
  INFLUENCER_SOURCE_USER,
  normalizeInfluencerSource,
} from "../influencer/influencer-source.js";

/** 平台发现红人：平台服务费 5% */
export const PLATFORM_FEE_RATE_PLATFORM = 0.05;

/** 用户导入红人：平台服务费 1% */
export const PLATFORM_FEE_RATE_USER = 0.01;

/** @deprecated 请使用 resolvePlatformFeeRate(source) */
export const PLATFORM_FEE_RATE = PLATFORM_FEE_RATE_PLATFORM;

/**
 * @param {unknown} source
 * @returns {number}
 */
export function resolvePlatformFeeRate(source) {
  return normalizeInfluencerSource(source) === INFLUENCER_SOURCE_USER
    ? PLATFORM_FEE_RATE_USER
    : PLATFORM_FEE_RATE_PLATFORM;
}

/**
 * @param {unknown} influencerAmount
 * @param {unknown} [sourceOrRate] 红人来源或显式费率
 * @returns {number}
 */
export function calcPlatformFee(influencerAmount, sourceOrRate) {
  const base = influencerAmount == null || influencerAmount === "" ? 0 : Number(influencerAmount);
  const safe = Number.isFinite(base) ? base : 0;
  if (safe <= 0) return 0;
  const rate =
    typeof sourceOrRate === "number" && Number.isFinite(sourceOrRate)
      ? sourceOrRate
      : resolvePlatformFeeRate(sourceOrRate);
  return Math.round(safe * rate * 100) / 100;
}

/**
 * @param {unknown} influencerAmount
 * @param {unknown} [sourceOrRate]
 * @returns {{
 *   influencerAmount: number,
 *   platformFeeAmount: number,
 *   platformFeeRate: number,
 *   totalDeduct: number,
 * }}
 */
export function splitChargeAmounts(influencerAmount, sourceOrRate) {
  const inf =
    influencerAmount == null || influencerAmount === "" ? 0 : Number(influencerAmount);
  const influencer = Number.isFinite(inf) ? Math.round(inf * 10000) / 10000 : 0;
  const platformFeeRate =
    typeof sourceOrRate === "number" && Number.isFinite(sourceOrRate)
      ? sourceOrRate
      : resolvePlatformFeeRate(sourceOrRate);
  const platformFee = calcPlatformFee(influencer, platformFeeRate);
  const totalDeduct = Math.round((influencer + platformFee) * 10000) / 10000;
  return {
    influencerAmount: influencer,
    platformFeeAmount: platformFee,
    platformFeeRate,
    totalDeduct,
  };
}
