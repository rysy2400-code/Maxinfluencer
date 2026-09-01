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
  const m = text.match(/(?:已联系|将联系)\s*[：: ]?\s*(\d+)/);
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

  // 纯「仅排重/不联系」批次：不分析、不联系，生效确认已由导入工具在聊天框同步返回，
  // 再追加「已分析 0 · 推荐 0 · 将联系 0」的通用汇总只会造成重复且容易误读，直接跳过。
  const allDoNotContact = list.every(
    (r) => String(r.contact_mode || r.contactMode || "") === "do_not_contact"
  );
  if (allDoNotContact) return "";

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
        `- ${label}（${n} 位）：已分析 ${analyzedN} · 推荐 ${recommendedN} · 将联系 ${contactedN}`
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
    : "（推荐模式：分析后仅推荐且符合投放地区的红人进入待联系）";
  const head = `【名单导入完成】${modeNote}`;

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
 * 兼容导出：worker-influencer-search.js 仍在调用（两处均传 fallbackSummary=null）。
 * 批次任务委托 notifyImportBatchIfComplete（batch_group_reported_at 幂等，不会重复汇报）；
 * 单任务兜底摘要仅在提供 fallbackSummary 时追加（当前 worker 调用不传，走不到）。
 */
export async function notifyImportBatchOrSession({ task = {}, fallbackSummary = null }) {
  const batchGroupId = task?.batch_group_id || task?.batchGroupId || null;
  const campaignId = task?.campaign_id || task?.campaignId || null;
  const sessionId = String(task?.session_id || task?.sessionId || "").trim();

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
