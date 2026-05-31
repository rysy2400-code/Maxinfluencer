/**
 * 爬虫自愈事件 DAO（tiktok_crawler_self_heal_event）
 */
import { queryTikTok } from "./mysql-tiktok.js";

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

function mapSelfHealRow(r) {
  return {
    id: r.id,
    campaignId: r.campaign_id || null,
    taskId: r.task_id != null ? Number(r.task_id) : null,
    runId: r.run_id || null,
    platform: r.platform || null,
    workerHost: r.worker_host || null,
    workerIp: r.worker_ip || null,
    eventType: r.event_type,
    severity: r.severity || "warn",
    reason: r.reason || null,
    details: parseJson(r.details),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function isMissingTableError(error) {
  return error?.code === "ER_NO_SUCH_TABLE" || error?.message?.includes("doesn't exist");
}

/**
 * 运维台：列出最近自愈事件（可按 Campaign / 严重级别过滤）
 * @param {{ campaignId?: string, severity?: string, limit?: number }} [opts]
 */
export async function listCrawlerSelfHealEvents(opts = {}) {
  const { campaignId, severity } = opts;
  const safeLimit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const where = [];
  const params = [];

  if (campaignId) {
    where.push("campaign_id = ?");
    params.push(String(campaignId));
  }
  if (severity && ["info", "warn", "error"].includes(String(severity))) {
    where.push("severity = ?");
    params.push(String(severity));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const rows = await queryTikTok(
      `
      SELECT *
      FROM tiktok_crawler_self_heal_event
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit}
    `,
      params
    );
    return (rows || []).map(mapSelfHealRow);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

/**
 * 按 Campaign 列出最近自愈事件
 * @param {string} campaignId
 * @param {number} [limit=20]
 */
export async function listCrawlerSelfHealEventsByCampaign(campaignId, limit = 20) {
  if (!campaignId) return [];
  return listCrawlerSelfHealEvents({ campaignId, limit });
}
