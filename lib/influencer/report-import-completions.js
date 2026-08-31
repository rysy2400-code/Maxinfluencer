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

  // 保护参数：只汇报最近 N 小时内完成的任务；每轮最多追加 M 条消息。
  // 避免控制面停机多天后恢复时一次性补发大量历史消息刷屏。
  const maxAgeHours = Math.max(
    1,
    Number(process.env.IMPORT_REPORT_MAX_AGE_HOURS || 48) || 48
  );
  const maxPerTick = Math.max(
    1,
    Number(process.env.IMPORT_REPORT_MAX_PER_TICK || 20) || 20
  );
  let budget = maxPerTick;

  // 1) 批次：全部子任务终态且未汇报 → 生成批次汇总（内部原子标记防重复）
  const batches = await queryTikTok(
    `
    SELECT campaign_id, batch_group_id, MAX(session_id) AS session_id,
           SUM(contact_mode = 'do_not_contact') AS dnc_count,
           COUNT(*) AS task_count
    FROM tiktok_influencer_import_task
    WHERE batch_group_id IS NOT NULL AND batch_group_id != ''
      AND batch_group_reported_at IS NULL
    GROUP BY campaign_id, batch_group_id
    HAVING SUM(status IN ('succeeded','failed','cancelled')) = COUNT(*)
      AND MAX(COALESCE(finished_at, updated_at)) >= DATE_SUB(NOW(), INTERVAL ? HOUR)
    ORDER BY MAX(COALESCE(finished_at, updated_at)) ASC
    LIMIT ?
  `,
    [maxAgeHours, budget]
  );
  for (const b of batches || []) {
    if (budget <= 0) break;
    if (!b?.campaign_id || !b?.batch_group_id) continue;
    // 纯「仅排重/不联系」批次：生效确认已同步返回，无需追加通用汇总（也无需再走 notify）
    if (Number(b.dnc_count) === Number(b.task_count)) {
      await queryTikTok(
        `UPDATE tiktok_influencer_import_task
         SET batch_group_reported_at = NOW(), updated_at = NOW()
         WHERE campaign_id = ? AND batch_group_id = ? AND batch_group_reported_at IS NULL`,
        [b.campaign_id, b.batch_group_id]
      );
      continue;
    }
    try {
      const r = await notifyImportBatchIfComplete({
        campaignId: b.campaign_id,
        batchGroupId: b.batch_group_id,
        sessionId: b.session_id || null,
      });
      if (r?.reported) {
        reportedBatch += 1;
        budget -= 1;
      }
    } catch (e) {
      console.warn(
        `[report-import-completions] 批次汇报失败 ${b.batch_group_id}: ${e?.message || e}`
      );
    }
  }

  // 2) 单任务（未拆分）：终态且已写 result_summary 且未汇报 → 追加一次
  const singles = await queryTikTok(
    `
    SELECT id, session_id, contact_mode, CAST(result_summary AS CHAR) AS rs
    FROM tiktok_influencer_import_task
    WHERE (batch_group_id IS NULL OR batch_group_id = '')
      AND status IN ('succeeded','failed','cancelled')
      AND result_summary IS NOT NULL AND result_summary != ''
      AND batch_group_reported_at IS NULL
      AND COALESCE(finished_at, updated_at) >= DATE_SUB(NOW(), INTERVAL ? HOUR)
    ORDER BY COALESCE(finished_at, updated_at) ASC
    LIMIT ?
  `,
    [maxAgeHours, budget]
  );
  for (const s of singles || []) {
    if (budget <= 0) break;
    const sid = String(s?.session_id || "").trim();
    const text = String(s?.rs || "").trim();
    if (!sid || !text) continue;
    // 「仅排重/不联系」单任务：与批次逻辑一致，标记已汇报但不再重复追加消息
    if (String(s?.contact_mode || "") === "do_not_contact") {
      await queryTikTok(
        `UPDATE tiktok_influencer_import_task
         SET batch_group_reported_at = NOW(), updated_at = NOW()
         WHERE id = ? AND batch_group_reported_at IS NULL`,
        [s.id]
      );
      continue;
    }
    try {
      await appendBinMessageToSession(sid, text);
      await queryTikTok(
        `UPDATE tiktok_influencer_import_task
         SET batch_group_reported_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [s.id]
      );
      reportedSingle += 1;
      budget -= 1;
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
