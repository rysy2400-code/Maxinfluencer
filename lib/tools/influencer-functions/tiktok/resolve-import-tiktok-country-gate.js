/**
 * Lite 导入 Phase 2（国家门禁）：bio 语言/邮箱通过后，对每人取首视频抓 locationCreated：
 * - 明确国家：匹配投放地区保留，mismatch 跳过（省视频/LLM 流量）
 * - 国家未知：bio 语言已在 Phase 1 匹配 → 保留（走 bio 推断）
 * 每红人成本：item_list(count=1) + 移动 UA 视频 HTML(~40KB)
 */
import { resolveLiteCdpTabPoolSize } from "../../../scraper/resolve-scraper-mode.js";
import { touchImportTaskLastProgressAt } from "../../../db/influencer-import-task-dao.js";
import {
  acquireTiktokApiSession,
  fetchPostItemList,
  resolveTiktokLiteEnrichEndpoints,
} from "./tiktok-direct-fetch.js";
import { passesCampaignCountry } from "../resolve-video-publish-country.js";
import { resolveVideoLocationCreatedForInfluencer } from "./tiktok-direct-fetch.js";

function normalizeUsername(u) {
  return String(u || "").replace(/^@/, "").trim();
}

function randomDelayMs() {
  const min = Math.max(0, Number(process.env.TT_LITE_FIRST_VIDEO_DELAY_MIN ?? 1000) || 0);
  const max = Math.max(min, Number(process.env.TT_LITE_FIRST_VIDEO_DELAY_MAX ?? 1500) || min);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * @param {{ records?: object[], allowedCountries?: string[], importTaskId?: number|null, onStepUpdate?: Function }} opts
 * @returns {Promise<{ records: object[], stats: { total: number, passed: number, mismatch: number, unknown: number, failed: number } }>}
 */
export async function resolveImportTiktokCountryGate({
  records = [],
  allowedCountries = [],
  importTaskId = null,
  onStepUpdate = null,
} = {}) {
  const queue = (records || []).filter((r) => normalizeUsername(r.username));
  const stats = { total: queue.length, passed: 0, mismatch: 0, unknown: 0, failed: 0 };
  if (!queue.length) return { records: [], stats };

  const tabPoolSize = resolveLiteCdpTabPoolSize();
  const endpointCandidates = resolveTiktokLiteEnrichEndpoints();
  const pool = [];
  for (let i = 0; i < tabPoolSize; i += 1) {
    try {
      const session = await acquireTiktokApiSession(null, {
        endpointKey: endpointCandidates[i % endpointCandidates.length],
        forceNewTab: false,
      });
      pool.push(session);
      console.log(`[resolveImportTiktokCountryGate] country session ${pool.length}/${tabPoolSize}`);
    } catch (e) {
      console.warn(`[resolveImportTiktokCountryGate] session ${i + 1} unavailable: ${e?.message || e}`);
    }
  }
  if (!pool.length) {
    throw new Error("TikTok Lite 国家门禁：endpoint pool 全部不可用");
  }

  const out = [];
  try {
    for (let i = 0; i < queue.length; i += 1) {
      if (importTaskId && i % 5 === 0) {
        try {
          await touchImportTaskLastProgressAt(importTaskId);
        } catch {
          /* ignore */
        }
      }
      const rec = queue[i];
      const handle = normalizeUsername(rec.username);
      const page = pool[i % pool.length].page;
      const secUid =
        rec.secUid ||
        rec.tiktokSecUid ||
        rec.pregateUserInfo?.secUid ||
        rec.pregateUserInfo?.userId?.secUid ||
        "";
      let firstVideoId = "";
      try {
        const list = await fetchPostItemList(page, {
          secUid,
          count: 1,
          referer: `https://www.tiktok.com/@${handle}`,
        });
        const items = list?.itemList || list?.item_list || [];
        firstVideoId = String(items?.[0]?.id || items?.[0]?.videoId || "");
      } catch (e) {
        stats.failed += 1;
        console.log(`[resolveImportTiktokCountryGate] [${i + 1}/${queue.length}] ⏭️ @${handle} item_list_fail ${String(e?.message || e).slice(0, 80)}`);
        continue;
      }
      if (!firstVideoId) {
        // 无视频（首条都拿不到）→ 视为无法判定，bio 已匹配则保留（不重复拉 50 条空数据）
        stats.unknown += 1;
        console.log(`[resolveImportTiktokCountryGate] [${i + 1}/${queue.length}] ⏭️ @${handle} no_first_video keep_by_bio`);
        out.push(rec);
        continue;
      }
      let loc = null;
      try {
        const probe = await resolveVideoLocationCreatedForInfluencer(page, {
          videoId: firstVideoId,
          username: handle,
        });
        loc = probe?.locationCreated || null;
      } catch {
        loc = null;
      }
      if (loc) {
        if (passesCampaignCountry(loc, allowedCountries)) {
          stats.passed += 1;
          console.log(`[resolveImportTiktokCountryGate] [${i + 1}/${queue.length}] ✅ @${handle} country=${loc} match`);
        } else {
          stats.mismatch += 1;
          console.log(`[resolveImportTiktokCountryGate] [${i + 1}/${queue.length}] ⏭️ @${handle} country=${loc} mismatch（省视频/LLM）`);
          continue;
        }
      } else {
        // 国家未知 → bio 已语言匹配 → 保留
        stats.unknown += 1;
        console.log(`[resolveImportTiktokCountryGate] [${i + 1}/${queue.length}] ✅ @${handle} country_unknown keep_by_bio`);
      }
      out.push({
        ...rec,
        representativeVideoId: firstVideoId,
        video_publish_country: loc,
      });
      if (i + 1 < queue.length) {
        await new Promise((r) => setTimeout(r, randomDelayMs()));
      }
    }
  } finally {
    for (const s of pool) {
      try {
        await s.dispose();
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
          id: "import-country-gate",
          status: "completed",
          detail: `国家门禁：保留 ${out.length}/${queue.length}`,
        },
      });
    } catch {
      /* ignore */
    }
  }
  return { records: out, stats };
}
