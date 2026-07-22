import { queryTikTok } from "./mysql-tiktok.js";

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function findRecentCrawlerAction(machineId, actionType, sinceMinutes) {
  const rows = await queryTikTok(
    `SELECT * FROM tiktok_crawler_repair_action_log
     WHERE machine_id = ? AND action_type = ?
       AND started_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND result IN ('started','succeeded')
     ORDER BY id DESC LIMIT 1`,
    [machineId, actionType, sinceMinutes]
  );
  return rows?.[0] || null;
}

export async function startCrawlerAction({
  machine,
  platform,
  actionType,
  reason,
  requestedByUserId,
  targetReleaseSha = null,
}) {
  const result = await queryTikTok(
    `INSERT INTO tiktok_crawler_repair_action_log
      (machine_id, worker_host, worker_ip, platform, action_type, trigger_reason,
       request_reason, target_release_sha, result, started_at, operator, requested_by_user_id)
     VALUES (?, ?, ?, ?, ?, 'manual_super_admin', ?, ?, 'started', NOW(), 'manual', ?)`,
    [
      machine.id,
      machine.expectedWorkerHost || machine.machineKey,
      machine.publicIp,
      platform || null,
      actionType,
      reason,
      targetReleaseSha,
      requestedByUserId,
    ]
  );
  return Number(result?.insertId || 0);
}

export async function finishCrawlerAction(actionId, { ok, detail }) {
  await queryTikTok(
    `UPDATE tiktok_crawler_repair_action_log
     SET result=?, detail=?, finished_at=NOW(), updated_at=NOW()
     WHERE id=?`,
    [ok ? "succeeded" : "failed", String(detail || "").slice(0, 65000), actionId]
  );
}

export async function listCrawlerActions(machineId, limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = await queryTikTok(
    `SELECT id, machine_id, worker_ip, platform, action_type, trigger_reason,
            request_reason, target_release_sha, result, detail, operator,
            requested_by_user_id, started_at, finished_at
     FROM tiktok_crawler_repair_action_log
     WHERE machine_id=? ORDER BY id DESC LIMIT ${safeLimit}`,
    [machineId]
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    machineId: Number(row.machine_id),
    workerIp: row.worker_ip || null,
    platform: row.platform || null,
    actionType: row.action_type,
    reason: row.request_reason || row.trigger_reason || null,
    targetReleaseSha: row.target_release_sha || null,
    result: row.result,
    detail: row.detail || null,
    operator: row.operator,
    requestedByUserId:
      row.requested_by_user_id == null ? null : Number(row.requested_by_user_id),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  }));
}
