/**
 * Worker：消费 tiktok_influencer_import_task（enrich + 分析 + 写候选池）
 * 任务内按平台分组、顺序执行；并发与搜索共用 PlatformPipelineConfig；导入永远跑全量。
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { getCampaignById } from "../db/campaign-dao.js";
import {
  enrichInfluencerProfiles,
  resolveEnrichPerInfluencerBudgetMs,
  recordQualifiesForCandidatePool,
} from "../tools/influencer-functions/search-and-extract-influencers.js";
import { resolveVideoPublishCountryForInfluencers } from "../tools/influencer-functions/resolve-video-publish-country.js";
import { upsertCandidatesForCampaign } from "../db/campaign-candidates-dao.js";
import { resolveAllowedCountriesFromCampaign } from "./campaign-country-codes.js";
import {
  finishImportTask,
  bumpImportTaskCountryProgress,
} from "../db/influencer-import-task-dao.js";
import {
  PLATFORM_PIPELINE_ORDER,
  normalizePipelinePlatformSlug,
  platformDisplayFromPipelineSlug,
  resolveImportWorkerPlatforms,
  resolvePlatformPipelineConfig,
} from "../scraper/resolve-scraper-mode.js";

function parseJsonOrObject(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function normalizeHandle(username) {
  return String(username || "").replace(/^@/, "").trim().toLowerCase();
}

function slugFromRow(row) {
  if (row?.platformSlug) {
    return normalizePipelinePlatformSlug(row.platformSlug);
  }
  return normalizePipelinePlatformSlug(row?.platform || "TikTok");
}

function buildCompletionSummary({
  fileName,
  analyzedCount,
  recommendedCount,
  contactedCount,
  skippedByPlatform = {},
}) {
  const name = String(fileName || "红人名单").trim() || "红人名单";
  const lines = [
    `${name} 中的红人名单已处理完成。`,
    "",
    `已分析：${Number(analyzedCount) || 0} 位`,
    `推荐：${Number(recommendedCount) || 0} 位`,
    `已联系：${Number(contactedCount) || 0} 位`,
  ];
  const skippedEntries = Object.entries(skippedByPlatform).filter(
    ([, n]) => Number(n) > 0
  );
  if (skippedEntries.length) {
    lines.push("");
    lines.push("本机未处理（平台不在 IMPORT_WORKER_PLATFORMS）：");
    for (const [slug, n] of skippedEntries) {
      lines.push(`- ${platformDisplayFromPipelineSlug(slug)}：${n} 位`);
    }
  }
  lines.push("", "可在执行总览查看详情。");
  return lines.join("\n");
}

function countAnalyzedFromEnriched(enriched) {
  return (enriched || []).filter((x) => {
    if (!x) return false;
    if (typeof x.isRecommended === "boolean") return true;
    if (x.analysisReady || x.profileDataReady) return true;
    if (typeof x.analysis === "string" && x.analysis.trim()) return true;
    if (typeof x.recommendationReason === "string" && x.recommendationReason.trim()) {
      return true;
    }
    if (typeof x.reason === "string" && x.reason.trim()) return true;
    return false;
  }).length;
}

async function countContactedForBatch(campaignId, usernames) {
  const handles = [...new Set(usernames.map(normalizeHandle).filter(Boolean))];
  if (!handles.length) return 0;
  const placeholders = handles.map(() => "?").join(", ");
  const rows = await queryTikTok(
    `
    SELECT COUNT(DISTINCT tiktok_username) AS n
    FROM tiktok_campaign_execution
    WHERE campaign_id = ?
      AND tiktok_username IN (${placeholders})
    `,
    [campaignId, ...handles]
  );
  return rows?.[0]?.n != null ? Number(rows[0].n) || 0 : 0;
}

function videosFromProfileRecord(rec) {
  const pd = rec.profile_data || rec.profileData || null;
  const list = pd?.videos || pd?.userInfo?.videos || [];
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 3)
    .map((v) => ({
      username: rec.username,
      videoUrl: v.videoUrl || v.url || null,
      videoId: v.videoId || v.id || null,
    }))
    .filter((v) => v.videoUrl);
}

function groupRowsByPlatform(rows) {
  /** @type {Record<string, object[]>} */
  const groups = { tiktok: [], instagram: [], youtube: [] };
  for (const row of rows) {
    const slug = slugFromRow(row);
    groups[slug].push({
      username: row.username,
      profileUrl: row.profileUrl,
      platform: platformDisplayFromPipelineSlug(slug),
      platformSlug: slug,
      email: row.email || null,
    });
  }
  return groups;
}

async function applyTiktokCountryFilter(records, allowedCountries, taskId, onStepUpdate) {
  if (!records.length || !allowedCountries?.length) {
    return records;
  }
  const videos = records.flatMap((rec) => videosFromProfileRecord(rec));
  try {
    const countryResult = await resolveVideoPublishCountryForInfluencers({
      influencerRecords: records,
      videos,
      maxCount: records.length,
      allowedCountries,
      importTaskId: taskId,
      taskId: null,
      onStepUpdate,
    });
    if (countryResult?.checked?.length) {
      await bumpImportTaskCountryProgress(taskId, {
        checkedDelta: countryResult.stats?.checked || 0,
        passedDelta: countryResult.stats?.passed || 0,
      });
      return records.map((rec) => {
        const u = normalizeHandle(rec.username);
        const checked = (countryResult.checked || []).find(
          (c) => normalizeHandle(c.username) === u
        );
        if (!checked) return rec;
        return {
          ...rec,
          video_publish_country:
            checked.video_publish_country || rec.video_publish_country,
          enrich_skipped_reason: checked.enrich_skipped_reason || null,
        };
      });
    }
  } catch (countryErr) {
    console.warn(
      `[process-import-task] TikTok 国家采集失败，继续 enrich:`,
      countryErr?.message || countryErr
    );
  }
  return records;
}

/**
 * @param {object} task - DB row with payload object
 * @param {{ onStepUpdate?: Function }} [options]
 */
export async function processInfluencerImportTask(task, options = {}) {
  const taskId = Number(task.id || 0);
  const campaignId = task.campaign_id;
  const payload = task.payload || parseJsonOrObject(task.payload) || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const fileName =
    task.source_file_name ||
    payload.fileName ||
    payload.sourceFileName ||
    null;

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    await finishImportTask(taskId, {
      status: "failed",
      errorMessage: `未找到 campaign ${campaignId}`,
    });
    return { success: false };
  }

  if (!rows.length) {
    await finishImportTask(taskId, {
      status: "succeeded",
      resultSummary: "本批无有效红人，未处理。",
    });
    return { success: true, summary: null, skipSessionNotify: true };
  }

  const { productInfo, campaignInfo, influencerProfile, sessionId } = campaign;
  const allowedCountries = resolveAllowedCountriesFromCampaign(campaignInfo);
  const workerPlatforms = new Set(resolveImportWorkerPlatforms());
  const groups = groupRowsByPlatform(rows);
  const batchUsernames = rows.map((r) => normalizeHandle(r.username)).filter(Boolean);

  const importEnrichBudgetMs = Math.max(
    resolveEnrichPerInfluencerBudgetMs(),
    Number(process.env.IMPORT_TASK_ENRICH_TIMEOUT_MS) || 180000
  );

  /** @type {object[]} */
  const allEnriched = [];
  /** @type {Record<string, number>} */
  const skippedByPlatform = {};

  for (const platformSlug of PLATFORM_PIPELINE_ORDER) {
    const platformRecords = groups[platformSlug] || [];
    if (!platformRecords.length) continue;

    if (!workerPlatforms.has(platformSlug)) {
      skippedByPlatform[platformSlug] = platformRecords.length;
      console.log(
        `[process-import-task] 跳过 ${platformDisplayFromPipelineSlug(platformSlug)} ${platformRecords.length} 人（本机 IMPORT_WORKER_PLATFORMS 未包含）`
      );
      continue;
    }

    const pipeline = resolvePlatformPipelineConfig(platformSlug);
    let recordsForEnrich = platformRecords;

    if (platformSlug === "tiktok") {
      recordsForEnrich = await applyTiktokCountryFilter(
        platformRecords,
        allowedCountries,
        taskId,
        options.onStepUpdate
      );
    }

    console.log(
      `[process-import-task] 平台 ${platformDisplayFromPipelineSlug(platformSlug)}：` +
        `enrich ${recordsForEnrich.length} 人，并发 ${pipeline.enrichConcurrency}（全量，无早停）`
    );

    const enriched = await enrichInfluencerProfiles(recordsForEnrich, {
      onStepUpdate: options.onStepUpdate,
      maxCount: recordsForEnrich.length,
      enrichBatchPolicy: false,
      enrichBatchStopOnZeroMatch: false,
      concurrency: pipeline.enrichConcurrency,
      enrichPlatformOption: platformSlug,
      platform: platformSlug,
      influencerProfile,
      productInfo,
      campaignInfo,
      enableLiveMatch: !!influencerProfile,
      campaignId,
      importTaskId: taskId,
      perInfluencerBudgetMs: importEnrichBudgetMs,
      allowedCountries,
      taskMeta: {
        taskId,
        source: "user_upload",
        importBatchId: payload.importBatchId || task.import_batch_id,
      },
    });

    allEnriched.push(...(enriched || []));
  }

  const analyzedCount = countAnalyzedFromEnriched(allEnriched);
  const recommendedCount = (allEnriched || []).filter(
    (x) => x?.isRecommended === true
  ).length;

  const candidatesToWrite = (allEnriched || []).filter(recordQualifiesForCandidatePool);
  await upsertCandidatesForCampaign(campaignId, candidatesToWrite, {
    taskId,
    source: "user_upload",
    importBatchId: payload.importBatchId || task.import_batch_id,
  });

  const contactedCount = await countContactedForBatch(campaignId, batchUsernames);

  const summary = buildCompletionSummary({
    fileName,
    analyzedCount,
    recommendedCount,
    contactedCount,
    skippedByPlatform,
  });

  await finishImportTask(taskId, { status: "succeeded", resultSummary: summary });

  const sessionIdForNotify =
    String(task.session_id || task.sessionId || "").trim() ||
    String(sessionId || "").trim();
  if (sessionIdForNotify) {
    try {
      const { appendBinMessageToSession } = await import("../db/campaign-session-dao.js");
      await appendBinMessageToSession(sessionIdForNotify, summary);
    } catch (e) {
      console.warn("[process-import-task] 追加会话摘要失败:", e?.message || e);
    }
  }

  return {
    success: true,
    summary,
    recommendedCount,
    analyzedCount,
    contactedCount,
    skippedByPlatform,
  };
}
