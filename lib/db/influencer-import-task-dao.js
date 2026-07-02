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

export async function createImportTask({
  campaignId,
  sessionId,
  importBatchId,
  platform = "mixed",
  priority = 150,
  payload,
  totalRows = 0,
  skippedDuplicateCount = 0,
  parseErrorCount = 0,
  sourceFileName = null,
  sourceFileStorageKey = null,
}) {
  const result = await queryTikTok(
    `
    INSERT INTO tiktok_influencer_import_task (
      campaign_id, session_id, import_batch_id, platform, priority, payload,
      total_rows, skipped_duplicate_count, parse_error_count,
      source_file_name, source_file_storage_key, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
    [
      campaignId,
      sessionId || null,
      importBatchId,
      platform,
      priority,
      JSON.stringify(payload || {}),
      totalRows,
      skippedDuplicateCount,
      parseErrorCount,
      sourceFileName,
      sourceFileStorageKey,
    ]
  );
  return Number(result?.insertId || 0);
}

export async function getImportTaskById(taskId) {
  const rows = await queryTikTok(
    `SELECT * FROM tiktok_influencer_import_task WHERE id = ? LIMIT 1`,
    [taskId]
  );
  if (!rows?.[0]) return null;
  const r = rows[0];
  return {
    ...r,
    payload: parseJson(r.payload) || {},
  };
}

export async function touchImportTaskLastProgressAt(taskId) {
  const id = Number(taskId || 0);
  if (!id) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET last_progress_at = NOW(), updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [id]
  );
}

export async function bumpImportTaskEnrichedProgress(taskId, delta = 1) {
  const id = Number(taskId || 0);
  const d = Number(delta || 0);
  if (!id || d <= 0) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET progress_enriched_count = progress_enriched_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [d, id]
  );
}

export async function bumpImportTaskAnalyzedProgress(taskId, delta = 1, recommendedDelta = 0) {
  const id = Number(taskId || 0);
  const d = Number(delta || 0);
  const rd = Number(recommendedDelta || 0);
  if (!id || d <= 0) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET progress_analyzed_count = progress_analyzed_count + ?,
        progress_recommended_count = progress_recommended_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [d, rd, id]
  );
}

export async function bumpImportTaskCountryProgress(
  taskId,
  { checkedDelta = 0, passedDelta = 0 } = {}
) {
  const id = Number(taskId || 0);
  const checked = Number(checkedDelta || 0);
  const passed = Number(passedDelta || 0);
  if (!id || (checked <= 0 && passed <= 0)) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET progress_country_checked_count = progress_country_checked_count + ?,
        progress_country_passed_count = progress_country_passed_count + ?,
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'processing'
  `,
    [checked, passed, id]
  );
}

export async function markImportTaskProcessing(taskId, workerId, workerHost, workerIp) {
  const id = Number(taskId || 0);
  if (!id) return false;
  const result = await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET status = 'processing',
        worker_id = ?,
        worker_host = ?,
        worker_ip = ?,
        attempt_count = attempt_count + 1,
        started_at = COALESCE(started_at, NOW()),
        last_progress_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status = 'pending'
  `,
    [workerId, workerHost, workerIp, id]
  );
  return Number(result?.affectedRows || 0) > 0;
}

export async function finishImportTask(taskId, { status, errorMessage = null, resultSummary = null } = {}) {
  const id = Number(taskId || 0);
  if (!id) return;
  await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET status = ?,
        error_message = ?,
        result_summary = ?,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status != 'cancelled'
  `,
    [status, errorMessage, resultSummary, id]
  );
}

export async function cancelImportTask(taskId, { reason = "user_cancelled", resultSummary = null } = {}) {
  const id = Number(taskId || 0);
  if (!id) return false;
  const result = await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET status = 'cancelled',
        error_message = ?,
        result_summary = ?,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND status IN ('pending', 'processing')
  `,
    [reason, resultSummary, id]
  );
  return Number(result?.affectedRows || 0) > 0;
}
