/**
 * Report Skill：根据 campaign 执行状态和汇报偏好，生成日报文本。
 *
 * 模式：
 * - brief：简要汇总（关键数字 + 一两句总结）
 * - detailed：详细报告（按阶段展开）
 * - summary_only：仅汇总数字（无额外说明）
 */

/**
 * @typedef {Object} ExecutionStatus
 * @property {string} campaignId
 * @property {Object} columns
 * @property {Array} columns.pendingPrice
 * @property {Array} columns.pendingSample
 * @property {Array} columns.pendingDraft
 * @property {Array} columns.published
 */

/**
 * 生成执行进度日报
 * @param {Object} params
 * @param {ExecutionStatus} params.executionStatus
 * @param {string} params.contentPreference - 'brief' | 'detailed' | 'summary_only'
 * @param {Array<string>} params.includeMetrics
 * @returns {{ text: string, metrics: Object }}
 */
export function generateExecutionReport({
  executionStatus,
  contentPreference = "brief",
  includeMetrics = [],
}) {
  const cols = executionStatus?.columns || {};
  const pendingPrice = cols.pendingPrice || [];
  const pendingSample = cols.pendingSample || [];
  const pendingDraft = cols.pendingDraft || [];
  const published = cols.published || [];

  const metricValues = {
    pending_price_count: pendingPrice.length,
    pending_sample_count: pendingSample.length,
    pending_draft_count: pendingDraft.length,
    published_count: Number(executionStatus?.publishedCount || published.length || 0),
  };

  // 过滤出需要展示的指标
  let metricsToShow;
  if (Array.isArray(includeMetrics) && includeMetrics.length) {
    metricsToShow = includeMetrics;
  } else {
    // 默认指标：若明确不寄样，则不展示「待寄送样品」
    const base = ["pending_price_count", "pending_draft_count", "published_count"];
    if (executionStatus?.needSample !== false) {
      base.splice(1, 0, "pending_sample_count");
    }
    metricsToShow = base;
  }

  const metricLines = metricsToShow.map((key) => {
    const value = metricValues[key] ?? 0;
    if (key === "pending_price_count") return `- 待审核价格：${value} 位红人`;
    if (key === "pending_sample_count") return `- 待寄送样品：${value} 位红人`;
    if (key === "pending_draft_count") return `- 待审核草稿：${value} 位红人`;
    if (key === "published_count") return `- 已发布视频：${value} 位红人`;
    return `- ${key}：${value}`;
  });

  const lines = [];

  // 共同的头部
  lines.push(`执行进度日报（Campaign ${executionStatus?.campaignId || ""}）：`);
  lines.push("");

  // 1）数字汇总区（所有模式都会展示）
  lines.push("【关键指标】");
  lines.push(...metricLines);

  const metrics = {};
  metricsToShow.forEach((key) => {
    metrics[key] = metricValues[key] ?? 0;
  });

  if (contentPreference === "summary_only") {
    // 仅汇总数字
    return {
      text: lines.join("\n"),
      metrics,
    };
  }

  // 2）简要/详细模式下的分段说明
  lines.push("");
  lines.push("【阶段分布】");
  lines.push(`- 待审核价格：${pendingPrice.length} 位红人`);
  if (executionStatus?.needSample !== false) {
    lines.push(`- 待寄送样品：${pendingSample.length} 位红人`);
  }
  lines.push(`- 待审核草稿：${pendingDraft.length} 位红人`);
  lines.push(`- 已发布视频：${published.length} 位红人`);

  if (contentPreference === "brief") {
    // 简要模式：给一两句总结即可
    lines.push("");
    const focus =
      pendingDraft.length > 0
        ? `当前有 ${pendingDraft.length} 位红人等待草稿审核，建议尽快处理。`
        : published.length > 0
        ? `已发布 ${published.length} 条视频，可以开始关注投放效果。`
        : `目前整体还在推进 early stage，可继续自动联系新红人。`;
    lines.push(`【总结】${focus}`);

    return {
      text: lines.join("\n"),
      metrics,
    };
  }

  // detailed 模式：稍微展开一些 Top N 明细
  const maxExamples = 5;
  const formatInfluencer = (inf) => {
    const name = inf.username || inf.name || inf.id || "未命名红人";
    const followers = inf.followers ?? inf.followerCount ?? "—";
    return `${name}（粉丝 ${followers}）`;
  };

  if (pendingDraft.length > 0) {
    lines.push("");
    lines.push("【待审核草稿示例】");
    pendingDraft.slice(0, maxExamples).forEach((inf, idx) => {
      lines.push(`- ${idx + 1}. ${formatInfluencer(inf)}`);
    });
    if (pendingDraft.length > maxExamples) {
      lines.push(`… 其余 ${pendingDraft.length - maxExamples} 位略`);
    }
  }

  if (published.length > 0) {
    lines.push("");
    lines.push("【已发布示例】");
    published.slice(0, maxExamples).forEach((inf, idx) => {
      const views = inf.views ?? inf.playCount ?? "—";
      const likes = inf.likes ?? inf.likeCount ?? "—";
      lines.push(
        `- ${idx + 1}. ${formatInfluencer(inf)}，播放 ${views}，点赞 ${likes}`
      );
    });
    if (published.length > maxExamples) {
      lines.push(`… 其余 ${published.length - maxExamples} 位略`);
    }
  }

  return {
    text: lines.join("\n"),
    metrics,
  };
}

