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

    // 恢复链预算：单任务中途轮换 ≤2 次，两次间隔 ≥60s；轮换后仍全空则判定 IP 层拦截，
    // 后续批次快速跳过（避免坏 IP 下每人都做无意义的 tab 重建/重试浪费流量）。
    let midTaskRotations = 0;
    let lastMidTaskRotationAt = 0;
    let ipBlockedMode = false;
    let ipBlockedAt = 0;
    const canRotateMidTask = () =>
      midTaskRotations < 2 && Date.now() - lastMidTaskRotationAt >= 60_000;
    const markMidTaskRotation = () => {
      midTaskRotations += 1;
      lastMidTaskRotationAt = Date.now();
    };

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
          "../../ops/tiktok-session-manager.js"
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
        markMidTaskRotation();
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
      // tk-ip 出口 IP 每 5 分钟自动过期换新；blocked 状态每 5 分钟重置，
      // 让新 IP 有一次恢复机会，避免整批导入被一次坏 IP 全部跳过。
      if (ipBlockedMode && Date.now() - ipBlockedAt >= 5 * 60 * 1000) {
        ipBlockedMode = false;
        console.warn("[resolveImportTiktokFirstVideos] IP 窗口已过期，重置 blocked 状态重试");
      }

      const allIndices = batch.map((_, j) => j);
      let probes = await runProbes(allIndices, batch, start);
      let failedIdx = [...probes.entries()]
        .filter(([, p]) => !p?.videoId)
        .map(([j]) => j);

      if (failedIdx.length > 0 && !ipBlockedMode) {
        const allEmptyish = failedIdx.every((j) =>
          isEmptyishError(probes.get(j)?.error)
        );
        if (allEmptyish) {
          // IP 数据层拦截：重建 tab 无意义，直接轮换 IP（≤2 次）
          if (canRotateMidTask()) {
            const rotated = await rotatePoolAndRebuild();
            if (rotated) {
              const retry = await runProbes(failedIdx, batch, start);
              for (const j of failedIdx) probes.set(j, retry.get(j));
              const still = failedIdx.filter((j) => !retry.get(j)?.videoId);
              if (still.length) {
                ipBlockedMode = true;
                ipBlockedAt = Date.now();
                console.warn(
                  `[resolveImportTiktokFirstVideos] 轮换后仍 ${still.length} 人空结果，判定 IP 层拦截，后续批次快速跳过`
                );
              }
            }
          } else {
            ipBlockedMode = true;
            ipBlockedAt = Date.now();
          }
        } else {
          // tab/网络类：重建 tab 重试一次，仍失败再轮换 IP + 重建
          await rebuildAllPoolSlots();
          const retry = await runProbes(failedIdx, batch, start);
          for (const j of failedIdx) probes.set(j, retry.get(j));
          const still = failedIdx.filter((j) => !retry.get(j)?.videoId);
          if (still.length > 0 && canRotateMidTask()) {
            const rotated = await rotatePoolAndRebuild();
            if (rotated) {
              const retry2 = await runProbes(still, batch, start);
              for (const j of still) probes.set(j, retry2.get(j));
            }
          }
        }
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
