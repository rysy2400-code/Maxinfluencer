/**
 * Lite 导入 Phase 1：9223 signed API 并发拉取每位 TikTok 红人首条视频
 */

import {
  resolveLiteCdpTabPoolSize,
} from "../../../scraper/resolve-scraper-mode.js";
import {
  acquireTiktokApiSession,
  fetchFirstRepresentativeVideoForUser,
  resolveTiktokLiteEnrichEndpoints,
} from "./tiktok-direct-fetch.js";

function normalizeUsername(username) {
  return String(username || "").replace(/^@/, "").trim();
}

function resolveFirstVideoConcurrency() {
  const raw =
    process.env.TT_LITE_FIRST_VIDEO_CONCURRENCY ??
    process.env.LITE_TT_ENRICH_CONCURRENCY;
  const n = Number(raw ?? 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10);
}

/**
 * @param {object} record
 * @param {object} probe
 * @returns {object}
 */
function mergeFirstVideoProbe(record, probe) {
  const username = normalizeUsername(record.username);
  const base = { ...record, username: record.username || username };

  if (probe.videoId) {
    return {
      ...base,
      representativeVideoId: probe.videoId,
      representativeVideoUrl: probe.videoUrl,
      secUid: probe.secUid || record.secUid || null,
      tiktokSecUid: probe.secUid || record.tiktokSecUid || null,
      tiktokUserId: probe.userId || record.tiktokUserId || null,
    };
  }

  return {
    ...base,
    representativeVideoId: null,
    representativeVideoUrl: null,
    secUid: probe.secUid || record.secUid || null,
    tiktokSecUid: probe.secUid || record.tiktokSecUid || null,
    enrich_skipped_reason: "no_representative_video",
    first_video_error: probe.error || "no_representative_video",
  };
}

/**
 * @param {{
 *   influencerRecords?: object[],
 *   onStepUpdate?: Function,
 *   importTaskId?: number|null,
 * }} opts
 * @returns {Promise<{ records: object[], stats: { total: number, withVideo: number, skipped: number } }>}
 */
export async function resolveImportTiktokFirstVideos({
  influencerRecords = [],
  onStepUpdate = null,
  importTaskId = null,
} = {}) {
  const queue = (influencerRecords || []).filter((r) =>
    normalizeUsername(r.username)
  );
  if (!queue.length) {
    return { records: [], stats: { total: 0, withVideo: 0, skipped: 0 } };
  }

  const concurrency = resolveFirstVideoConcurrency();
  const tabPoolSize = resolveLiteCdpTabPoolSize();
  const endpointCandidates = resolveTiktokLiteEnrichEndpoints();
  const explicitEndpointPool = String(process.env.TT_LITE_ENRICH_CDP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length > 0;
  const desiredEndpoints = explicitEndpointPool
    ? endpointCandidates.slice(0, tabPoolSize)
    : Array.from({ length: tabPoolSize }, () => null);

  const sendStep = (step, message) => {
    try {
      onStepUpdate?.({ step, message });
    } catch {
      /* ignore */
    }
  };

  sendStep(
    "拉取首条视频",
    `Lite 导入：9223 拉取 ${queue.length} 位 TikTok 首条视频（并发 ${concurrency}，${tabPoolSize} tab）...`
  );

  /** @type {Array<{ page: object, dispose: Function }>} */
  const pool = [];
  for (let i = 0; i < tabPoolSize; i += 1) {
    let session = null;
    let lastErr = null;
    const slotEndpoint = desiredEndpoints[i];
    const candidates = slotEndpoint ? [slotEndpoint] : endpointCandidates;
    for (const endpointKey of candidates) {
      try {
        session = await acquireTiktokApiSession(null, {
          endpointKey,
          forceNewTab: false,
        });
        console.log(
          `[resolveImportTiktokFirstVideos] TikTok Lite first-video session ${pool.length + 1}/${tabPoolSize} via ${endpointKey}`
        );
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!session && explicitEndpointPool) {
      console.warn(
        `[resolveImportTiktokFirstVideos] endpoint slot ${i + 1} unavailable${slotEndpoint ? ` endpoint=${slotEndpoint}` : ""}: ${lastErr?.message || lastErr}`
      );
      continue;
    }
    if (!session) {
      throw new Error(
        `TikTok Lite 首视频拉取：9223 会话不可用${lastErr ? `: ${lastErr.message}` : ""}`
      );
    }
    pool.push(session);
  }
  if (!pool.length) {
    throw new Error("TikTok Lite 首视频拉取：endpoint pool 全部不可用");
  }

  const { recoverTiktokPageFromAccessDenied, bootstrapTiktokWebSession } =
    await import("./tiktok-api-client.js");
  for (const session of pool) {
    try {
      const page = session.page;
      const ok = await recoverTiktokPageFromAccessDenied(page);
      if (!ok) {
        await bootstrapTiktokWebSession(page, { forceRefresh: true });
      }
    } catch (e) {
      console.warn(
        `[resolveImportTiktokFirstVideos] 9223 session bootstrap: ${e.message}`
      );
    }
  }

  const results = new Array(queue.length);
  let withVideo = 0;
  let skipped = 0;

  try {
    const runtimeConcurrency = Math.min(concurrency, pool.length);
    if (runtimeConcurrency !== concurrency) {
      console.warn(
        `[resolveImportTiktokFirstVideos] planned concurrency ${concurrency} -> runtime concurrency ${runtimeConcurrency}`
      );
    }
    for (let start = 0; start < queue.length; start += runtimeConcurrency) {
      const batch = queue.slice(start, start + runtimeConcurrency);
      const probes = await Promise.all(
        batch.map((record, j) => {
          const page = pool[(start + j) % pool.length].page;
          return fetchFirstRepresentativeVideoForUser(
            page,
            normalizeUsername(record.username)
          );
        })
      );

      for (let j = 0; j < batch.length; j += 1) {
        const globalIndex = start + j;
        const merged = mergeFirstVideoProbe(batch[j], probes[j]);
        results[globalIndex] = merged;
        const progress = `${globalIndex + 1}/${queue.length}`;
        if (merged.representativeVideoId) {
          withVideo += 1;
          console.log(
            `[resolveImportTiktokFirstVideos] [${progress}] ✅ @${normalizeUsername(merged.username)} vid=${merged.representativeVideoId}`
          );
        } else {
          skipped += 1;
          console.log(
            `[resolveImportTiktokFirstVideos] [${progress}] ⏭️ @${normalizeUsername(merged.username)} no_representative_video${merged.first_video_error ? ` (${merged.first_video_error})` : ""}`
          );
        }
      }
    }
  } finally {
    for (const session of pool) {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  sendStep(
    "拉取首条视频",
    `首条视频完成：${withVideo}/${queue.length} 有代表视频，${skipped} 跳过`
  );

  if (importTaskId) {
    console.log(
      `[resolveImportTiktokFirstVideos] importTaskId=${importTaskId} withVideo=${withVideo} skipped=${skipped}`
    );
  }

  return {
    records: results,
    stats: { total: queue.length, withVideo, skipped },
  };
}
