/**
 * 解析 TikTok 视频发布地 locationCreated 写入 DB。
 * Lite 默认在 9223 TikTok 首页上下文 API-only fetch，不打开视频页。
 */

import {
  countryMatchesPublishLocation,
  normalizeAllowedCountries,
} from "../../influencer/campaign-country-codes.js";
import { resolveUnknownCountryBioGate } from "../../influencer/infer-bio-language.js";
import { BROWSER_STEP_IDS } from "../../utils/browser-steps.js";
import {
  saveVideoPublishCountry,
} from "../../db/tiktok-influencer-dao.js";
import {
  touchSearchTaskLastProgressAt,
  bumpSearchTaskCountryProgress,
  bumpSearchTaskSkipCountryProgress,
  appendSearchTaskCountryOutcome,
} from "../../db/campaign-candidates-dao.js";
import {
  touchImportTaskLastProgressAt,
  bumpImportTaskCountryProgress,
} from "../../db/influencer-import-task-dao.js";
import {
  isLiteScraperMode,
  resolveCountryStopOnZeroBatchMatch,
  resolveLiteCdpTabPoolSize,
} from "../../scraper/resolve-scraper-mode.js";

function normalizeUsername(username) {
  return String(username || "").replace(/^@/, "").trim();
}

function resolveDelayBetweenVideos(override) {
  const envMin = Number(process.env.COUNTRY_VIDEO_DELAY_MIN);
  const envMax = Number(process.env.COUNTRY_VIDEO_DELAY_MAX);
  if (Number.isFinite(envMin) && Number.isFinite(envMax) && envMin > 0 && envMax > 0) {
    return { min: envMin, max: envMax };
  }
  return override || { min: 5000, max: 10000 };
}

function randomDelayMs(range) {
  const min = Number(range?.min ?? 5000);
  const max = Number(range?.max ?? 10000);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractVideoId(url) {
  const m = String(url || "").match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function extractUsernameFromVideoUrl(url) {
  const m = String(url || "").match(/tiktok\.com\/@([^/?#]+)\/video\/\d+/i);
  return m ? normalizeUsername(decodeURIComponent(m[1])) : "";
}

/**
 * 按搜索视频出现顺序取前 maxCount 个不重复红人，并绑定代表视频 URL。
 */
export function orderInfluencersForCountryCheck(influencerRecords, videos, maxCount = 20) {
  const byUsername = new Map();
  for (const rec of influencerRecords || []) {
    const u = normalizeUsername(rec.username);
    if (u) byUsername.set(u, rec);
  }

  const ordered = [];
  const seen = new Set();

  for (const video of videos || []) {
    const u = normalizeUsername(video.username);
    if (!u || seen.has(u)) continue;
    const rec = byUsername.get(u);
    if (!rec) continue;

    seen.add(u);
    const videoUrl =
      video.videoUrl ||
      (video.videoId
        ? `https://www.tiktok.com/@${u}/video/${video.videoId}`
        : null);

    ordered.push({
      ...rec,
      username: rec.username || u,
      representativeVideoUrl: videoUrl,
      representativeVideoId: video.videoId || extractVideoId(videoUrl),
    });

    if (ordered.length >= maxCount) break;
  }

  return ordered;
}

export function passesCampaignCountry(videoPublishCountry, allowedCountries) {
  return countryMatchesPublishLocation(
    videoPublishCountry,
    allowedCountries
  );
}

async function reportCountryScreenshot(onStepUpdate, page, username, progress) {
  if (!onStepUpdate || !page || page.isClosed()) return;
  try {
    const screenshot = await Promise.race([
      page.screenshot({ type: "jpeg", quality: 70, fullPage: false }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("截图超时（35秒）")), 35000)
      ),
    ]);
    const dataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
    onStepUpdate({
      type: "screenshot",
      stepId: BROWSER_STEP_IDS.COUNTRY_CHECK,
      label: `视频发布地 @${username} (${progress})`,
      image: dataUrl,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(
      `[resolveVideoPublishCountry] 截图跳过 @${username}:`,
      e?.message || e
    );
  }
}

async function probeVideoLocationCreated(page, videoUrl) {
  const videoId = extractVideoId(videoUrl);
  const username = extractUsernameFromVideoUrl(videoUrl);
  if (!videoUrl) {
    return { locationCreated: null, source: null, error: "missing_video_url" };
  }
  if (!videoId || !username) {
    return { locationCreated: null, source: null, error: "missing_video_or_user" };
  }

  try {
    const { resolveVideoLocationCreated } = await import(
      "./tiktok/tiktok-direct-fetch.js"
    );
    return await resolveVideoLocationCreated(page, {
      username,
      videoId,
    });
  } catch (e) {
    return { locationCreated: null, source: null, error: e.message };
  }
}

async function fetchLocationCreatedForEndpointHealth(
  page,
  username,
  videoId,
  parseLocationCreatedFromVideoHtml
) {
  const handle = normalizeUsername(username);
  const id = String(videoId || "").trim();
  if (!page || !handle || !id) return null;
  const videoUrl = `https://www.tiktok.com/@${handle}/video/${id}`;
  const timeoutMs = Math.max(
    3000,
    Number(process.env.TT_LITE_COUNTRY_ENDPOINT_HEALTH_TIMEOUT_MS || 12_000)
  );
  const html = await Promise.race([
    page.evaluate(async (url) => {
      const res = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: "https://www.tiktok.com/",
        },
      });
      return res.text();
    }, videoUrl),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!html) return null;
  return parseLocationCreatedFromVideoHtml(html, id);
}

/**
 * @returns {Promise<{
 *   checked: Array,
 *   passed: Array,
 *   outcomes: Array,
 *   stats: { checked: number, passed: number, unknown: number, mismatch: number }
 * }>}
 */
export async function resolveVideoPublishCountryForInfluencers({
  influencerRecords = [],
  videos = [],
  maxCount = 20,
  allowedCountries = [],
  taskId = null,
  importTaskId = null,
  onStepUpdate = null,
  delayBetweenVideos = { min: 5000, max: 10000 },
} = {}) {
  const allowedIso = normalizeAllowedCountries(allowedCountries);
  const videoDelay = resolveDelayBetweenVideos(delayBetweenVideos);
  const sendStep = (step, message) => {
    try {
      onStepUpdate?.({ step, message });
    } catch {
      /* ignore */
    }
  };

  const queue = orderInfluencersForCountryCheck(
    influencerRecords,
    videos,
    maxCount
  );

  if (!queue.length) {
    return {
      checked: [],
      passed: [],
      outcomes: [],
      stats: { checked: 0, passed: 0, unknown: 0, mismatch: 0 },
    };
  }

  // Lite：9223 fetch-only 读取代表视频/alt 视频 HTML UNIVERSAL 中的 ISO-2 locationCreated；不使用 search_api 或 item_detail 国家。
  if (isLiteScraperMode()) {
    const {
      acquireTiktokApiSession,
      parseLocationCreatedFromVideoHtml,
      resolveTiktokLiteEnrichEndpoints,
      resolveVideoLocationCreatedForInfluencer,
    } = await import("./tiktok/tiktok-direct-fetch.js");
    const {
      recoverTiktokPageFromAccessDenied,
      bootstrapTiktokWebSession,
      refreshTiktokApiSession,
    } =
      await import("./tiktok/tiktok-api-client.js");
    const endpointCandidates = String(process.env.TT_LITE_COUNTRY_CDP || "").trim()
      ? [String(process.env.TT_LITE_COUNTRY_CDP).trim()]
      : resolveTiktokLiteEnrichEndpoints();
    const explicitEndpointPool = String(process.env.TT_LITE_ENRICH_CDP_ENDPOINTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length > 0;
    const countryHardMax = Math.max(
      1,
      Math.floor(Number(process.env.TT_LITE_COUNTRY_CONCURRENCY_HARD_MAX) || 150)
    );
    const countryBatchSize = Math.max(1, queue.length);
    const stopOnZeroBatchMatch = resolveCountryStopOnZeroBatchMatch();
    const tabPoolSize = resolveLiteCdpTabPoolSize();
    const configuredRawConcurrency = Number(
      process.env.TT_LITE_COUNTRY_CONCURRENCY || tabPoolSize
    );
    const plannedConcurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(configuredRawConcurrency)
          ? Math.floor(configuredRawConcurrency)
          : tabPoolSize,
        countryHardMax,
        tabPoolSize
      )
    );

    sendStep(
      "采集视频发布地",
      `Lite：endpoint pool video_html_fetch 读视频发布地（全池 ${queue.length} 人，并发 ${plannedConcurrency}，${tabPoolSize} tab，endpoints ${endpointCandidates.join(", ")}${stopOnZeroBatchMatch ? "，0 明确符合则停" : ""}，不打开视频页）...`
    );

    const checked = [];
    const passed = [];
    const outcomes = [];
    let unknown = 0;
    let mismatch = 0;
    let bioPassed = 0;
    let explicitMatches = 0;
    let stoppedEarly = false;

    const videoByUser = new Map();
    const altVideosByUser = new Map();
    for (const v of videos || []) {
      const u = normalizeUsername(v.username);
      if (!u) continue;
      if (!videoByUser.has(u)) videoByUser.set(u, v);
      const vid = String(v.videoId || "").trim();
      if (!vid) continue;
      if (!altVideosByUser.has(u)) altVideosByUser.set(u, []);
      const list = altVideosByUser.get(u);
      if (!list.includes(vid)) list.push(vid);
    }

    function buildCountryProbeInput(record) {
      const username = normalizeUsername(record.username);
      const videoId =
        record.representativeVideoId || extractVideoId(record.representativeVideoUrl);
      const srcVideo = videoByUser.get(username);
      const primaryVid = videoId || srcVideo?.videoId || "";
      const altVideoIds = (altVideosByUser.get(username) || []).filter(
        (id) => id && id !== primaryVid
      );
      return {
        username,
        primaryVid,
        altVideoIds,
        secUid: record.secUid || record.tiktokSecUid || srcVideo?.creator?.secUid || "",
      };
    }

    /** @type {Array<{ page: object, dispose: Function }>} */
    const pool = [];
    for (let i = 0; i < tabPoolSize; i += 1) {
      let session = null;
      let lastErr = null;
      const slotEndpoint = explicitEndpointPool ? endpointCandidates[i] : null;
      const candidates = slotEndpoint ? [slotEndpoint] : endpointCandidates;
      if (!candidates.length) {
        lastErr = new Error("no_endpoint_candidates");
      }
      for (const endpointKey of candidates) {
        try {
          session = await acquireTiktokApiSession(null, {
            endpointKey,
            forceNewTab: false,
          });
          console.log(
            `[resolveVideoPublishCountry] country session ${pool.length + 1}/${tabPoolSize} via ${endpointKey} slot=${i + 1}`
          );
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!session) {
        console.warn(
          `[resolveVideoPublishCountry] country session slot ${i + 1} failed${slotEndpoint ? ` endpoint=${slotEndpoint}` : ""}: ${lastErr?.message || lastErr}`
        );
        continue;
      }
      pool.push(session);
    }
    if (!pool.length) {
      throw new Error(
        `TikTok Lite 国家检测：endpoint pool API 会话不可用 endpoints=${endpointCandidates.join(",") || "-"}`
      );
    }
    if (pool.length < Math.min(tabPoolSize, endpointCandidates.length || tabPoolSize)) {
      console.warn(
        `[resolveVideoPublishCountry] endpoint pool 降级 ${pool.length}/${tabPoolSize}`
      );
    }

    for (const session of pool) {
      try {
        const page = session.page;
        const ok = await recoverTiktokPageFromAccessDenied(page);
        if (!ok) {
          await bootstrapTiktokWebSession(page, { forceRefresh: true });
        }
      } catch (e) {
        console.warn(
          `[resolveVideoPublishCountry] 9223 country session bootstrap: ${e.message}`
        );
      }
    }

    const healthSampleSize = Math.max(
      0,
      Math.floor(Number(process.env.TT_LITE_COUNTRY_ENDPOINT_HEALTH_SAMPLE_SIZE ?? 1))
    );
    let activePool = pool;
    if (healthSampleSize > 0 && pool.length > 1) {
      const healthRecords = queue
        .filter((record) => {
          const input = buildCountryProbeInput(record);
          return input.username && input.primaryVid;
        })
        .slice(0, healthSampleSize);
      if (healthRecords.length) {
        const healthy = [];
        for (const session of pool) {
          let sampleLoc = null;
          let sampleUser = null;
          let sampleError = null;
          for (const record of healthRecords) {
            const input = buildCountryProbeInput(record);
            try {
              sampleLoc = await fetchLocationCreatedForEndpointHealth(
                session.page,
                input.username,
                input.primaryVid,
                parseLocationCreatedFromVideoHtml
              );
              sampleUser = input.username;
              if (sampleLoc) break;
            } catch (e) {
              sampleUser = input.username;
              sampleError = e.message;
            }
          }
          if (sampleLoc) {
            healthy.push(session);
            console.log(
              `[resolveVideoPublishCountry] endpoint health ok ${session.endpointKey || "-"} sample=@${sampleUser} locationCreated=${sampleLoc}`
            );
          } else {
            console.warn(
              `[resolveVideoPublishCountry] endpoint health weak ${session.endpointKey || "-"} sample=@${sampleUser || "-"} err=${sampleError || "no_location_from_video_html_fetch"}`
            );
          }
        }
        if (healthy.length) {
          activePool = healthy;
          for (const session of pool) {
            if (!healthy.includes(session)) {
              try {
                await session.dispose();
              } catch {
                /* ignore */
              }
            }
          }
          if (healthy.length < pool.length) {
            console.warn(
              `[resolveVideoPublishCountry] endpoint pool fetch-health 降级 ${healthy.length}/${pool.length}`
            );
          }
        }
      }
    }

    const rawConcurrency = Number(
      process.env.TT_LITE_COUNTRY_CONCURRENCY || activePool.length
    );
    const concurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : activePool.length,
        countryHardMax,
        activePool.length
      )
    );

    // 任务级会话刷新：每个任务开始时清 cookies 重建匿名指纹（对齐 9222/9223 登出方案）。
    // 关闭：TT_LITE_SESSION_REFRESH_ON_START=0
    const sessionRefreshOnStart =
      String(process.env.TT_LITE_SESSION_REFRESH_ON_START ?? "1").trim() !== "0";
    if (sessionRefreshOnStart) {
      for (const session of activePool) {
        try {
          await refreshTiktokApiSession(session.page);
          console.log(
            `[resolveVideoPublishCountry] task-start session refreshed ${session.endpointKey || "-"}`
          );
        } catch (e) {
          console.warn(
            `[resolveVideoPublishCountry] task-start session refresh failed ${session.endpointKey || "-"}: ${e.message}`
          );
        }
      }
    }

    // 周期会话刷新：单会话累计 N 次探测后清 cookies 重建匿名指纹（默认 30）。
    const sessionRefreshInterval = Math.max(
      1,
      Math.floor(Number(process.env.TT_LITE_COUNTRY_SESSION_REFRESH_INTERVAL || 30))
    );
    const sessionProbeCounts = new Array(activePool.length).fill(0);

    async function probeLocation(record, sessionIdx) {
      const stagger = Number(process.env.TT_LITE_COUNTRY_PROBE_STAGGER_MS || 80);
      if (stagger > 0 && sessionIdx > 0) {
        await new Promise((r) =>
          setTimeout(r, (sessionIdx % concurrency) * stagger)
        );
      }
      const { username, primaryVid, altVideoIds, secUid } = buildCountryProbeInput(record);
      const poolIdx = sessionIdx % activePool.length;
      const page = activePool[poolIdx].page;
      sessionProbeCounts[poolIdx] += 1;
      if (sessionProbeCounts[poolIdx] % sessionRefreshInterval === 0) {
        try {
          await refreshTiktokApiSession(page);
          console.log(
            `[resolveVideoPublishCountry] periodic session refreshed ${activePool[poolIdx].endpointKey || "-"} count=${sessionProbeCounts[poolIdx]}`
          );
        } catch (e) {
          console.warn(
            `[resolveVideoPublishCountry] periodic session refresh failed ${activePool[poolIdx].endpointKey || "-"}: ${e.message}`
          );
        }
      }
      try {
        return await resolveVideoLocationCreatedForInfluencer(page, {
          videoId: primaryVid,
          altVideoIds,
          username,
          secUid,
        });
      } catch (e) {
        return {
          locationCreated: null,
          source: null,
          error: e.message,
        };
      }
    }

    async function processOneRecord(record, globalIndex, probe) {
      const username = normalizeUsername(record.username);
      const progress = `${globalIndex + 1}/${queue.length}`;
      const locationCreated = probe.locationCreated || null;
      const pass = countryMatchesPublishLocation(locationCreated, allowedIso);
      const explicitMatch = !!(locationCreated && pass);

      // 国家未知：bio 语言推断兜底（参考 Lite ins/ytb）。明确不符合才跳过；符合/不可识别继续。
      let bioGate = null;
      if (!locationCreated && allowedIso.length > 0) {
        bioGate = resolveUnknownCountryBioGate(record.bio, allowedIso);
      }
      const bioGateSkip = !!bioGate && !bioGate.proceed;

      let enrichSkippedReason = null;
      let countrySource = probe.source || "video_html_fetch";
      let shouldPass = false;
      if (!locationCreated) {
        unknown += 1;
        if (bioGateSkip) {
          enrichSkippedReason = "bio_language_mismatch";
          mismatch += 1;
        } else {
          shouldPass = true;
          bioPassed += 1;
          countrySource =
            bioGate?.source === "bio_language_maybe"
              ? "bio_language_maybe"
              : "country_unknown";
        }
      } else if (!pass) {
        enrichSkippedReason = "country_mismatch";
        mismatch += 1;
      } else {
        explicitMatches += 1;
        shouldPass = true;
      }

      await saveVideoPublishCountry({
        username,
        videoPublishCountry: locationCreated,
        representativeVideoId:
          probe.representativeVideoId || record.representativeVideoId || null,
        locationSource: probe.source || "video_html_fetch",
      });

      const enrichedRecord = {
        ...record,
        video_publish_country: locationCreated,
        video_publish_country_source: countrySource,
        enrich_skipped_reason: enrichSkippedReason,
      };
      checked.push(enrichedRecord);

      // Lite：明确符合国家，或国家未知但 bio 语言符合/不可识别者进入 enrich；mismatch 跳过。
      if (shouldPass) {
        passed.push(enrichedRecord);
      }

      const outcome = {
        username,
        video_publish_country: locationCreated,
        representative_video_id:
          probe.representativeVideoId || record.representativeVideoId || null,
        enrich_skipped_reason: enrichSkippedReason,
        country_passed: shouldPass,
        country_source: countrySource,
      };
      outcomes.push(outcome);

      const importTid = Number(importTaskId || 0);
      const tid = Number(taskId || 0);
      if (importTid || tid) {
        try {
          if (importTid) {
            await bumpImportTaskCountryProgress(importTid, {
              checkedDelta: 1,
              passedDelta: shouldPass ? 1 : 0,
            });
            await touchImportTaskLastProgressAt(importTid);
          } else {
            await bumpSearchTaskCountryProgress(tid, {
              checkedDelta: 1,
              passedDelta: shouldPass ? 1 : 0,
            });
            if (enrichSkippedReason === "country_unknown") {
              await bumpSearchTaskSkipCountryProgress(tid, { unknownDelta: 1 });
            } else if (
              enrichSkippedReason === "country_mismatch" ||
              enrichSkippedReason === "bio_language_mismatch"
            ) {
              await bumpSearchTaskSkipCountryProgress(tid, { mismatchDelta: 1 });
            }
            await appendSearchTaskCountryOutcome(tid, outcome, allowedIso);
            await touchSearchTaskLastProgressAt(tid);
          }
        } catch (e) {
          console.warn(
            `[resolveVideoPublishCountry] 任务进度更新失败 @${username}:`,
            e.message
          );
        }
      }

      const flag = locationCreated ? (pass ? "✅" : "⛔") : "❓";
      console.log(
        `[resolveVideoPublishCountry] [${progress}] ${flag} @${username} locationCreated=${locationCreated ?? "null"} (${probe.source || "video_html_fetch"})${enrichSkippedReason ? ` (${enrichSkippedReason})` : ""}${probe.error ? ` err=${probe.error}` : ""}`
      );

      return explicitMatch;
    }

    for (let batchStart = 0; batchStart < queue.length; batchStart += countryBatchSize) {
      const countryBatch = queue.slice(batchStart, batchStart + countryBatchSize);
      let batchExplicitMatches = 0;

      for (let subStart = 0; subStart < countryBatch.length; subStart += concurrency) {
        const subBatch = countryBatch.slice(subStart, subStart + concurrency);
        const probes = await Promise.all(
          subBatch.map((record, j) =>
            probeLocation(record, batchStart + subStart + j)
          )
        );
        for (let j = 0; j < subBatch.length; j += 1) {
          const matched = await processOneRecord(
            subBatch[j],
            batchStart + subStart + j,
            probes[j]
          );
          if (matched) batchExplicitMatches += 1;
        }
      }

      const batchNum = Math.floor(batchStart / countryBatchSize) + 1;
      console.log(
        `[resolveVideoPublishCountry] 国家批次 ${batchNum} 完成：检查 ${countryBatch.length} 人，明确符合国家 ${batchExplicitMatches} 人`
      );

      if (stopOnZeroBatchMatch && batchExplicitMatches === 0) {
        stoppedEarly = true;
        sendStep(
          "批次停止",
          `第 ${batchNum} 批 ${countryBatch.length} 人 0 位明确符合国家，停止后续国家检测`
        );
        break;
      }
    }

    for (const session of activePool) {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
    }

    sendStep(
      "采集视频发布地",
      `Lite endpoint pool API-only 发布地完成：检查 ${checked.length} 人，进入 enrich ${passed.length} 人（明确符合 ${explicitMatches} + bio 语言兜底 ${bioPassed}），国家未知 ${unknown} mismatch ${mismatch}${stoppedEarly ? "（提前停止）" : ""}`
    );

    return {
      checked,
      passed,
      outcomes,
      stats: {
        checked: checked.length,
        passed: passed.length,
        unknown,
        mismatch,
        bioPassed,
        explicitMatches,
        stoppedEarly,
      },
    };
  }

  sendStep(
    "采集视频发布地",
    `正在通过视频详情页采集 ${queue.length} 位红人的发布地（9222）...`
  );

  const { withCdp9222PreparedSession } = await import("../../cdp/connect-cdp-9222.js");
  const { openCdpTaskPage, closeCdpTaskPage } = await import("../../cdp/cdp-tab-utils.js");

  return await withCdp9222PreparedSession(
    { platform: "tiktok", phase: "video_publish_country" },
    async ({ context }) => {
  const checked = [];
  const passed = [];
  const outcomes = [];
  let unknown = 0;
  let mismatch = 0;

    for (let i = 0; i < queue.length; i++) {
      const record = queue[i];
      const username = normalizeUsername(record.username);
      const progress = `${i + 1}/${queue.length}`;

      if (i > 0) {
        await sleep(randomDelayMs(videoDelay));
      }

      let page = null;
      try {
        page = await openCdpTaskPage(context);
        const probe = await probeVideoLocationCreated(
          page,
          record.representativeVideoUrl
        );
      const locationCreated = probe.locationCreated || null;
      const pass = countryMatchesPublishLocation(locationCreated, allowedIso);

      await reportCountryScreenshot(onStepUpdate, page, username, progress);

      let enrichSkippedReason = null;
      if (!locationCreated) {
        enrichSkippedReason = "country_unknown";
        unknown += 1;
      } else if (!pass) {
        enrichSkippedReason = "country_mismatch";
        mismatch += 1;
      }

      await saveVideoPublishCountry({
        username,
        videoPublishCountry: locationCreated,
        representativeVideoId: record.representativeVideoId || null,
        locationSource: probe.source || null,
      });

      const enrichedRecord = {
        ...record,
        video_publish_country: locationCreated,
        enrich_skipped_reason: enrichSkippedReason,
      };
      checked.push(enrichedRecord);

      const outcome = {
        username,
        video_publish_country: locationCreated,
        representative_video_id: record.representativeVideoId || null,
        enrich_skipped_reason: enrichSkippedReason,
        country_passed: pass && !!locationCreated,
      };
      outcomes.push(outcome);

      const importTid = Number(importTaskId || 0);
      const tid = Number(taskId || 0);
      if (importTid || tid) {
        try {
          if (importTid) {
            await bumpImportTaskCountryProgress(importTid, {
              checkedDelta: 1,
              passedDelta: pass && locationCreated ? 1 : 0,
            });
            await touchImportTaskLastProgressAt(importTid);
          } else {
            await bumpSearchTaskCountryProgress(tid, {
              checkedDelta: 1,
              passedDelta: pass && locationCreated ? 1 : 0,
            });
            if (enrichSkippedReason === "country_unknown") {
              await bumpSearchTaskSkipCountryProgress(tid, { unknownDelta: 1 });
            } else if (enrichSkippedReason === "country_mismatch") {
              await bumpSearchTaskSkipCountryProgress(tid, { mismatchDelta: 1 });
            }
            await appendSearchTaskCountryOutcome(tid, outcome, allowedIso);
            await touchSearchTaskLastProgressAt(tid);
          }
        } catch (e) {
          console.warn(
            `[resolveVideoPublishCountry] 任务进度更新失败 @${username}:`,
            e.message
          );
        }
      }

      if (pass && locationCreated) {
        passed.push(enrichedRecord);
      }

      const flag = locationCreated
        ? pass
          ? "✅"
          : "⛔"
        : "❓";
      console.log(
        `[resolveVideoPublishCountry] [${progress}] ${flag} @${username} locationCreated=${locationCreated ?? "null"}${enrichSkippedReason ? ` (${enrichSkippedReason})` : ""}`
      );
      } finally {
        await closeCdpTaskPage(page);
      }
    }

  sendStep(
    "采集视频发布地",
    `发布地采集完成：检查 ${checked.length} 人，符合 campaign 国家 ${passed.length} 人`
  );

  return {
    checked,
    passed,
    outcomes,
    stats: {
      checked: checked.length,
      passed: passed.length,
      unknown,
      mismatch,
    },
  };
    }
  );
}
