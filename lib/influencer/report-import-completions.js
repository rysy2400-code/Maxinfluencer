/**
 * Web 端导入完成汇报：扫描未汇报的批次/单任务，批次全部终态后汇总一次发聊天框。
 * 爬虫端只写 result_summary/progress，不再追加聊天框消息。
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { notifyImportBatchIfComplete } from "./import-batch-coordinator.js";
import { appendBinMessageToSession } from "../db/campaign-session-dao.js";

export async function reportPendingImportCompletions() {
  let reportedBatch = 0;
  let reportedSingle = 0;

  // 1) 批次：全部子任务终态且未汇报 → 生成批次汇总（内部原子标记防重复）
  const batches = await queryTikTok(
    `
    SELECT campaign_id, batch_group_id, MAX(session_id) AS session_id
    FROM tiktok_influencer_import_task
    WHERE batch_group_id IS NOT NULL AND batch_group_id != ''
      AND batch_group_reported_at IS NULL
    GROUP BY campaign_id, batch_group_id
    HAVING SUM(status IN ('succeeded','failed','cancelled')) = COUNT(*)
  `,
    []
  );
  for (const b of batches || []) {
    if (!b?.campaign_id || !b?.batch_group_id) continue;
    try {
      const r = await notifyImportBatchIfComplete({
        campaignId: b.campaign_id,
        batchGroupId: b.batch_group_id,
        sessionId: b.session_id || null,
      });
      if (r?.reported) reportedBatch += 1;
    } catch (e) {
      console.warn(
        `[report-import-completions] 批次汇报失败 ${b.batch_group_id}: ${e?.message || e}`
      );
    }
  }

  // 2) 单任务（未拆分）：终态且已写 result_summary 且未汇报 → 追加一次
  const singles = await queryTikTok(
    `
    SELECT id, session_id, CAST(result_summary AS CHAR) AS rs
    FROM tiktok_influencer_import_task
    WHERE (batch_group_id IS NULL OR batch_group_id = '')
      AND status IN ('succeeded','failed','cancelled')
      AND result_summary IS NOT NULL AND result_summary != ''
      AND batch_group_reported_at IS NULL
    ORDER BY id ASC
  `,
    []
  );
  for (const s of singles || []) {
    const sid = String(s?.session_id || "").trim();
    const text = String(s?.rs || "").trim();
    if (!sid || !text) continue;
    try {
      await appendBinMessageToSession(sid, text);
      await queryTikTok(
        `UPDATE tiktok_influencer_import_task
         SET batch_group_reported_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [s.id]
      );
      reportedSingle += 1;
    } catch (e) {
      console.warn(
        `[report-import-completions] 单任务汇报失败 ${s.id}: ${e?.message || e}`
      );
    }
  }

  if (reportedBatch || reportedSingle) {
    console.log(
      `[report-import-completions] reported batch=${reportedBatch} single=${reportedSingle}`
    );
  }
  return { reportedBatch, reportedSingle };
}
