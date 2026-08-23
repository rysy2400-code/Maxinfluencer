/**
 * 导入批次协调器：
 * 平台子任务全部进入终态后，在聊天框汇报一次汇总（含各平台成功/失败）。
 * 用 batch_group_reported_at 原子标记防重复汇报。
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { platformLabel } from "./import-platform-split.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function parseContactedFromSummary(resultSummary) {
  const text = String(resultSummary || "");
  const m = text.match(/已联系[：:]\s*(\d+)/);
  return m ? Number(m[1]) || 0 : 0;
}

function errorSnippet(errorMessage, max = 90) {
  const text = String(errorMessage || "").trim();
  if (!text) return "";
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/**
 * @param {Array<object>} rows - tiktok_influencer_import_task 行
 */
export function buildImportBatchSummary(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";

  let totalRows = 0;
  let analyzed = 0;
  let recommended = 0;
  let contacted = 0;
  const failed = [];
  const cancelled = [];
  const lines = [];
  const anyContactAll = list.some(
    (r) => String(r.contact_mode || r.contactMode || "") === "contact_all"
  );

  for (const r of list) {
    const n = Number(r.total_rows || 0) || 0;
    const label = platformLabel(r.platform);
    const analyzedN = Number(r.progress_analyzed_count || 0) || 0;
    const recommendedN = Number(r.progress_recommended_count || 0) || 0;
    const contactedN = parseContactedFromSummary(r.result_summary);
    totalRows += n;
    analyzed += analyzedN;
    recommended += recommendedN;
    contacted += contactedN;

    if (r.status === "succeeded") {
      lines.push(
        `- ${label}（${n} 位）：已分析 ${analyzedN} · 推荐 ${recommendedN} · 已联系 ${contactedN}`
      );
    } else if (r.status === "cancelled") {
      cancelled.push(label);
      lines.push(`- ${label}（${n} 位）：已取消`);
    } else {
      failed.push(`${label}：${errorSnippet(r.error_message) || "执行失败"}`);
      lines.push(`- ${label}（${n} 位）：失败（${errorSnippet(r.error_message) || "未知错误"}）`);
    }
  }

  const modeNote = anyContactAll
    ? "（直接联系模式：符合 campaign 投放地区且有邮箱的红人一律联系）"
    : "";
  const head =
    failed.length || cancelled.length
      ? `【名单导入完成】共 ${totalRows} 位红人，其中 ${failed.length} 个平台执行失败${modeNote}`
      : `【名单导入完成】共 ${totalRows} 位红人，已分析 ${analyzed} · 推荐 ${recommended} · 已联系 ${contacted}${modeNote}`;

  return [head, "", ...lines, "", "可在执行总览查看详情。"].join("\n");
}

/**
 * 批次所有子任务进入终态后汇报一次；否则不汇报。
 * @param {{ campaignId: string, batchGroupId: string, sessionId?: string|null }} input
 * @returns {Promise<{ reported: boolean, pending?: boolean, alreadyReported?: boolean }>}
 */
export async function notifyImportBatchIfComplete({
  campaignId,
  batchGroupId,
  sessionId = null,
}) {
  if (!campaignId || !batchGroupId) return { reported: false };

  const rows = await queryTikTok(
    `
    SELECT id, platform, status, total_rows, contact_mode,
           progress_enriched_count, progress_analyzed_count, progress_recommended_count,
           result_summary, error_message, batch_group_reported_at
    FROM tiktok_influencer_import_task
    WHERE campaign_id = ? AND batch_group_id = ?
    ORDER BY id ASC
  `,
    [campaignId, batchGroupId]
  );

  if (!rows?.length) return { reported: false };
  if (rows.some((r) => !TERMINAL_STATUSES.has(r.status))) {
    return { reported: false, pending: true };
  }
  if (rows.some((r) => r.batch_group_reported_at)) {
    return { reported: false, alreadyReported: true };
  }

  const claim = await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET batch_group_reported_at = NOW(), updated_at = NOW()
    WHERE campaign_id = ? AND batch_group_id = ? AND batch_group_reported_at IS NULL
  `,
    [campaignId, batchGroupId]
  );
  if (!Number(claim?.affectedRows || 0)) {
    return { reported: false, alreadyReported: true };
  }

  const summary = buildImportBatchSummary(rows);
  const safeSessionId = String(sessionId || "").trim();
  if (safeSessionId && summary) {
    try {
      const { appendBinMessageToSession } = await import("../db/campaign-session-dao.js");
      await appendBinMessageToSession(safeSessionId, summary);
    } catch (e) {
      console.warn("[import-batch-coordinator] 追加批次汇总失败:", e?.message || e);
    }
  }
  return { reported: true };
}

/**
 * 子任务完成/失败后的统一入口：
 * 平台子任务（有 batch_group_id）走批次汇总；否则保持旧行为（成功立即汇报）。
 * @param {{ task: object, fallbackSummary?: string|null }} input
 */
export async function notifyImportBatchOrSession({ task = {}, fallbackSummary = null }) {
  const batchGroupId =
    task?.batch_group_id || task?.batchGroupId || null;
  const campaignId = task?.campaign_id || task?.campaignId || null;
  const sessionId = String(
    task?.session_id || task?.sessionId || ""
  ).trim();

  if (batchGroupId && campaignId) {
    return notifyImportBatchIfComplete({ campaignId, batchGroupId, sessionId });
  }

  if (sessionId && fallbackSummary) {
    try {
      const { appendBinMessageToSession } = await import("../db/campaign-session-dao.js");
      await appendBinMessageToSession(sessionId, String(fallbackSummary));
      return { reported: true, fallback: true };
    } catch (e) {
      console.warn("[import-batch-coordinator] 追加完成摘要失败:", e?.message || e);
    }
  }
  return { reported: false };
}
