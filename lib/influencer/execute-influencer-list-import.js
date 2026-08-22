import { randomUUID } from "crypto";
import { queryTikTok } from "../db/mysql-tiktok.js";
import { getCampaignById, getCampaignBySessionId } from "../db/campaign-dao.js";
import { allowsInfluencerListImport } from "../campaign/campaign-status.js";
import { createImportTask } from "../db/influencer-import-task-dao.js";
import { readSessionImportFile } from "./session-import-storage.js";
import {
  applyAttachmentExtractionPlan,
  DEFAULT_ATTACHMENT_ROW_RULES,
  mergeImportRows,
  rowsFromTextItems,
} from "./apply-extraction-plan.js";
import { parseInfluencerListXlsx } from "./parse-influencer-list-xlsx.js";
import {
  splitImportRowsByPlatform,
  platformSubtaskBatchId,
  platformLabel,
  IMPORT_PLATFORM_SLUGS,
} from "./import-platform-split.js";

function storageKeyBelongsToSession(storageKey, sessionId) {
  if (!storageKey || !sessionId) return false;
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = String(storageKey);
  return key.startsWith(`${sessionId}/`) || key.startsWith(`${safeSession}/`);
}

async function resolveCampaignIdForSession(campaignId, sessionId) {
  const bySession = await getCampaignBySessionId(sessionId);
  if (!bySession?.id) {
    return {
      ok: false,
      message: "该会话尚未关联已发布的 Campaign，无法导入红人名单。",
    };
  }
  const resolvedId = bySession.id;
  if (campaignId && campaignId !== resolvedId) {
    console.warn(
      `[execute-influencer-list-import] campaignId ${campaignId} 与 session ${sessionId} 不一致，以 session 为准: ${resolvedId}`
    );
  }
  return { ok: true, campaignId: resolvedId };
}

async function loadExistingCandidateKeys(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT LOWER(tiktok_username) AS u
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  return new Set((rows || []).map((r) => String(r.u || "").trim()).filter(Boolean));
}

function formatSkipDetail(parseErrors, skippedInvalid) {
  const lines = [];
  const attachmentErrors = parseErrors.filter((e) => e.source === "attachment").slice(0, 5);
  const textErrors = parseErrors.filter((e) => e.source === "message_text").slice(0, 5);

  if (skippedInvalid.length) {
    lines.push(`- 链接无法识别（已跳过）: ${skippedInvalid.length} 条`);
    for (const s of skippedInvalid.slice(0, 3)) {
      const hint = s.evidence || s.reason || "";
      lines.push(`  · ${hint}`.trim());
    }
  }
  if (attachmentErrors.length) {
    lines.push(`- 附件解析失败: ${parseErrors.filter((e) => e.source === "attachment").length} 行`);
    for (const e of attachmentErrors) {
      lines.push(`  · 第 ${e.row} 行: ${e.reason}`);
    }
  }
  if (textErrors.length) {
    lines.push(`- 正文链接无法识别: ${parseErrors.filter((e) => e.source === "message_text").length} 条`);
    for (const e of textErrors) {
      const ev = e.evidence ? `（${e.evidence}）` : "";
      lines.push(`  · ${e.reason}${ev}`);
    }
  }
  return lines;
}

function buildImportAckSummary({
  fileName,
  mergedValidCount,
  platformCounts,
  skippedUnsupported,
  contactMode,
}) {
  const n = Number(mergedValidCount) || 0;
  const name = String(fileName || "").trim();
  const platformText = platformCounts && platformCounts.length ? `（${platformCounts.join(" · ")}）` : "";
  const unsupportedText =
    Number(skippedUnsupported) > 0
      ? `；另有 ${skippedUnsupported} 条 X/未知平台暂不支持导入，已跳过`
      : "";
  const modeText =
    contactMode === "contact_all"
      ? "；已按【直接联系】模式导入（有邮箱即联系，跳过地区筛选）"
      : "；将按画像分析，只联系符合要求且推荐的红人";
  if (name) {
    return `已收到 ${name}，共识别 ${n} 位红人，正在处理${platformText}${unsupportedText}${modeText}；完成后会和您同步。`;
  }
  return `共识别 ${n} 位红人，正在处理${platformText}${unsupportedText}${modeText}；完成后会和您同步。`;
}

function buildFailureDetail(parseErrors, skippedInvalid, extraReason) {
  const lines = [extraReason || "未能识别任何有效红人，导入已取消。"];
  lines.push(...formatSkipDetail(parseErrors, skippedInvalid));
  return lines.join("\n");
}

/**
 * @param {{
 *   campaignId: string,
 *   sessionId: string,
 *   userMessage?: string,
 *   attachmentPlan?: object | null,
 *   textItems?: Array<object>,
 * }} input
 */
export async function executeInfluencerListImport(input) {
  const sessionId = String(input.sessionId || "").trim();
  let campaignId = String(input.campaignId || "").trim();
  const attachmentPlan = input.attachmentPlan || null;
  const textItems = Array.isArray(input.textItems) ? input.textItems : [];
  const contactMode = ["contact_all", "recommended_only"].includes(input.contactMode)
    ? input.contactMode
    : "recommended_only";
  const forceContact = contactMode === "contact_all";

  if (!sessionId) {
    return { success: false, message: "缺少 sessionId" };
  }

  const resolved = await resolveCampaignIdForSession(campaignId, sessionId);
  if (!resolved.ok) {
    return { success: false, message: resolved.message };
  }
  campaignId = resolved.campaignId;

  if (attachmentPlan?.storageKey && !storageKeyBelongsToSession(attachmentPlan.storageKey, sessionId)) {
    return {
      success: false,
      message: "附件与当前 Campaign 不匹配，请在本 Campaign 对话框重新上传后再发送。",
    };
  }

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return { success: false, message: "Campaign 不存在" };
  }
  if (!allowsInfluencerListImport(campaign.status)) {
    return {
      success: false,
      message:
        campaign.status === "paused"
          ? "Campaign 当前已暂停。请先恢复 campaign（说「恢复 campaign」或「继续 campaign」）后再上传名单。"
          : "Campaign 当前未在运行中，无法导入红人名单。",
    };
  }

  const sources = [];
  let attachmentRows = [];
  let attachmentErrors = [];
  let fileName = null;
  let storageKey = null;

  if (attachmentPlan?.storageKey) {
    const buffer = readSessionImportFile(attachmentPlan.storageKey);
    if (!buffer?.length) {
      return { success: false, message: "附件不存在或已失效，请重新上传。" };
    }
    fileName = attachmentPlan.fileName || "list.xlsx";
    storageKey = attachmentPlan.storageKey;
    sources.push(`附件 ${fileName}`);

    const plansToTry = [
      attachmentPlan,
      {
        ...attachmentPlan,
        headerRow: 1,
        rowRules: DEFAULT_ATTACHMENT_ROW_RULES,
      },
    ];

    let parsed = { rows: [], parseErrors: [] };
    for (const plan of plansToTry) {
      const attempt = applyAttachmentExtractionPlan(buffer, plan, { fileName });
      if (attempt.rows.length > parsed.rows.length) {
        parsed = attempt;
      }
    }

    const autoParsed = parseInfluencerListXlsx(buffer);
    if (autoParsed.rows.length > parsed.rows.length) {
      parsed = {
        rows: autoParsed.rows,
        parseErrors: (autoParsed.parseErrors || []).map((e) => ({
          ...e,
          source: "attachment",
        })),
      };
    }

    attachmentRows = parsed.rows.map((r) => ({ ...r, source: "attachment" }));
    attachmentErrors = parsed.parseErrors || [];
  }

  let textRows = [];
  let textErrors = [];
  const hasAttachmentImport = Boolean(attachmentPlan?.storageKey);
  const textItemsForMerge = hasAttachmentImport ? [] : textItems;
  if (textItemsForMerge.length) {
    sources.push("消息正文");
    const parsedText = rowsFromTextItems(textItemsForMerge, { maxItems: 200 });
    textRows = parsedText.rows;
    textErrors = parsedText.parseErrors;
  }

  const merged = mergeImportRows(attachmentRows, textRows);
  const allParseErrors = [...attachmentErrors, ...textErrors];

  if (!merged.length) {
    return {
      success: false,
      message: buildFailureDetail(allParseErrors, [], "未能识别任何有效红人，导入已取消。"),
      data: { parseErrors: allParseErrors },
    };
  }

  const existing = await loadExistingCandidateKeys(campaignId);
  const toProcess = [];
  let skippedDuplicate = 0;

  for (const row of merged) {
    const handle = String(row.username || "").replace(/^@/, "").trim().toLowerCase();
    if (!handle) continue;
    if (!forceContact && existing.has(handle)) {
      skippedDuplicate += 1;
      continue;
    }
    toProcess.push({
      profileUrl: row.profileUrl,
      username: row.username,
      platform: row.platform,
      platformSlug: row.platformSlug,
      email: row.email || null,
    });
  }

  if (!toProcess.length) {
    return {
      success: false,
      message: buildFailureDetail(
        allParseErrors,
        [],
        `已识别 ${merged.length} 位红人，但均在候选池中，无需重复导入。`
      ),
      data: { mergedCount: merged.length, skippedDuplicate },
    };
  }

  const buckets = splitImportRowsByPlatform(toProcess);
  const supportedBuckets = IMPORT_PLATFORM_SLUGS.map((slug) => [slug, buckets[slug] || []]);
  const supportedRows = supportedBuckets.reduce((n, [, rows]) => n + rows.length, 0);
  const skippedUnsupported = buckets.x.length + buckets.unknown.length;

  if (supportedRows === 0) {
    return {
      success: false,
      message: buildFailureDetail(
        allParseErrors,
        [],
        skippedUnsupported > 0
          ? "名单中仅包含 X 或无法识别的平台，当前不支持导入。"
          : "解析后没有可导入的红人。"
      ),
      data: { mergedCount: merged.length, skippedDuplicate },
    };
  }

  const importBatchId = `IMP-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const taskIds = [];
  const platformCounts = [];
  supportedBuckets.forEach(([slug, rows], index) => {
    if (!rows.length) return;
    platformCounts.push(`${platformLabel(slug)} ${rows.length}`);
    const payload = {
      trigger: "user_list_import",
      importBatchId,
      batchType: "split_platform",
      platform: slug,
      contactMode,
      rows,
      parseErrorSample: allParseErrors.slice(0, 20),
      sources,
    };
    if (contactMode === "contact_all") {
      payload.contactMode = "contact_all";
    }
    const taskId = await createImportTask({
      campaignId,
      sessionId,
      importBatchId: platformSubtaskBatchId(importBatchId, slug),
      batchGroupId: importBatchId,
      platform: slug,
      contactMode,
      priority: 150,
      payload,
      totalRows: rows.length,
      skippedDuplicateCount: index === 0 ? skippedDuplicate : 0,
      parseErrorCount: index === 0 ? allParseErrors.length : 0,
      sourceFileName: fileName,
      sourceFileStorageKey: storageKey,
    });
    if (taskId) taskIds.push(taskId);
  });

  if (!taskIds.length) {
    return { success: false, message: "创建导入任务失败" };
  }
  const taskId = taskIds[0];

  const summary = buildImportAckSummary({
    mergedValidCount: merged.length,
    fileName,
    platformCounts,
    skippedUnsupported,
    contactMode,
  });

  return {
    success: true,
    message: summary,
    data: {
      taskId,
      importBatchId,
      taskIds,
      enqueueCount: supportedRows,
      skippedDuplicate,
      mergedValidCount: merged.length,
      parseErrorCount: allParseErrors.length,
      skippedUnsupported,
      contactMode,
    },
  };
}
