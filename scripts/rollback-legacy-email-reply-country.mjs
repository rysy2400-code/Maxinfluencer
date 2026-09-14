/**
 * 回滚「邮件回信正则误判国家」的存量数据（legacy countrySource='email_reply'）。
 *
 * 背景：旧版 syncCountryFromReply 用正则全文扫回信，把国家名/裸 ISO 码当国家，例如
 *   - "Here is my ID: 7229..."                → ID（印尼）
 *   - "Best regards, AI Xentra"               → AI（安圭拉）
 *   - "your clients come from China region?"  → CN（问的是对方 agency）
 *
 * 回滚规则（已与业务确认）：
 *   1) 执行快照：优先用同 campaign+username 的候选快照的平台值恢复
 *      → 退回该红人 profile_data 的平台值 → 都没有则清空；
 *   2) 红人表 video_publish_country：取该红人所有非 email 来源的平台证据里最新的一条，
 *      没有证据则置 NULL；
 *   3) shinwamystery 单独手工置 JP（bloks_about_api）。
 *
 * ⚠️ 快照可能十几 MB，全部用 MySQL JSON_SET/JSON_REMOVE 在服务端就地更新，
 *    不把整份 JSON 取回 Node（否则会 OOM）。
 *
 * 用法：
 *   node scripts/rollback-legacy-email-reply-country.mjs                     # dry-run（只回滚裸 ISO 误判）
 *   node scripts/rollback-legacy-email-reply-country.mjs --scope all         # dry-run（全部 legacy email_reply）
 *   node scripts/rollback-legacy-email-reply-country.mjs --scope all --apply
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  normalizeInfluencerCountryToIso,
  isUnknownCountryValue,
} from "../lib/influencer/campaign-country-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const LEGACY_SOURCE = "email_reply";
const RESTORE_SOURCE = "platform_restore";
/** bare = 只回滚裸两字母 ISO 误判；all = 回滚全部 legacy email_reply */
const SCOPE = process.argv.includes("--scope")
  ? String(process.argv[process.argv.indexOf("--scope") + 1] || "bare")
  : "bare";

/** 手工修正：红人本人常住地已由业务确认（同 campaign 目标国 JP） */
const MANUAL_FIXES = [
  { handle: "shinwamystery", iso: "JP", source: "bloks_about_api" },
];

function usableIso(raw) {
  if (isUnknownCountryValue(raw)) return null;
  return normalizeInfluencerCountryToIso(raw);
}

/** 从「已抽取的小字段」判断该 snapshot 的平台国家是否可用 */
function platformFromExtract({ country, countrySource, legacySource = LEGACY_SOURCE }) {
  const iso = usableIso(country);
  if (!iso) return null;
  const src = countrySource || null;
  if (src === legacySource) return null;
  return { iso, source: src || "platform_snapshot" };
}

async function loadTargets() {
  const bareIsoFilter =
    SCOPE === "all"
      ? ""
      : ` AND JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countryRaw')) REGEXP '^[A-Za-z]{2}$'`;
  return queryTikTok(
    `SELECT id, campaign_id, tiktok_username, influencer_id,
            JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountry')) AS before_country,
            JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countryRaw')) AS before_raw
     FROM tiktok_campaign_execution
     WHERE JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countrySource')) = ?${bareIsoFilter}`,
    [LEGACY_SOURCE]
  );
}

/**
 * 每个红人的「非邮件来源」平台证据（只取小字段，避免大 JSON 进内存）。
 * @returns {Map<string, Array<{iso:string, source:string, ts:number}>>}
 */
async function loadInfluencerEvidence(influencerIds) {
  const map = new Map();
  const push = (id, entry) => {
    if (!id) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(entry);
  };
  const ids = [...new Set(influencerIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");

    const cands = await queryTikTok(
      `SELECT influencer_id,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountry')) AS country,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountrySource')) AS src1,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countrySource')) AS src2,
              created_at, updated_at
       FROM tiktok_campaign_influencer_candidates
       WHERE influencer_id IN (${ph})`,
      chunk
    );
    for (const r of cands || []) {
      const hit = platformFromExtract({
        country: r.country,
        countrySource: r.src1 || r.src2,
      });
      if (hit) {
        push(r.influencer_id, {
          iso: hit.iso,
          source: hit.source,
          ts: new Date(r.updated_at || r.created_at || 0).getTime() || 0,
        });
      }
    }

    const execs = await queryTikTok(
      `SELECT influencer_id,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountry')) AS country,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountrySource')) AS src1,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countrySource')) AS src2,
              updated_at
       FROM tiktok_campaign_execution
       WHERE influencer_id IN (${ph})`,
      chunk
    );
    for (const r of execs || []) {
      const hit = platformFromExtract({
        country: r.country,
        countrySource: r.src1 || r.src2,
      });
      if (hit) {
        push(r.influencer_id, {
          iso: hit.iso,
          source: hit.source,
          ts: new Date(r.updated_at || 0).getTime() || 0,
        });
      }
    }

    const infls = await queryTikTok(
      `SELECT influencer_id, username, profile_data, video_publish_country,
              video_publish_country_source, video_publish_country_checked_at
       FROM TikTok_influencer WHERE influencer_id IN (${ph})`,
      chunk
    );
    for (const r of infls || []) {
      if (r.video_publish_country_source !== LEGACY_SOURCE) {
        const iso = usableIso(r.video_publish_country);
        if (iso) {
          push(r.influencer_id, {
            iso,
            source: r.video_publish_country_source || "platform_column",
            ts: new Date(r.video_publish_country_checked_at || 0).getTime() || 0,
          });
        }
      }
      let pd = r.profile_data;
      if (typeof pd === "string") {
        try {
          pd = JSON.parse(pd);
        } catch {
          pd = null;
        }
      }
      const iso = usableIso(
        pd?.videoPublishCountry || pd?.userInfo?.country || pd?.accountCountry
      );
      if (iso) push(r.influencer_id, { iso, source: "profile_data", ts: 1 });
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.ts - a.ts);
  return map;
}

async function loadCandidateCountries(targets) {
  const campaignIds = [...new Set(targets.map((t) => t.campaign_id).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < campaignIds.length; i += 200) {
    const chunk = campaignIds.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const cands = await queryTikTok(
      `SELECT campaign_id, tiktok_username,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountry')) AS country,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.videoPublishCountrySource')) AS src1,
              JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countrySource')) AS src2
       FROM tiktok_campaign_influencer_candidates
       WHERE campaign_id IN (${ph})`,
      chunk
    );
    for (const c of cands || []) {
      map.set(
        `${c.campaign_id}|${String(c.tiktok_username || "").toLowerCase()}`,
        { country: c.country, countrySource: c.src1 || c.src2 }
      );
    }
  }
  return map;
}

/** 服务端就地改 snapshot，避免把大 JSON 取回 Node */
async function applyExecutionSnapshot(executionId, restored, extraRemoveKeys = []) {
  const removeKeys = [
    "$.countryRaw",
    "$.countryConfidence",
    "$.countryRelation",
    "$.countryEvidence",
    "$.countryReplySourceMessageId",
    ...extraRemoveKeys,
  ];
  if (restored?.iso) {
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
       SET influencer_snapshot = JSON_REMOVE(
             JSON_SET(COALESCE(influencer_snapshot, JSON_OBJECT()),
               '$.videoPublishCountry', ?,
               '$.video_publish_country', ?,
               '$.videoPublishCountrySource', ?,
               '$.countrySource', ?),
             ${removeKeys.map(() => "?").join(",")}
           ),
           updated_at = NOW()
       WHERE id = ?`,
      [
        restored.iso,
        restored.iso,
        restored.source || RESTORE_SOURCE,
        restored.source || RESTORE_SOURCE,
        ...removeKeys,
        executionId,
      ]
    );
  } else {
    await queryTikTok(
      `UPDATE tiktok_campaign_execution
       SET influencer_snapshot = JSON_REMOVE(
             COALESCE(influencer_snapshot, JSON_OBJECT()),
             ${[...removeKeys, "$.videoPublishCountry", "$.video_publish_country", "$.videoPublishCountrySource", "$.countrySource"]
               .map(() => "?")
               .join(",")}
           ),
           updated_at = NOW()
       WHERE id = ?`,
      [
        ...removeKeys,
        "$.videoPublishCountry",
        "$.video_publish_country",
        "$.videoPublishCountrySource",
        "$.countrySource",
        executionId,
      ]
    );
  }
}

async function main() {
  const targets = await loadTargets();
  console.log(
    `命中待回滚执行快照: ${targets.length} 条（scope=${SCOPE}）${APPLY ? "" : "（dry-run）"}`
  );

  // 红人计划独立于「剩余待回滚执行」：连接中断后续跑时，快照可能已清空，
  // 但红人表可能仍是 legacy 来源，这里直接按来源补扫，保证可重入。
  const legacyInfluencers = await queryTikTok(
    `SELECT influencer_id FROM TikTok_influencer WHERE video_publish_country_source = ?`,
    [LEGACY_SOURCE]
  );
  const influencerIds = [
    ...new Set([
      ...targets.map((t) => t.influencer_id),
      ...(legacyInfluencers || []).map((r) => r.influencer_id),
    ]),
  ];
  const evidence = await loadInfluencerEvidence(influencerIds);
  const candidateCountries = await loadCandidateCountries(targets);

  const rows = [];
  for (const t of targets) {
    const fromCandidate = platformFromExtract(
      candidateCountries.get(
        `${t.campaign_id}|${String(t.tiktok_username || "").toLowerCase()}`
      ) || {}
    );
    const restored =
      fromCandidate || (evidence.get(t.influencer_id) || []).find(() => true) || null;
    rows.push({
      id: t.id,
      campaignId: t.campaign_id,
      handle: t.tiktok_username,
      influencerId: t.influencer_id,
      beforeCountry: t.before_country || null,
      beforeRaw: t.before_raw || null,
      afterCountry: restored?.iso || null,
      afterSource: restored?.source || null,
    });
  }

  const withRestore = rows.filter((r) => r.afterCountry).length;
  console.log(`  可恢复平台值: ${withRestore} 条 / 清空: ${rows.length - withRestore} 条`);
  const byAfter = new Map();
  for (const r of rows) {
    const k = r.afterCountry || "(null)";
    byAfter.set(k, (byAfter.get(k) || 0) + 1);
  }
  console.log(
    "  恢复后分布:",
    [...byAfter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join("  ")
  );

  const influencerPlan = new Map();
  for (const influencerId of new Set(influencerIds.filter(Boolean))) {
    influencerPlan.set(influencerId, evidence.get(influencerId)?.[0] || null);
  }
  const planWithValue = [...influencerPlan.values()].filter((v) => v?.iso).length;
  console.log(
    `  红人表回写计划: ${influencerPlan.size} 条（恢复平台值 ${planWithValue} / 置 NULL ${influencerPlan.size - planWithValue}）`
  );

  const ts = Date.now();
  const backupPath = path.join(
    __dirname,
    `../exports/legacy-email-reply-rollback-before-${ts}.csv`
  );
  fs.writeFileSync(
    backupPath,
    [
      "execution_id,campaign_id,handle,influencer_id,before_country,before_raw,after_country,after_source",
      ...rows.map((r) =>
        [
          r.id,
          r.campaignId,
          r.handle,
          r.influencerId,
          r.beforeCountry || "",
          r.beforeRaw || "",
          r.afterCountry || "",
          r.afterSource || "",
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n"),
    "utf-8"
  );
  console.log(`  回滚前快照已导出: ${backupPath}`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] 未写入数据库。确认无误后加 --apply 执行。");
    process.exit(0);
  }

  for (const r of rows) {
    try {
      await applyExecutionSnapshot(r.id, r.afterCountry ? r : null);
    } catch (err) {
      console.warn(`  执行快照 ${r.id} 回滚失败（跳过，可重跑）:`, err?.message || err);
    }
  }
  console.log(`执行快照已回滚: ${rows.length} 条`);

  let inflUpdated = 0;
  for (const [influencerId, best] of influencerPlan.entries()) {
    if (!influencerId) continue;
    if (best?.iso) {
      try {
        await queryTikTok(
          `UPDATE TikTok_influencer
           SET video_publish_country = ?, video_publish_country_source = ?,
               video_publish_country_checked_at = NOW(), updated_at = NOW()
           WHERE influencer_id = ? AND video_publish_country_source = ?`,
          [best.iso, best.source || RESTORE_SOURCE, influencerId, LEGACY_SOURCE]
        );
      } catch (err) {
        console.warn(`  红人 ${influencerId} 回写失败（跳过，可重跑）:`, err?.message || err);
        continue;
      }
    } else {
      try {
        await queryTikTok(
          `UPDATE TikTok_influencer
           SET video_publish_country = NULL, video_publish_country_source = NULL,
               video_publish_country_checked_at = NULL, updated_at = NOW()
           WHERE influencer_id = ? AND video_publish_country_source = ?`,
          [influencerId, LEGACY_SOURCE]
        );
      } catch (err) {
        console.warn(`  红人 ${influencerId} 置 NULL 失败（跳过，可重跑）:`, err?.message || err);
        continue;
      }
    }
    inflUpdated += 1;
  }
  console.log(`红人表已回写: ${inflUpdated} 条`);

  for (const fix of MANUAL_FIXES) {
    const rowsFound = await queryTikTok(
      `SELECT influencer_id FROM TikTok_influencer WHERE username = ?`,
      [fix.handle]
    );
    for (const r of rowsFound || []) {
      await queryTikTok(
        `UPDATE TikTok_influencer
         SET video_publish_country = ?, video_publish_country_source = ?,
             video_publish_country_checked_at = NOW(), updated_at = NOW()
         WHERE influencer_id = ?`,
        [fix.iso, fix.source, r.influencer_id]
      );
      const execs = await queryTikTok(
        `SELECT id FROM tiktok_campaign_execution WHERE influencer_id = ?`,
        [r.influencer_id]
      );
      for (const e of execs || []) {
        await applyExecutionSnapshot(e.id, { iso: fix.iso, source: fix.source });
      }
      console.log(
        `手工修正完成: @${fix.handle} → ${fix.iso}（执行记录 ${execs?.length || 0} 条）`
      );
    }
  }

  console.log("回滚完成。");
  process.exit(0);
}

main().catch((err) => {
  console.error("回滚失败:", err);
  process.exit(1);
});
