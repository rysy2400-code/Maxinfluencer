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

  flipShouldContactForExistingCampaignCandidates,
  setShouldContactForCampaignCandidates,

} from "../db/campaign-candidates-dao.js";
import { resolveAllowedCountriesFromCampaign } from "./campaign-country-codes.js";
import {
  finishImportTask,
} from "../db/influencer-import-task-dao.js";
import { notifyImportBatchOrSession } from "./import-batch-coordinator.js";
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

function buildCompletionSummary({
  fileName,
  analyzedCount,
  recommendedCount,
  contactedCount,

  willContactCount,
  contactAll,
}) {
  const name = String(fileName || "红人名单").trim() || "红人名单";
  const contactLine = contactAll
    ? `将联系：${Number(willContactCount) || 0} 位（符合投放地区且有邮箱，已置为待联系，按每天节奏联系）`
    : `已联系：${Number(contactedCount) || 0} 位`;

  return [
    `${name} 中的红人名单已处理完成${modeNote}。`,
    "",
    `已分析：${Number(analyzedCount) || 0} 位`,
    `推荐：${Number(recommendedCount) || 0} 位`,
    contactLine,
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
 * Lite TikTok 导入（bio 门禁版）：user/detail 拉 bio → bio 语言匹配投放地区 →
 * 通过者直接 enrich（近50条视频 + LLM 异步），并复用 pregateUserInfo 省掉重复 user/detail。
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
  let tiktokForEnrich = [];
  try {
    const { resolveImportTiktokBioGate } = await import(
      "../tools/influencer-functions/tiktok/resolve-import-tiktok-bio-gate.js"
    );
    const bioResult = await resolveImportTiktokBioGate({
      influencerRecords: tiktokRecords,
      allowedCountries,
      importTaskId: taskId,
      onStepUpdate: options.onStepUpdate,
    });
    tiktokForEnrich = bioResult.records || [];
    console.log(
      `[process-import-task] Lite bio 门禁: 检查 ${bioResult.stats.total}，` +
        `通过 ${bioResult.stats.passed}，` +
        `跳过 ${bioResult.stats.skipped}（mismatch ${bioResult.stats.mismatch}，unknown ${bioResult.stats.unknown}，detail失败 ${bioResult.stats.failed}）`
    );
  } catch (phase1Err) {
    console.warn(
      "[process-import-task] Lite bio 门禁失败，跳过本批 TikTok enrich:",
      phase1Err?.message || phase1Err
    );
    return [...nonTiktokRecords];
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
    await notifyImportBatchOrSession({ task, fallbackSummary: null }).catch((e) =>
      console.warn("[process-import-task] 批次汇报失败:", e?.message || e)
    );
    return { success: false };
  }

  if (!rows.length) {
    await finishImportTask(taskId, {
      status: "succeeded",
      resultSummary: "本批无有效红人，未处理。",
    });
    await notifyImportBatchOrSession({ task, fallbackSummary: null }).catch((e) =>
      console.warn("[process-import-task] 批次汇报失败:", e?.message || e)
    );
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
  // 直接联系模式：用户指定名单，跳过 campaign 地区过滤
  const allowedCountries =
    contactMode === "contact_all"
      ? []
      : resolveAllowedCountriesFromCampaign(campaignInfo);
  const influencerRecords = rows.map((r) => ({
    username: r.username,
    profileUrl: r.profileUrl,
    platform: r.platform || "TikTok",
    email: r.email || null,
  }));
  const batchUsernames = influencerRecords
    .map((r) => normalizeHandle(r.username))
    .filter(Boolean);

  const tiktokRecords0 = influencerRecords.filter(isTiktokRecord);
  const nonTiktokRecords = influencerRecords.filter((r) => !isTiktokRecord(r));
  let tiktokRecords = tiktokRecords0;
  let recordsForEnrich = influencerRecords;
  const liteMode = isLiteScraperMode();
  const contactAll = String(payload.contactMode || "").trim() === "contact_all";
  let flippedContactCount = 0;
  console.log(
    `[process-import-task] task=${taskId} start rows=${rows.length} contactAll=${contactAll}`
  );

  // contact_all：已存在候选「有邮箱且未联系」直接翻为联系（不动推荐/分析），
  // 已联系/无邮箱/已有执行行 → 跳过不重复处理；新红人走下方全链路。
  if (contactAll && tiktokRecords.length > 0) {
    const handles = [
      ...new Set(
        tiktokRecords
          .map((r) => normalizeHandle(r.username))
          .filter(Boolean)
      ),
    ];
    if (handles.length > 0) {
      const placeholders = handles.map(() => "?").join(", ");
      const existingRows = await queryTikTok(
        `SELECT LOWER(tiktok_username) AS u, has_email, should_contact
         FROM tiktok_campaign_influencer_candidates
         WHERE campaign_id = ? AND LOWER(tiktok_username) IN (${placeholders})`,
        [campaignId, ...handles]
      );
      const existing = new Map(
        (existingRows || []).map((r) => [String(r.u || ""), r])
      );
      const flipHandles = [];
      const remaining = [];
      for (const rec of tiktokRecords) {
        const u = normalizeHandle(rec.username);
        const row = existing.get(u);
        if (!row) {
          remaining.push(rec);
          continue;
        }
        if (Number(row.has_email) === 1 && Number(row.should_contact) === 0) {
          flipHandles.push(u);
        }
        // 其余（should_contact=1 或 无邮箱）→ 跳过不重复处理
      }
      if (flipHandles.length > 0) {
        const flipResult =
          await flipShouldContactForExistingCampaignCandidates(
            campaignId,
            flipHandles
          );
        flippedContactCount = Number(flipResult.flipped || 0);
        console.log(
          `[process-import-task] contact_all 已存在候选翻联系: flipped=${flipResult.flipped} candidates=${flipResult.candidates}`
        );
      }
      tiktokRecords = remaining;
    }
  }
  console.log(
    `[process-import-task] task=${taskId} after-contact-all tiktokRecords=${tiktokRecords.length} flipped=${flippedContactCount}`
  );

  // contact_all 已处理（翻联系/跳过）的 tiktok 红人不再进入 enrich 链路
  if (contactAll) {
    const keep = new Set(
      tiktokRecords.map((r) => normalizeHandle(r.username)).filter(Boolean)
    );
    recordsForEnrich = influencerRecords.filter(
      (r) => !isTiktokRecord(r) || keep.has(normalizeHandle(r.username))
    );
  }

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

  console.log(
    `[process-import-task] task=${taskId} enrich start records=${recordsForEnrich.length}`
  );
  const enriched = await enrichInfluencerProfiles(recordsForEnrich, {
    onStepUpdate: options.onStepUpdate,
    maxCount: recordsForEnrich.length,
    enrichBatchPolicy: false,
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
  console.log(
    `[process-import-task] task=${taskId} enrich done enriched=${(enriched || []).length}`
  );

  if (contactMode === "contact_all") {
    for (const item of enriched || []) {
      if (item && resolveCandidateEmail(item)) {
        item.isRecommended = true;
      }
    }
  }

  const analyzedCount = countAnalyzedFromEnriched(enriched);
  const recommendedCount = (enriched || []).filter((x) => x?.isRecommended === true).length;

  const candidatesToWrite = (enriched || []).filter(recordQualifiesForCandidatePool);
  const willContactNewCount = contactAll
    ? (candidatesToWrite || []).filter((inf) => {
        const email = String(
          inf?.email ||
            inf?.profile_data?.userInfo?.email ||
            inf?.profileData?.userInfo?.email ||
            ""
        ).trim();
        return email.includes("@");
      }).length
    : 0;
  await upsertCandidatesForCampaign(campaignId, candidatesToWrite, {
    taskId,
    source: "user_upload",
    importBatchId: payload.importBatchId || task.import_batch_id,
    contactAllEmailOnly: contactAll,
  });
  // enrich 阶段会先按 isRecommended 写入候选行（ON DUPLICATE 不覆盖 should_contact），
  // contact_all 下全链路后强制把有邮箱的候选置为联系。
  if (contactAll) {
    const contactHandles = (candidatesToWrite || [])
      .filter((inf) => {
        const email = String(
          inf?.email ||
            inf?.profile_data?.userInfo?.email ||
            inf?.profileData?.userInfo?.email ||
            ""
        ).trim();
        return email.includes("@");
      })
      .map((inf) => normalizeHandle(inf.username))
      .filter(Boolean);
    if (contactHandles.length > 0) {
      const forced = await setShouldContactForCampaignCandidates(
        campaignId,
        contactHandles,
        1
      );
      console.log(
        `[process-import-task] contact_all 全链路后强制联系: updated=${forced.updated}`
      );
    }
  }

  const contactedCount = await countContactedForBatch(campaignId, batchUsernames);

  const summary = buildCompletionSummary({
    fileName,
    analyzedCount,
    recommendedCount,
    contactedCount,

    willContactCount: flippedContactCount + willContactNewCount,
    contactAll,

  });

  console.log(`[process-import-task] task=${taskId} finishing`);
  await finishImportTask(taskId, { status: "succeeded", resultSummary: summary });
  console.log(`[process-import-task] task=${taskId} done`);

  const sessionIdForNotify =
    String(task.session_id || task.sessionId || "").trim() ||
    String(sessionId || "").trim();
  await notifyImportBatchOrSession({
    task: {
      ...task,
      campaign_id: campaignId,
      session_id: sessionIdForNotify,
    },
    fallbackSummary: summary,
  }).catch((e) => {
    console.warn("[process-import-task] 追加会话摘要失败:", e?.message || e);
  });

  return {
    success: true,
    summary,
    recommendedCount,
    analyzedCount,
    contactedCount,
  };
}
