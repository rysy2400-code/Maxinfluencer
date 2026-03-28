/**
 * 心跳 worker 使用的「异常汇报」最小规则集合与判断逻辑。
 *
 * 设计目标：
 * - 字段最小化，方便在 DB 中存 JSON
 * - 逻辑清晰，便于扩展更多规则
 *
 * 推荐的 abnormalRules 结构（存入 tiktok_campaign_report_config.abnormal_rules）：
 *
 * {
 *   enabled: true,
 *   // 当某个阶段人数 >= 阈值时触发一次异常汇报
 *   pendingDraftThreshold: 10,
 *   pendingQuoteThreshold: 50,
 *   // 与上一次异常汇报的冷却时间（分钟），避免短时间内重复刷屏
 *   cooldownMinutes: 60
 * }
 */

/**
 * 判断是否需要触发「异常汇报」
 *
 * @param {Object} params
 * @param {Object} params.abnormalRules - 来自 DB 的异常规则 JSON（若不存在则为 null）
 * @param {Object} params.executionStatus - getCampaignExecutionStatus 返回的数据
 * @param {Date|null} params.lastAbnormalAt - 上一次异常汇报时间（可选，后续可从单独表或日志中恢复）
 * @param {Date} [params.now] - 当前时间，主要便于测试，默认 new Date()
 * @returns {{ shouldReport: boolean, reasons: string[] }}
 */
export function shouldTriggerAbnormalReport({
  abnormalRules,
  executionStatus,
  lastAbnormalAt,
  now = new Date(),
}) {
  const reasons = [];

  if (!abnormalRules || abnormalRules.enabled === false) {
    return { shouldReport: false, reasons };
  }

  const cooldownMinutes =
    typeof abnormalRules.cooldownMinutes === "number"
      ? abnormalRules.cooldownMinutes
      : 60;

  if (lastAbnormalAt instanceof Date && !Number.isNaN(lastAbnormalAt.getTime())) {
    const diffMs = now.getTime() - lastAbnormalAt.getTime();
    const diffMinutes = diffMs / 60000;
    if (diffMinutes < cooldownMinutes) {
      return { shouldReport: false, reasons };
    }
  }

  const cols = executionStatus?.columns || {};
  const pendingDraftCount = cols.pendingDraft?.length || 0;
  const pendingQuoteCount = cols.pendingPrice?.length || 0;

  const draftThreshold =
    typeof abnormalRules.pendingDraftThreshold === "number"
      ? abnormalRules.pendingDraftThreshold
      : null;
  const quoteThreshold =
    typeof abnormalRules.pendingQuoteThreshold === "number"
      ? abnormalRules.pendingQuoteThreshold
      : null;

  if (draftThreshold != null && pendingDraftCount >= draftThreshold) {
    reasons.push(
      `待审核草稿人数达到阈值：${pendingDraftCount}/${draftThreshold}`
    );
  }

  if (quoteThreshold != null && pendingQuoteCount >= quoteThreshold) {
    reasons.push(
      `待审核价格人数达到阈值：${pendingQuoteCount}/${quoteThreshold}`
    );
  }

  return {
    shouldReport: reasons.length > 0,
    reasons,
  };
}

