/** 平台服务费比例（红人合作费） */
export const PLATFORM_FEE_RATE = 0.05;

/**
 * @param {unknown} influencerAmount
 * @returns {number}
 */
export function calcPlatformFee(influencerAmount) {
  const base = influencerAmount == null || influencerAmount === "" ? 0 : Number(influencerAmount);
  const safe = Number.isFinite(base) ? base : 0;
  if (safe <= 0) return 0;
  return Math.round(safe * PLATFORM_FEE_RATE * 100) / 100;
}

/**
 * @param {unknown} influencerAmount
 * @returns {{ influencerAmount: number, platformFeeAmount: number, totalDeduct: number }}
 */
export function splitChargeAmounts(influencerAmount) {
  const inf =
    influencerAmount == null || influencerAmount === "" ? 0 : Number(influencerAmount);
  const influencer = Number.isFinite(inf) ? Math.round(inf * 10000) / 10000 : 0;
  const platformFee = calcPlatformFee(influencer);
  const totalDeduct = Math.round((influencer + platformFee) * 10000) / 10000;
  return {
    influencerAmount: influencer,
    platformFeeAmount: platformFee,
    totalDeduct,
  };
}
