import { randomUUID } from "crypto";
import { queryTikTok } from "../db/mysql-tiktok.js";
import { getCampaignById } from "../db/campaign-dao.js";
import { createImportTask } from "../db/influencer-import-task-dao.js";
import {
  updateCampaignSession,
  getCampaignSessionById,
} from "../db/campaign-session-dao.js";
import { normalizeSessionMessagesForStorage } from "../chat/session-messages.js";
import { parseInfluencerListXlsx } from "./parse-influencer-list-xlsx.js";
import { saveSessionImportFile } from "./session-import-storage.js";

async function loadExistingCandidateKeys(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT LOWER(tiktok_username) AS u, source
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  return new Set((rows || []).map((r) => String(r.u || "").trim()).filter(Boolean));
}

function buildImportSummary({
  enqueueCount,
  skippedDuplicate,
  parseErrors,
  totalRawRows,
  parseValidCount,
  fileName,
}) {
  const lines = [
    `已收到红人名单「${fileName}」，正在后台 enrich 与分析。`,
    `- Excel 有效行（去重后）: ${parseValidCount}`,
    `- 本批进入处理队列: ${enqueueCount}`,
    `- 已在候选池跳过（不重复分析）: ${skippedDuplicate}`,
  ];
  if (parseErrors.length > 0) {
    lines.push(`- 解析失败: ${parseErrors.length} 行`);
    const sample = parseErrors.slice(0, 5);
    for (const e of sample) {
      lines.push(`  · 第 ${e.row} 行: ${e.reason}`);
    }
    if (parseErrors.length > 5) {
      lines.push(`  · …另有 ${parseErrors.length - 5} 行`);
    }
  }
  lines.push(
    "分析完成后，推荐且有邮箱的红人将按每天联系节奏进入执行；结果可在执行总览「已分析」「已联系」查看。"
  );
  return lines.join("\n");
}

/**
 * @param {{
 *   campaignId: string,
 *   sessionId: string,
 *   fileBuffer: Buffer,
 *   fileName: string,
 *   userMessage?: string,
 * }} input
 */
export async function submitInfluencerListImport(input) {
  const campaignId = String(input.campaignId || "").trim();
  const sessionId = String(input.sessionId || "").trim();
  const fileName = String(input.fileName || "list.xlsx").trim();
  const fileBuffer = input.fileBuffer;

  if (!campaignId || !sessionId || !fileBuffer?.length) {
    return { success: false, error: "缺少 campaignId、sessionId 或文件内容" };
  }

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return { success: false, error: "Campaign 不存在" };
  }
  if (campaign.status !== "running") {
    return {
      success: false,
      error:
        "Campaign 当前未在运行中。请先恢复 campaign（说「恢复 campaign」或「继续 campaign」）后再上传名单。",
    };
  }

  const parsed = parseInfluencerListXlsx(fileBuffer);
  if (!parsed.rows.length && parsed.parseErrors.length) {
    return {
      success: false,
      error: parsed.parseErrors[0]?.reason || "无法解析 Excel",
      parseErrors: parsed.parseErrors,
    };
  }

  const existing = await loadExistingCandidateKeys(campaignId);
  const toProcess = [];
  let skippedDuplicate = 0;

  for (const row of parsed.rows) {
    const handle = String(row.username || "").replace(/^@/, "").trim().toLowerCase();
    if (!handle) continue;
    if (existing.has(handle)) {
      skippedDuplicate += 1;
      continue;
    }
    toProcess.push(row);
  }

  const importBatchId = `IMP-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const { storageKey } = saveSessionImportFile(
    sessionId,
    importBatchId,
    fileBuffer,
    fileName
  );

  const payload = {
    trigger: "user_list_import",
    importBatchId,
    rows: toProcess,
    parseErrorSample: parsed.parseErrors.slice(0, 20),
  };

  const taskId = await createImportTask({
    campaignId,
    sessionId,
    importBatchId,
    platform: "mixed",
    priority: 150,
    payload,
    totalRows: parsed.rows.length,
    skippedDuplicateCount: skippedDuplicate,
    parseErrorCount: parsed.parseErrors.length,
    sourceFileName: fileName,
    sourceFileStorageKey: storageKey,
  });

  if (!taskId) {
    return { success: false, error: "创建导入任务失败" };
  }

  const summary = buildImportSummary({
    enqueueCount: toProcess.length,
    skippedDuplicate,
    parseErrors: parsed.parseErrors,
    totalRawRows: parsed.totalRawRows,
    parseValidCount: parsed.rows.length,
    fileName,
  });

  const userText =
    String(input.userMessage || "").trim() ||
    `上传红人名单：${fileName}`;

  const session = await getCampaignSessionById(sessionId);
  const messages = Array.isArray(session?.messages) ? [...session.messages] : [];
  messages.push({
    role: "user",
    content: userText,
    createdAt: new Date().toISOString(),
    attachments: [
      {
        type: "influencer_list_import",
        name: fileName,
        storageKey,
        importBatchId,
        taskId,
      },
    ],
  });
  messages.push({
    role: "assistant",
    name: "Bin",
    content: summary,
    createdAt: new Date().toISOString(),
  });

  await updateCampaignSession(sessionId, {
    messages: normalizeSessionMessagesForStorage(messages),
  });

  return {
    success: true,
    taskId,
    importBatchId,
    summary,
    enqueueCount: toProcess.length,
    skippedDuplicate,
    parseErrorCount: parsed.parseErrors.length,
  };
}
