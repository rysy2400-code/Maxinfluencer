/**
 * Campaign 汇报配置 DAO
 */
import { queryTikTok } from "./mysql-tiktok.js";

// 安全解析 JSON：若已是对象/数组则直接返回，避免 mysql2 已解析的 JSON 列被二次 parse 报错
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

export async function getReportConfigByCampaignId(campaignId) {
  const sql = `SELECT * FROM tiktok_campaign_report_config WHERE campaign_id = ?`;
  const rows = await queryTikTok(sql, [campaignId]);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    campaignId: r.campaign_id,
    intervalHours: r.interval_hours != null ? Number(r.interval_hours) : null,
    reportTime: r.report_time,
    contentPreference: r.content_preference,
    includeMetrics: parseJson(r.include_metrics) || [],
    abnormalRules: parseJson(r.abnormal_rules) || null,
    lastReportAt: r.last_report_at ? new Date(r.last_report_at) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertReportConfig(data) {
  const campaignId = data.campaignId;
  // 0.5–336 小时，默认 24
  let intervalHours = typeof data.intervalHours === "number" ? data.intervalHours : null;
  if (intervalHours == null || !Number.isFinite(intervalHours)) {
    intervalHours = 24;
  }
  intervalHours = Math.min(Math.max(intervalHours, 0.5), 336);
  const reportTime = data.reportTime || "09:00";
  const contentPreference = data.contentPreference || "brief";
  const includeMetrics = data.includeMetrics ? JSON.stringify(data.includeMetrics) : "[]";
   const abnormalRules = data.abnormalRules ? JSON.stringify(data.abnormalRules) : null;

  const sql = `
    INSERT INTO tiktok_campaign_report_config (campaign_id, interval_hours, report_time, content_preference, include_metrics, abnormal_rules)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      interval_hours = VALUES(interval_hours),
      report_time = VALUES(report_time),
      content_preference = VALUES(content_preference),
      include_metrics = VALUES(include_metrics),
      abnormal_rules = VALUES(abnormal_rules),
      updated_at = NOW()
  `;
  await queryTikTok(sql, [campaignId, intervalHours, reportTime, contentPreference, includeMetrics, abnormalRules]);
  return getReportConfigByCampaignId(campaignId);
}

export async function updateLastReportAt(campaignId, date) {
  const ts =
    date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString().slice(0, 19).replace("T", " ")
      : null;
  await queryTikTok(
    "UPDATE tiktok_campaign_report_config SET last_report_at = ? WHERE campaign_id = ?",
    [ts, campaignId]
  );
}


