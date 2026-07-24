export const OUTREACH_COOLDOWN_MIN_MS = 20 * 60_000;
export const OUTREACH_COOLDOWN_MAX_MS = 40 * 60_000;

/** 每次首封邀约成功后，为该发件邮箱生成并固定下一次可发送时间。 */
export function createOutreachCooldown({ sentAt = new Date(), random = Math.random } = {}) {
  const sentMs = new Date(sentAt).getTime();
  if (!Number.isFinite(sentMs)) {
    throw new TypeError("sentAt 必须是有效时间");
  }

  const sample = Number(random());
  const normalized = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 1)
    : 0;
  const durationMs = Math.round(
    OUTREACH_COOLDOWN_MIN_MS +
      normalized * (OUTREACH_COOLDOWN_MAX_MS - OUTREACH_COOLDOWN_MIN_MS)
  );

  return {
    durationMs,
    nextEligibleAt: new Date(sentMs + durationMs).toISOString(),
  };
}

/** 历史记录没有持久化截止时间时采用 40 分钟，避免重启绕过新策略。 */
export function resolveOutreachNextEligibleMs({ lastAt, persistedNextEligibleAt }) {
  const persistedMs = new Date(persistedNextEligibleAt || "").getTime();
  if (Number.isFinite(persistedMs)) return persistedMs;

  const lastMs = new Date(lastAt || "").getTime();
  return Number.isFinite(lastMs) ? lastMs + OUTREACH_COOLDOWN_MAX_MS : NaN;
}
