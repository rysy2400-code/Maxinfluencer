#!/usr/bin/env node
/** 复制任务 83（WorkBuddy 642 人）payload，重建导入任务（验证修复后的 bio 门禁+enrich 恢复链）。 */
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
const { createImportTask, cancelImportTask } = await import("../lib/db/influencer-import-task-dao.js");

// 取消被打断的任务 95（若仍 processing）
await cancelImportTask(95, { reason: "deploy 中断，重建 96 验证" }).catch((e) =>
  console.log("CANCEL95_ERR " + (e?.message || e))
);

const src = await queryTikTok(
  `SELECT campaign_id, session_id, total_rows, source_file_name, payload
   FROM tiktok_influencer_import_task WHERE id=83`
);
const row = src?.[0];
if (!row) {
  console.log("TASK83_NOT_FOUND");
  await tiktokPool.end();
  process.exit(1);
}
const payload =
  typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload || {};
const ts = Date.now();
const importBatchId = `IMP-V2-${ts}`;
payload.importBatchId = importBatchId;
const taskId = await createImportTask({
  campaignId: row.campaign_id,
  sessionId: row.session_id,
  importBatchId,
  platform: "tiktok",
  priority: 150,
  payload,
  totalRows: Number(row.total_rows) || 0,
  sourceFileName: row.source_file_name || null,
  sourceFileStorageKey: null,
});
console.log("CREATED " + JSON.stringify({ taskId, importBatchId, rows: (payload.rows || []).length, campaign: row.campaign_id }));
await tiktokPool.end();
process.exit(0);
