/**
 * Worker：消费 tiktok_influencer_import_task（enrich + 分析 + 写候选池）
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { getCampaignById } from "../db/campaign-dao.js";
import {
  enrichInfluencerProfiles,
  resolveEnrichPerInfluencerBudgetMs,
  recordQualifiesForCandidatePool,
} from "../tools/influencer-functions/search-and-extract-influencers.js";
import { resolveVideoPublishCountryForInfluencers } from "../tools/influencer-functions/resolve-video-publish-country.js";
import { resolveImportTiktokFirstVideos } from "../tools/influencer-functions/tiktok/resolve-import-tiktok-first-videos.js";
import {
  upsertCandidatesForCampaign,
  resolveCandidateEmail,
} from "../db/campaign-candidates-dao.js";
import {
  applyContactExclusions,
  formatExclusionImportSummary,
  isHandleExcluded,
  loadCampaignDoNotContactSet,
  loadGlobalContactExclusionMaps,
  normalizeExclusionHandle,
} from "../db/contact-exclusion-dao.js";
import { resolveAllowedCountriesFromCampaign } from "./campaign-country-codes.js";
import {
  finishImportTask,
} from "../db/influencer-import-task-dao.js";
import { normalizePlatformSlugInput } from "./parse-profile-url.js";
import {
  isLiteScraperMode,
  resolveLiteEnrichConcurrency,
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

function isTiktokRecord(rec) {
  return String(rec?.platform || "").toLowerCase() === "tiktok";
}

function hasEmailForContact(inf) {
  return Boolean(inf && resolveCandidateEmail(inf));
}

function buildCompletionSummary({
  fileName,
  analyzedCount,
  recommendedCount,
  contactedCount,
  willContactCount,
  contactAll,
  excludedCount = 0,
}) {
  const name = String(fileName || "红人名单").trim() || "红人名单";
  const modeNote = contactAll ? "（模式：联系符合campaign投放地区的所有红人）" : "";
  const contactLine = contactAll
    ? `将联系：${Number(willContactCount) || 0} 位（符合投放地区且有邮箱，已置为待联系，按每天节奏联系）`
    : `已联系：${Number(contactedCount) || 0} 位`;
  return [
    `${name} 中的红人名单已处理完成${modeNote}。`,
    "",
    `已分析：${Number(analyzedCount) || 0} 位`,
    `推荐：${Number(recommendedCount) || 0} 位`,
    contactLine,
    ...(Number(excludedCount) > 0
      ? [`命中不联系名单跳过：${Number(excludedCount)} 位（不分析、不联系）`]
      : []),
    "",
    "可在执行总览查看详情。",
  ].join("\n");
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

function buildVideosForCountryCheck(records) {
  return (records || [])
    .filter((r) => r.representativeVideoId)
    .map((r) => ({
      username: r.username,
      videoId: r.representativeVideoId,
      videoUrl: r.representativeVideoUrl || null,
    }));
}

function tiktokRecordsWithRepresentativeVideo(records) {
  return (records || []).filter(
    (r) =>
      r.representativeVideoId &&
      r.enrich_skipped_reason !== "no_representative_video"
  );
}

/**
 * Lite TikTok 导入三阶段：首视频 → 国家预筛 → enrich+LLM
 * @param {object[]} tiktokRecords
 * @param {object[]} nonTiktokRecords
 * @param {string[]} allowedCountries
 * @param {number} taskId
 * @param {{ onStepUpdate?: Function }} options
 * @returns {Promise<object[]>}
 */
async function resolveLiteTiktokImportRecordsForEnrich(
  tiktokRecords,
  nonTiktokRecords,
  allowedCountries,
  taskId,
  options
) {
  let tiktokPrepared = tiktokRecords;

  try {
    const firstVideoResult = await resolveImportTiktokFirstVideos({
      influencerRecords: tiktokRecords,
      importTaskId: taskId,
      onStepUpdate: options.onStepUpdate,
    });
    tiktokPrepared = firstVideoResult.records?.length
      ? firstVideoResult.records
      : tiktokRecords;
  } catch (phase1Err) {
    console.warn(
      "[process-import-task] Lite 首视频拉取失败，跳过本批 TikTok enrich:",
      phase1Err?.message || phase1Err
    );
    return [...nonTiktokRecords];
  }

  const tiktokWithVideo = tiktokRecordsWithRepresentativeVideo(tiktokPrepared);
  let tiktokForEnrich = tiktokWithVideo;

  if (allowedCountries?.length) {
    const videos = buildVideosForCountryCheck(tiktokWithVideo);
    try {
      const countryResult = await resolveVideoPublishCountryForInfluencers({
        influencerRecords: tiktokWithVideo,
        videos,
        maxCount: tiktokWithVideo.length,
        allowedCountries,
        importTaskId: taskId,
        taskId: null,
        onStepUpdate: options.onStepUpdate,
      });
      tiktokForEnrich = countryResult?.passed || [];
      console.log(
        `[process-import-task] Lite 国家预筛: 检查 ${countryResult?.stats?.checked ?? 0}，` +
          `通过 ${countryResult?.stats?.passed ?? 0}，` +
          `unknown ${countryResult?.stats?.unknown ?? 0}，` +
          `mismatch ${countryResult?.stats?.mismatch ?? 0}`
      );
    } catch (countryErr) {
      console.warn(
        "[process-import-task] Lite 国家采集失败，跳过本批 TikTok enrich:",
        countryErr?.message || countryErr
      );
      tiktokForEnrich = [];
    }
  }

  return [...nonTiktokRecords, ...tiktokForEnrich];
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

  const {
    productInfo,
    campaignInfo,
    influencerProfile,
    sessionId,
  } = campaign;

  const contactMode =
    String(task.contact_mode || task.contactMode || payload.contactMode || "").trim() ||
    "recommended_only";

  // 「仅排重/不联系」模式：纯写库快路径，不 enrich、不分析、不调浏览器
  if (contactMode === "do_not_contact") {
    const exclusionResult = await applyContactExclusions({
      campaignId,
      rows,
      batchId: payload.importBatchId || task.import_batch_id || null,
      sourceFile: fileName,
    });
    const summary = formatExclusionImportSummary(exclusionResult);
    await finishImportTask(taskId, {
      status: "succeeded",
      resultSummary: summary,
    });
    return { success: true, summary, data: exclusionResult };
  }

  // 两种模式都按 campaign 投放地区筛选：
  // - recommended_only：符合投放地区 + 红人画像且推荐
  // - contact_all：符合投放地区的红人一律联系（不按画像/推荐过滤）
  const allowedCountries = resolveAllowedCountriesFromCampaign(campaignInfo);
  let influencerRecords = rows.map((r) => ({
    username: r.username,
    profileUrl: r.profileUrl,
    platform: r.platform || "TikTok",
    email: r.email || null,
  }));
  const batchUsernames = influencerRecords
    .map((r) => normalizeHandle(r.username))
    .filter(Boolean);

  // 命中不联系名单（全局或本 campaign do_not_contact）的红人：不分析、不联系
  let exclusionSkippedCount = 0;
  try {
    const exclusionMaps = await loadGlobalContactExclusionMaps();
    const campaignDnc = await loadCampaignDoNotContactSet(campaignId);
    const kept = [];
    const dropped = [];
    for (const rec of influencerRecords) {
      const slug = normalizePlatformSlugInput(rec.platform || rec.platformSlug);
      const h = normalizeExclusionHandle(rec.username);
      if (campaignDnc.has(h) || isHandleExcluded(exclusionMaps, slug, h)) {
        dropped.push(rec);
      } else {
        kept.push(rec);
      }
    }
    exclusionSkippedCount = dropped.length;
    influencerRecords = kept;
  } catch (exclusionErr) {
    console.warn(
      "[process-import-task] 加载不联系名单失败，本次导入不按名单过滤:",
      exclusionErr?.message || exclusionErr
    );
  }

  const tiktokRecords = influencerRecords.filter(isTiktokRecord);
  const nonTiktokRecords = influencerRecords.filter((r) => !isTiktokRecord(r));
  let recordsForEnrich = influencerRecords;
  const liteMode = isLiteScraperMode();

  if (tiktokRecords.length > 0 && liteMode) {
    recordsForEnrich = await resolveLiteTiktokImportRecordsForEnrich(
      tiktokRecords,
      nonTiktokRecords,
      allowedCountries,
      taskId,
      options
    );
  } else if (tiktokRecords.length > 0 && allowedCountries?.length) {
    const videos = tiktokRecords.flatMap((rec) => videosFromProfileRecord(rec));
    try {
      const countryResult = await resolveVideoPublishCountryForInfluencers({
        influencerRecords: tiktokRecords,
        videos,
        maxCount: tiktokRecords.length,
        allowedCountries,
        importTaskId: taskId,
        taskId: null,
        onStepUpdate: options.onStepUpdate,
      });
      if (countryResult?.passed?.length) {
        const passedHandles = new Set(
          countryResult.passed.map((c) => normalizeHandle(c.username))
        );
        recordsForEnrich = influencerRecords.filter((rec) => {
          if (!isTiktokRecord(rec)) return true;
          return passedHandles.has(normalizeHandle(rec.username));
        });
      } else if (countryResult?.checked?.length) {
        recordsForEnrich = nonTiktokRecords;
      }
    } catch (countryErr) {
      console.warn(
        "[process-import-task] 国家采集失败，跳过 TikTok enrich:",
        countryErr?.message || countryErr
      );
      recordsForEnrich = nonTiktokRecords;
    }
  }

  const importEnrichBudgetMs = Math.max(
    resolveEnrichPerInfluencerBudgetMs(),
    Number(process.env.IMPORT_TASK_ENRICH_TIMEOUT_MS) || 180000
  );

  const hasLiteTiktokEnrich =
    liteMode && recordsForEnrich.some(isTiktokRecord);
  const enrichConcurrency = hasLiteTiktokEnrich
    ? resolveLiteEnrichConcurrency("tiktok")
    : 1;

  const enriched = await enrichInfluencerProfiles(recordsForEnrich, {
    onStepUpdate: options.onStepUpdate,
    maxCount: recordsForEnrich.length,
    enrichBatchPolicy: false,
    enrichBatchStopOnZeroMatch: false,
    concurrency: enrichConcurrency,
    platform: hasLiteTiktokEnrich ? "tiktok" : undefined,
    influencerProfile,
    productInfo,
    campaignInfo,
    enableLiveMatch: !!influencerProfile,
    campaignId,
    importTaskId: taskId,
    perInfluencerBudgetMs: importEnrichBudgetMs,
    enrichExistingCandidates: contactMode === "contact_all",
    taskMeta: {
      taskId,
      source: "user_upload",
      importBatchId: payload.importBatchId || task.import_batch_id,
    },
    allowedCountries,
  });

  // 已分析数按「真正完成分析并写入候选池」的口径统计，需先于 contact_all
  // 覆盖计算，避免把未通过地区/画像筛选的红人误计为已分析。
  const analyzedCount = countAnalyzedFromEnriched(enriched);

  if (contactMode === "contact_all") {
    for (const item of enriched || []) {
      if (item && resolveCandidateEmail(item)) {
        item.isRecommended = true;
      }
    }
  }

  const candidatesToWrite = (enriched || []).filter(recordQualifiesForCandidatePool);
  const willContactNewCount =
    contactMode === "contact_all"
      ? (candidatesToWrite || []).filter(hasEmailForContact).length
      : 0;
  const recommendedCount =
    contactMode === "contact_all"
      ? willContactNewCount
      : (enriched || []).filter((x) => x?.isRecommended === true).length;
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
    willContactCount: willContactNewCount,
    contactAll: contactMode === "contact_all",
    excludedCount: exclusionSkippedCount,
  });

  await finishImportTask(taskId, { status: "succeeded", resultSummary: summary });

  return {
    success: true,
    summary,
    recommendedCount,
    analyzedCount,
    contactedCount,
  };
}
