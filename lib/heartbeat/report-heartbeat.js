/**
 * 报表心跳：根据 tiktok_campaign_report_config 的配置，决定哪些 Campaign 需要发送常规汇报。
 * 触发后将日报写入 tiktok_campaign_sessions.messages，品牌方前端对话框可见。
 */

import { queryTikTok } from "../db/mysql-tiktok.js";
import { getCampaignExecutionStatus } from "../db/campaign-dao.js";
import {
  getReportConfigByCampaignId,
  updateLastReportAt,
} from "../db/campaign-report-config-dao.js";
import { appendBinMessageToSession } from "../db/campaign-session-dao.js";
import { generateExecutionReport } from "./report-skill.js";

function toLocalTime(date, tzOffsetMinutes = 0) {
  // 简化处理：允许未来根据时区扩展，目前直接用服务器时间
  return new Date(date.getTime() + tzOffsetMinutes * 60000);
}

/**
 * 判断某个 campaign 是否该在当前心跳 tick 中发送常规汇报
 * @param {Object} cfg - getReportConfigByCampaignId 返回的配置
 * @param {Date} now
 * @returns {boolean}
 */
function shouldSendRegularReport(cfg, now) {
  const intervalHours =
    typeof cfg.intervalHours === "number" && cfg.intervalHours > 0
      ? cfg.intervalHours
      : 24;
  const intervalMs = intervalHours * 3600 * 1000;
  const last = cfg.lastReportAt instanceof Date && !Number.isNaN(cfg.lastReportAt.getTime())
    ? cfg.lastReportAt
    : null;

  // 纯小时频率（非整天倍数）：仅按 lastReportAt 和 interval 判断
  const isWholeDays = intervalHours % 24 === 0;
  if (!isWholeDays) {
    if (!last) return true;
    return now.getTime() - last.getTime() >= intervalMs;
  }

  // 整天频率：考虑对齐时间点 report_time（例如每天 10:00）
  const [hh, mm] = (cfg.reportTime || "09:00").split(":").map((v) => parseInt(v, 10) || 0);
  const localNow = toLocalTime(now, 0);
  const anchor = new Date(localNow);
  anchor.setHours(hh, mm, 0, 0);

  // 只在 anchor 附近的一小段窗口内触发（例如 ±10 分钟）
  const windowMs = 10 * 60 * 1000;
  const diffToAnchor = Math.abs(localNow.getTime() - anchor.getTime());
  if (diffToAnchor > windowMs) {
    return false;
  }

  if (!last) return true;
  return now.getTime() - last.getTime() >= intervalMs;
}

/**
 * 运行一次汇报心跳（单次 tick）
 * @param {Date} [now] - 当前时间，默认 new Date()
 */
export async function runReportHeartbeatTick(now = new Date()) {
  // 1. 获取所有有汇报配置的 campaign 列表
  const rows = await queryTikTok(
    `
    SELECT rc.campaign_id, c.session_id
    FROM tiktok_campaign_report_config rc
    INNER JOIN tiktok_campaign c ON c.id = rc.campaign_id
    WHERE c.status = 'running'
  `
  );
  if (!rows || rows.length === 0) {
    console.log("[ReportHeartbeat] 当前没有任何汇报配置，跳过。");
    return;
  }

  console.log(
    `[ReportHeartbeat] 心跳开始，检查 ${rows.length} 个 campaign，时间：${now.toISOString()}`
  );

  for (const row of rows) {
    const campaignId = row.campaign_id;
    const sessionId =
      typeof row.session_id === "string" ? row.session_id.trim() : "";
    try {
      const cfg = await getReportConfigByCampaignId(campaignId);
      if (!cfg) continue;

      if (!shouldSendRegularReport(cfg, now)) {
        continue;
      }

      if (!sessionId) {
        console.warn(
          `[ReportHeartbeat] Campaign ${campaignId} 无 session_id，跳过写入对话框`
        );
        continue;
      }

      const status = await getCampaignExecutionStatus(campaignId);
      const { text: summary } = generateExecutionReport({
        executionStatus: status,
        contentPreference: cfg.contentPreference || "brief",
        includeMetrics: cfg.includeMetrics || [],
      });

      const content = `【执行进度汇报】\n\n${summary}`;
      const appendResult = await appendBinMessageToSession(sessionId, content);
      if (!appendResult.success) {
        console.error(
          `[ReportHeartbeat] Campaign ${campaignId} 写入会话失败:`,
          appendResult.message
        );
        continue;
      }

      console.log(
        `[ReportHeartbeat] Campaign ${campaignId} 已写入会话 ${sessionId}（${summary.split("\n")[0] || "汇报"}）`
      );

      await updateLastReportAt(campaignId, now);
    } catch (e) {
      console.error(
        `[ReportHeartbeat] 处理 Campaign ${campaignId} 时出错:`,
        e
      );
    }
  }

  console.log("[ReportHeartbeat] 心跳结束。");
}

