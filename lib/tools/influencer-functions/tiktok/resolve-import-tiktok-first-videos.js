/**
 * Lite 导入 Phase 1：9223 signed API 并发拉取每位 TikTok 红人首条视频
 */

import {
  resolveLiteCdpTabPoolSize,
} from "../../../scraper/resolve-scraper-mode.js";
import { touchImportTaskLastProgressAt } from "../../../db/influencer-import-task-dao.js";
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

    // 恢复策略（用户确认）：
    // - 同一 IP 连续 3 次 item_list 空 → 立即轮换 IP + 重建 tab；
    // - 同一 IP 每成功 20 次 → 主动轮换 1 次（避开配额墙）；
    // - 单任务轮换不设上限；
    // - 连续 2 次轮换均无成功 → 进入快速跳过兜底（5 分钟 IP 窗口重置再试）。
    let successesSinceRotation = 0;
    let emptiesSinceSuccess = 0;
    let rotationsSinceLastSuccess = 0;
    let fastSkipMode = false;
    let fastSkipSince = 0;

    const rebuildPoolSlot = async (slotIndex) => {
      const old = pool[slotIndex];
      const endpointKey =
        old?.page?._ttApiSessionKey?.split("#")[0] ||
        old?.endpointKey ||
        (explicitEndpointPool ? desiredEndpoints[slotIndex] : null) ||
        endpointCandidates[0];
      try {
        await old?.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        const session = await acquireTiktokApiSession(null, {
          endpointKey,
          forceNewTab: true,
        });
        try {
          const ok = await recoverTiktokPageFromAccessDenied(session.page);
          if (!ok) {
            await bootstrapTiktokWebSession(session.page, { forceRefresh: true });
          }
        } catch (e) {
          console.warn(
            `[resolveImportTiktokFirstVideos] slot ${slotIndex} bootstrap: ${e.message}`
          );
        }
        pool[slotIndex] = session;
      } catch (e) {
        console.warn(
          `[resolveImportTiktokFirstVideos] slot ${slotIndex} 重建失败: ${e.message}`
        );
      }
    };

    const rebuildAllPoolSlots = async () => {
      await Promise.all(pool.map((_, i) => rebuildPoolSlot(i)));
    };

    const rotatePoolAndRebuild = async () => {
      try {
        const { rotateTkIpSession, resolveTkIpProxyPort, getTkIpSessionState } = await import(
          "../../../ops/tiktok-session-manager.js"
        );
        const rot = await rotateTkIpSession(resolveTkIpProxyPort());
        if (!rot?.ok || rot?.skipped) {
          console.warn(
            `[resolveImportTiktokFirstVideos] 轮换未生效: ${rot?.error || "skipped"}`
          );
          return false;
        }
        const st = getTkIpSessionState(
          endpointCandidates[0] || "http://127.0.0.1:9223"
        );
        st.healthy = false;
        st.checkedAt = 0;
        st.forceFresh = true;
        console.log(
          `[resolveImportTiktokFirstVideos] 中途轮换 IP ok sid=${rot.sid || "-"} ip=${rot.ip || "-"}`
        );
        rotationsSinceLastSuccess += 1;
        successesSinceRotation = 0;
        emptiesSinceSuccess = 0;
      } catch (e) {
        console.warn(`[resolveImportTiktokFirstVideos] 中途轮换异常: ${e.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 3000));
      await rebuildAllPoolSlots();
      return true;
    };

    const isEmptyishError = (msg) => {
      const m = String(msg || "");
      return /empty|status_code.?403|items=0|signed fetch empty|no_representative_video/i.test(m);
    };

    const runProbes = async (indices, batchArr, startIdx) => {
      const out = new Map();
      await Promise.all(
        indices.map(async (j) => {
          const page = pool[(startIdx + j) % pool.length].page;
          const probe = await fetchFirstRepresentativeVideoForUser(
            page,
            normalizeUsername(batchArr[j].username)
          ).catch((e) => ({
            videoId: null,
            videoUrl: null,
            secUid: null,
            userId: null,
            error: e?.message || String(e),
          }));
          out.set(j, probe);
        })
      );
      return out;
    };

    for (let start = 0; start < queue.length; start += runtimeConcurrency) {
      const batch = queue.slice(start, start + runtimeConcurrency);
      if (importTaskId && start % 25 === 0) {
        try {
          await touchImportTaskLastProgressAt(importTaskId);
        } catch {
          /* ignore */
        }
      }
      const allIndices = batch.map((_, j) => j);
      let probes = await runProbes(allIndices, batch, start);
      let failedIdx = [...probes.entries()]
        .filter(([, p]) => !p?.videoId)
        .map(([j]) => j);

      // 计数更新：本批有成功则重置连续空；无成功则累加连续空
      const batchSuccessCount = batch.length - failedIdx.length;
      if (batchSuccessCount > 0) {
        successesSinceRotation += batchSuccessCount;
        emptiesSinceSuccess = 0;
        rotationsSinceLastSuccess = 0;
        if (fastSkipMode) {
          fastSkipMode = false;
          console.warn("[resolveImportTiktokFirstVideos] 出现成功，退出快速跳过");
        }
      } else {
        emptiesSinceSuccess += failedIdx.length;
      }

      // 快速跳过兜底：5 分钟 IP 窗口重置后给一次恢复机会
      if (fastSkipMode && Date.now() - fastSkipSince >= 5 * 60 * 1000) {
        fastSkipMode = false;
        console.warn("[resolveImportTiktokFirstVideos] IP 窗口已过期，重置快速跳过");
      }

      if (failedIdx.length > 0 && !fastSkipMode) {
        const allEmptyish = failedIdx.every((j) =>
          isEmptyishError(probes.get(j)?.error)
        );
        if (allEmptyish && emptiesSinceSuccess >= 3) {
          // 连续 3 次空 → 轮换 IP + 重建 tab，并重试本批失败项一次
          const rotated = await rotatePoolAndRebuild();
          if (rotated) {
            const retry = await runProbes(failedIdx, batch, start);
            for (const j of failedIdx) probes.set(j, retry.get(j));
            const okAfter = failedIdx.filter((j) => retry.get(j)?.videoId).length;
            if (okAfter > 0) {
              successesSinceRotation += okAfter;
              rotationsSinceLastSuccess = 0;
            } else if (rotationsSinceLastSuccess >= 2) {
              fastSkipMode = true;
              fastSkipSince = Date.now();
              rotationsSinceLastSuccess = 0;
              console.warn(
                "[resolveImportTiktokFirstVideos] 连续轮换无成功，进入快速跳过兜底（5 分钟后重置）"
              );
            }
          }
        } else if (!allEmptyish) {
          // tab/网络类：重建 tab 重试一次（不计入连续空计数）
          await rebuildAllPoolSlots();
          const retry = await runProbes(failedIdx, batch, start);
          for (const j of failedIdx) probes.set(j, retry.get(j));
        }
      }

      // 主动轮换：同一 IP 累计成功 20 次后换新 IP（避开配额墙）
      if (!fastSkipMode && successesSinceRotation >= 20) {
        await rotatePoolAndRebuild();
      }

      for (let j = 0; j < batch.length; j += 1) {
        const globalIndex = start + j;
        const merged = mergeFirstVideoProbe(batch[j], probes.get(j) || {});
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
