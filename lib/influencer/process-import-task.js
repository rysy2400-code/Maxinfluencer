/**
 * Worker：消费 tiktok_influencer_import_task（enrich + 分析 + 写候选池）
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
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

function normalizeHandle(username) {
  return String(username || "").replace(/^@/, "").trim().toLowerCase();
}

function buildCompletionSummary({
  fileName,
  analyzedCount,
  recommendedCount,
  contactedCount,
}) {
  const name = String(fileName || "红人名单").trim() || "红人名单";
  return [
    `${name} 中的红人名单已处理完成。`,
    "",
    `已分析：${Number(analyzedCount) || 0} 位`,
    `推荐：${Number(recommendedCount) || 0} 位`,
    `已联系：${Number(contactedCount) || 0} 位`,
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

  const allowedCountries = resolveAllowedCountriesFromCampaign(campaignInfo);
  const influencerRecords = rows.map((r) => ({
    username: r.username,
    profileUrl: r.profileUrl,
    platform: r.platform || "TikTok",
    email: r.email || null,
  }));
  const batchUsernames = influencerRecords
    .map((r) => normalizeHandle(r.username))
    .filter(Boolean);

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
        recordsForEnrich = influencerRecords.map((rec) => {
          const u = normalizeHandle(rec.username);
          const checked = (countryResult.checked || []).find(
            (c) => normalizeHandle(c.username) === u
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

  const analyzedCount = countAnalyzedFromEnriched(enriched);
  const recommendedCount = (enriched || []).filter((x) => x?.isRecommended === true).length;

  await upsertCandidatesForCampaign(campaignId, enriched || [], {
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
  };
}
