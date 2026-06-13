/**
 * Worker：消费 tiktok_influencer_import_task（enrich + 分析 + 写候选池）
 */
import { getCampaignById } from "../db/campaign-dao.js";
import { enrichInfluencerProfiles } from "../tools/influencer-functions/search-and-extract-influencers.js";
import { resolveVideoPublishCountryForInfluencers } from "../tools/influencer-functions/resolve-video-publish-country.js";
import { upsertCandidatesForCampaign } from "../db/campaign-candidates-dao.js";
import { resolveAllowedCountriesFromCampaign } from "./campaign-country-codes.js";
import {
  finishImportTask,
  bumpImportTaskCountryProgress,
} from "../db/influencer-import-task-dao.js";

function parseJsonOrObject(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function buildSummary({
  enrichedCount,
  analyzedCount,
  recommendedCount,
  insertedCount,
  skippedDuplicate,
  parseErrorCount,
}) {
  return [
    "红人名单处理完成。",
    `- enrich 成功: ${enrichedCount}`,
    `- 完成分析: ${analyzedCount}`,
    `- 推荐联系: ${recommendedCount}`,
    `- 新写入候选池: ${insertedCount}`,
    `- 上传时已在候选池跳过: ${skippedDuplicate}`,
    parseErrorCount > 0 ? `- Excel 解析失败行: ${parseErrorCount}` : null,
    "推荐且有邮箱的红人已按每天联系节奏排队；可在执行总览「已分析」「已联系」查看。",
  ]
    .filter(Boolean)
    .join("\n");
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

/**
 * @param {object} task - DB row with payload object
 * @param {{ onStepUpdate?: Function }} [options]
 */
export async function processInfluencerImportTask(task, options = {}) {
  const taskId = Number(task.id || 0);
  const campaignId = task.campaign_id;
  const payload = task.payload || parseJsonOrObject(task.payload) || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    await finishImportTask(taskId, {
      status: "failed",
      errorMessage: `未找到 campaign ${campaignId}`,
    });
    return { success: false };
  }

  if (!rows.length) {
    const summary = buildSummary({
      enrichedCount: 0,
      analyzedCount: 0,
      recommendedCount: 0,
      insertedCount: 0,
      skippedDuplicate: Number(task.skipped_duplicate_count || 0),
      parseErrorCount: Number(task.parse_error_count || 0),
    });
    await finishImportTask(taskId, { status: "succeeded", resultSummary: summary });
    return { success: true, summary };
  }

  const {
    productInfo,
    campaignInfo,
    influencerProfile,
    sessionId,
  } = campaign;

  const allowedCountries = resolveAllowedCountriesFromCampaign(campaignInfo);
  const influencerRecords = rows.map((r) => ({
    username: r.username,
    profileUrl: r.profileUrl,
    platform: r.platform || "TikTok",
    email: r.email || null,
  }));

  const tiktokRecords = influencerRecords.filter(
    (r) => String(r.platform || "").toLowerCase() === "tiktok"
  );
  let recordsForEnrich = influencerRecords;

  if (tiktokRecords.length > 0 && allowedCountries?.length) {
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
      if (countryResult?.checked?.length) {
        const passedSet = new Set(
          (countryResult.passed || []).map((r) =>
            String(r.username || "").replace(/^@/, "").toLowerCase()
          )
        );
        recordsForEnrich = influencerRecords.map((rec) => {
          const u = String(rec.username || "").replace(/^@/, "").toLowerCase();
          const checked = (countryResult.checked || []).find(
            (c) => String(c.username || "").replace(/^@/, "").toLowerCase() === u
          );
          if (!checked) return rec;
          return {
            ...rec,
            video_publish_country: checked.video_publish_country || rec.video_publish_country,
          };
        });
        await bumpImportTaskCountryProgress(taskId, {
          checkedDelta: countryResult.stats?.checked || 0,
          passedDelta: countryResult.stats?.passed || 0,
        });
      }
    } catch (countryErr) {
      console.warn(
        `[process-import-task] 国家采集失败，继续 enrich:`,
        countryErr?.message || countryErr
      );
    }
  }

  const enriched = await enrichInfluencerProfiles(recordsForEnrich, {
    onStepUpdate: options.onStepUpdate,
    maxCount: recordsForEnrich.length,
    enrichBatchPolicy: false,
    concurrency: 1,
    influencerProfile,
    productInfo,
    campaignInfo,
    enableLiveMatch: !!influencerProfile,
    campaignId,
    importTaskId: taskId,
    taskMeta: {
      taskId,
      source: "user_upload",
      importBatchId: payload.importBatchId || task.import_batch_id,
    },
    allowedCountries,
  });

  const analyzed = (enriched || []).filter(
    (x) => x && typeof x.isRecommended === "boolean"
  );
  const recommended = analyzed.filter((x) => x.isRecommended);
  const enrichedOk = (enriched || []).filter(
    (x) =>
      x &&
      (x.profileDataReady ||
        x.analysisReady ||
        (typeof x.analysis === "string" && x.analysis.trim()))
  );

  const { inserted } = await upsertCandidatesForCampaign(campaignId, enriched || [], {
    taskId,
    source: "user_upload",
    importBatchId: payload.importBatchId || task.import_batch_id,
  });

  const summary = buildSummary({
    enrichedCount: enrichedOk.length,
    analyzedCount: analyzed.length,
    recommendedCount: recommended.length,
    insertedCount: inserted,
    skippedDuplicate: Number(task.skipped_duplicate_count || 0),
    parseErrorCount: Number(task.parse_error_count || 0),
  });

  await finishImportTask(taskId, { status: "succeeded", resultSummary: summary });

  if (sessionId) {
    try {
      const { appendBinMessageToSession } = await import("../db/campaign-session-dao.js");
      await appendBinMessageToSession(sessionId, summary);
    } catch (e) {
      console.warn("[process-import-task] 追加会话摘要失败:", e?.message || e);
    }
  }

  return {
    success: true,
    summary,
    inserted,
    recommendedCount: recommended.length,
  };
}
