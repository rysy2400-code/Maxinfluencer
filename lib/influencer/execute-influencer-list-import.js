import { randomUUID } from "crypto";
import { queryTikTok } from "../db/mysql-tiktok.js";
import { getCampaignById } from "../db/campaign-dao.js";
import { createImportTask } from "../db/influencer-import-task-dao.js";
import { readSessionImportFile } from "./session-import-storage.js";
import {
  applyAttachmentExtractionPlan,
  mergeImportRows,
  rowsFromTextItems,
} from "./apply-extraction-plan.js";

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

function buildImportSummary({
  sources,
  enqueueCount,
  skippedDuplicate,
  parseErrors,
  mergedValidCount,
  fileName,
}) {
  const sourceDesc = sources.length ? sources.join(" + ") : "消息";
  const lines = [
    `已收到红人名单（${sourceDesc}），正在后台 enrich 与分析。`,
    `- 识别有效红人（去重后）: ${mergedValidCount}`,
    `- 本批进入处理队列: ${enqueueCount}`,
    `- 已在候选池跳过（不重复分析）: ${skippedDuplicate}`,
  ];
  const skipLines = formatSkipDetail(parseErrors, []);
  if (skipLines.length) {
    lines.push(...skipLines);
  }
  if (fileName) {
    lines.unshift(`附件：${fileName}`);
  }
  lines.push(
    "分析完成后，推荐且有邮箱的红人将按每天联系节奏进入执行；结果可在执行总览「已分析」「已联系」查看。"
  );
  return lines.join("\n");
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
  const campaignId = String(input.campaignId || "").trim();
  const sessionId = String(input.sessionId || "").trim();
  const attachmentPlan = input.attachmentPlan || null;
  const textItems = Array.isArray(input.textItems) ? input.textItems : [];

  if (!campaignId || !sessionId) {
    return { success: false, message: "缺少 campaignId 或 sessionId" };
  }

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return { success: false, message: "Campaign 不存在" };
  }
  if (campaign.status !== "running") {
    return {
      success: false,
      message:
        "Campaign 当前未在运行中。请先恢复 campaign（说「恢复 campaign」或「继续 campaign」）后再上传名单。",
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
        rowRules: [
          { priority: 1, kind: "profile_url", column: "主页链接" },
          { priority: 2, kind: "username_platform", usernameColumn: "红人用户名", platformColumn: "红人平台" },
          { priority: 3, kind: "username_platform", usernameColumn: "用户名", platformColumn: "平台" },
          { priority: 4, kind: "username_platform", usernameColumn: "handle", platformColumn: "platform" },
        ],
      },
    ];

    let parsed = { rows: [], parseErrors: [] };
    for (const plan of plansToTry) {
      parsed = applyAttachmentExtractionPlan(buffer, plan, { fileName });
      if (parsed.rows.length) break;
    }
    attachmentRows = parsed.rows.map((r) => ({ ...r, source: "attachment" }));
    attachmentErrors = parsed.parseErrors || [];
  }

  let textRows = [];
  let textErrors = [];
  if (textItems.length) {
    sources.push("消息正文");
    const parsedText = rowsFromTextItems(textItems, { maxItems: 200 });
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
    if (existing.has(handle)) {
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

  const importBatchId = `IMP-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payload = {
    trigger: "user_list_import",
    importBatchId,
    rows: toProcess,
    parseErrorSample: allParseErrors.slice(0, 20),
    sources,
  };

  const taskId = await createImportTask({
    campaignId,
    sessionId,
    importBatchId,
    platform: "mixed",
    priority: 150,
    payload,
    totalRows: merged.length,
    skippedDuplicateCount: skippedDuplicate,
    parseErrorCount: allParseErrors.length,
    sourceFileName: fileName,
    sourceFileStorageKey: storageKey,
  });

  if (!taskId) {
    return { success: false, message: "创建导入任务失败" };
  }

  const summary = buildImportSummary({
    sources,
    enqueueCount: toProcess.length,
    skippedDuplicate,
    parseErrors: allParseErrors,
    mergedValidCount: merged.length,
    fileName,
  });

  return {
    success: true,
    message: summary,
    data: {
      taskId,
      importBatchId,
      enqueueCount: toProcess.length,
      skippedDuplicate,
      mergedValidCount: merged.length,
      parseErrorCount: allParseErrors.length,
    },
  };
}
