/**
 * Lite 导入 Phase 1（bio 门禁，替代首视频+视频国家检查）：
 * user/detail 拉 bio → bio 语言推断匹配投放地区主语言 → 通过者直接进 enrich（拉近50条视频+LLM异步）。
 * user/detail 不受 item_list 限流影响，item_list 配额只花在通过 bio 门禁的红人上。
 */
import { resolveLiteCdpTabPoolSize } from "../../../scraper/resolve-scraper-mode.js";
import { touchImportTaskLastProgressAt } from "../../../db/influencer-import-task-dao.js";
import { bioLanguageMayMatchCampaign } from "../../../influencer/infer-bio-language.js";
import { extractUserInfoFromUserDetailAPI } from "../extract-user-profile-cdp.js";
import {
  acquireTiktokApiSession,
  fetchUserDetail,
  resolveTiktokLiteEnrichEndpoints,
} from "./tiktok-direct-fetch.js";

function normalizeUsername(u) {
  return String(u || "").replace(/^@/, "").trim();
}

function randomDelayMs() {
  const min = Math.max(0, Number(process.env.TT_LITE_FIRST_VIDEO_DELAY_MIN ?? 1500) || 0);
  const max = Math.max(min, Number(process.env.TT_LITE_FIRST_VIDEO_DELAY_MAX ?? 2000) || min);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * @param {{
 *   influencerRecords?: object[],
 *   allowedCountries?: string[],
 *   onStepUpdate?: Function,
 *   importTaskId?: number|null,
 * }} opts
 * @returns {Promise<{ records: object[], stats: { total: number, passed: number, skipped: number, mismatch: number, unknown: number, failed: number } }>}
 */
export async function resolveImportTiktokBioGate({
  influencerRecords = [],
  allowedCountries = [],
  onStepUpdate = null,
  importTaskId = null,
} = {}) {
  const queue = (influencerRecords || []).filter((r) => normalizeUsername(r.username));
  if (!queue.length) {
    return { records: [], stats: { total: 0, passed: 0, skipped: 0, mismatch: 0, unknown: 0, failed: 0 } };
  }

  const tabPoolSize = resolveLiteCdpTabPoolSize();
  const endpointCandidates = resolveTiktokLiteEnrichEndpoints();
  const explicitEndpointPool =
    String(process.env.TT_LITE_ENRICH_CDP_ENDPOINTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length > 0;
  const desiredEndpoints = explicitEndpointPool
    ? endpointCandidates.slice(0, tabPoolSize)
    : Array.from({ length: tabPoolSize }, () => null);

  if (onStepUpdate) {
    try {
      onStepUpdate({
        type: "step",
        step: { id: "import-bio-gate", status: "running", detail: `bio 语言门禁：${queue.length} 位红人` },
      });
    } catch {
      /* ignore */
    }
  }

  const pool = [];
  for (let i = 0; i < tabPoolSize; i += 1) {
    let session = null;
    let lastErr = null;
    const slotEndpoint = desiredEndpoints[i];
    const candidates = slotEndpoint ? [slotEndpoint] : endpointCandidates;
    for (const endpointKey of candidates) {
      try {
        session = await acquireTiktokApiSession(null, { endpointKey, forceNewTab: false });
        console.log(
          `[resolveImportTiktokBioGate] bio session ${pool.length + 1}/${tabPoolSize} via ${endpointKey}`
        );
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!session && explicitEndpointPool) {
      console.warn(
        `[resolveImportTiktokBioGate] endpoint slot ${i + 1} unavailable${slotEndpoint ? ` endpoint=${slotEndpoint}` : ""}: ${lastErr?.message || lastErr}`
      );
      continue;
    }
    if (!session) {
      throw new Error(
        `TikTok Lite bio 门禁：endpoint pool 全部不可用${lastErr ? `: ${lastErr.message}` : ""}`
      );
    }
    pool.push(session);
  }
  if (!pool.length) {
    throw new Error("TikTok Lite bio 门禁：endpoint pool 全部不可用");
  }

  const { recoverTiktokPageFromAccessDenied, bootstrapTiktokWebSession } = await import(
    "./tiktok-api-client.js"
  );
  for (const session of pool) {
    try {
      const ok = await recoverTiktokPageFromAccessDenied(session.page);
      if (!ok) await bootstrapTiktokWebSession(session.page, { forceRefresh: true });
    } catch (e) {
      console.warn(`[resolveImportTiktokBioGate] session bootstrap: ${e.message}`);
    }
  }

  const stats = { total: queue.length, passed: 0, skipped: 0, mismatch: 0, unknown: 0, failed: 0 };
  const records = [];

  try {
    for (let i = 0; i < queue.length; i += 1) {
      if (importTaskId && i % 5 === 0) {
        try {
          await touchImportTaskLastProgressAt(importTaskId);
        } catch {
          /* ignore */
        }
      }
      const page = pool[i % pool.length].page;
      const handle = normalizeUsername(queue[i].username);
      const progress = `${i + 1}/${queue.length}`;
      let userInfo = null;
      try {
        const detailJson = await fetchUserDetail(page, handle, {});
        userInfo = extractUserInfoFromUserDetailAPI(detailJson);
      } catch (e) {
        userInfo = null;
      }
      if (!userInfo) {
        stats.failed += 1;
        stats.skipped += 1;
        console.log(
          `[resolveImportTiktokBioGate] [${progress}] ⏭️ @${handle} user_detail_fail`
        );
      } else {
        const gate = bioLanguageMayMatchCampaign(userInfo.bio, allowedCountries);
        if (!gate.mayMatch) {
          if (gate.source === "bio_language_mismatch") stats.mismatch += 1;
          else stats.unknown += 1;
          stats.skipped += 1;
          console.log(
            `[resolveImportTiktokBioGate] [${progress}] ⏭️ @${handle} bio=${gate.bioLanguage || "unknown"} (${gate.source})`
          );
        } else {
          stats.passed += 1;
          records.push({
            ...queue[i],
            pregateUserInfo: userInfo,
            bioLanguage: gate.bioLanguage,
            bioGateSource: gate.source,
          });
          console.log(
            `[resolveImportTiktokBioGate] [${progress}] ✅ @${handle} bio=${gate.bioLanguage} (${gate.source})`
          );
        }
      }
      if (i + 1 < queue.length) {
        await new Promise((r) => setTimeout(r, randomDelayMs()));
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

  if (onStepUpdate) {
    try {
      onStepUpdate({
        type: "step",
        step: {
          id: "import-bio-gate",
          status: "completed",
          detail: `bio 门禁：通过 ${stats.passed}/${stats.total}`,
        },
      });
    } catch {
      /* ignore */
    }
  }
  return { records, stats };
}
