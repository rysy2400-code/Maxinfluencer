/**
 * 回滚「邮件回信规则误判国家」的存量数据。
 *
 * 背景：旧版 syncCountryFromReply 用正则全文扫回信，把裸的两字母 ISO 码当国家，例如
 *   - "Here is my ID: 7229..."      → ID（印尼）
 *   - "Best regards, AI Xentra"     → AI（安圭拉）
 * 受影响的执行快照 countrySource='email_reply' 且 countryRaw 是两字母码，共 261 条。
 *
 * 回滚规则（已与业务确认）：
 *   1) 执行快照：优先用同 campaign+username 的候选快照里的平台值恢复
 *      → 退回该红人 profile_data 里的平台值 → 都没有则清空；
 *   2) 红人表 video_publish_country：取该红人所有非 email_reply 平台证据中最新的一条，
 *      没有证据则置 NULL；
 *   3) shinwamystery 单独手工置 JP（bloks_about_api）。
 *
 * 用法：
 *   node scripts/rollback-bare-iso-email-reply-country.mjs            # dry-run，只打印
 *   node scripts/rollback-bare-iso-email-reply-country.mjs --apply    # 真正写库
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

/** 手工修正：红人本人常住地已由业务确认（同 campaign 目标国 JP） */
const MANUAL_FIXES = [
  { handle: "shinwamystery", iso: "JP", source: "bloks_about_api" },
];

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function usableIso(raw) {
  if (isUnknownCountryValue(raw)) return null;
  return normalizeInfluencerCountryToIso(raw);
}

/** 从任意 snapshot 里取平台侧国家（跳过 email_reply 遗留值） */
function platformCountryFromSnapshot(snapshot, sourceHint = null) {
  const s = parseJson(snapshot);
  if (!s) return null;
  const source = sourceHint || s.videoPublishCountrySource || s.countrySource || null;
  if (source === LEGACY_SOURCE) return null;
  for (const key of [
    "videoPublishCountry",
    "video_publish_country",
    "accountCountry",
    "country",
    "countryCode",
  ]) {
    const iso = usableIso(s[key]);
    if (iso) return { iso, source: source || "platform_snapshot" };
  }
  const pd = parseJson(s.profile_data) || parseJson(s.profileData) || null;
  if (pd) {
    const iso = usableIso(
      pd.videoPublishCountry || pd.userInfo?.country || pd.accountCountry
    );
    if (iso) return { iso, source: source || "profile_data" };
  }
  return null;
}

async function loadTargets() {
  return queryTikTok(
    `SELECT id, campaign_id, tiktok_username, influencer_id, influencer_snapshot, updated_at
     FROM tiktok_campaign_execution
     WHERE JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countrySource')) = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countryRaw')) REGEXP '^[A-Za-z]{2}$'`,
    [LEGACY_SOURCE]
  );
}

async function loadInfluencerEvidence(influencerIds) {
  /** @type {Map<string, Array<{iso:string, source:string, ts:number}>>} */
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
      `SELECT influencer_id, influencer_snapshot, created_at, updated_at
       FROM tiktok_campaign_influencer_candidates
       WHERE influencer_id IN (${ph})`,
      chunk
    );
    for (const r of cands || []) {
      const hit = platformCountryFromSnapshot(r.influencer_snapshot);
      if (hit) {
        push(r.influencer_id, {
          iso: hit.iso,
          source: hit.source,
          ts: new Date(r.updated_at || r.created_at || 0).getTime() || 0,
        });
      }
    }

    const execs = await queryTikTok(
      `SELECT influencer_id, influencer_snapshot, updated_at
       FROM tiktok_campaign_execution
       WHERE influencer_id IN (${ph})`,
      chunk
    );
    for (const r of execs || []) {
      const hit = platformCountryFromSnapshot(r.influencer_snapshot);
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
       FROM TikTok_influencer
       WHERE influencer_id IN (${ph})`,
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
      const pd = parseJson(r.profile_data);
      const iso = usableIso(
        pd?.videoPublishCountry || pd?.userInfo?.country || pd?.accountCountry
      );
      if (iso) {
        push(r.influencer_id, { iso, source: "profile_data", ts: 1 });
      }
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.ts - a.ts);
  return map;
}

async function main() {
  const targets = await loadTargets();
  console.log(`命中待回滚执行快照: ${targets.length} 条${APPLY ? "" : "（dry-run）"}`);

  const influencerIds = targets.map((t) => t.influencer_id);
  const evidence = await loadInfluencerEvidence(influencerIds);

  const campaignIds = [...new Set(targets.map((t) => t.campaign_id).filter(Boolean))];
  const candidateByKey = new Map();
  for (let i = 0; i < campaignIds.length; i += 200) {
    const chunk = campaignIds.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const cands = await queryTikTok(
      `SELECT campaign_id, tiktok_username, influencer_snapshot
       FROM tiktok_campaign_influencer_candidates
       WHERE campaign_id IN (${ph})`,
      chunk
    );
    for (const c of cands || []) {
      candidateByKey.set(
        `${c.campaign_id}|${String(c.tiktok_username || "").toLowerCase()}`,
        c.influencer_snapshot
      );
    }
  }

  const rows = [];
  for (const t of targets) {
    let restored = platformCountryFromSnapshot(
      candidateByKey.get(
        `${t.campaign_id}|${String(t.tiktok_username || "").toLowerCase()}`
      )
    );
    if (!restored) {
      restored =
        (evidence.get(t.influencer_id) || []).find(() => true) || null;
    }
    const snapshot = parseJson(t.influencer_snapshot) || {};
    rows.push({
      id: t.id,
      campaignId: t.campaign_id,
      handle: t.tiktok_username,
      influencerId: t.influencer_id,
      beforeCountry: snapshot.videoPublishCountry || null,
      beforeRaw: snapshot.countryRaw || null,
      afterCountry: restored?.iso || null,
      afterSource: restored?.source || null,
      snapshot,
    });
  }

  const withRestore = rows.filter((r) => r.afterCountry).length;
  const toNull = rows.length - withRestore;
  console.log(`  可恢复平台值: ${withRestore} 条 / 清空: ${toNull} 条`);
  const byAfter = new Map();
  for (const r of rows) {
    const k = r.afterCountry || "(null)";
    byAfter.set(k, (byAfter.get(k) || 0) + 1);
  }
  console.log(
    "  恢复后分布:",
    [...byAfter.entries()].map(([k, v]) => `${k}=${v}`).join("  ")
  );

  // 红人列回写计划
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
    `../exports/country-rollback-before-${ts}.csv`
  );
  const csv = [
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
  ].join("\n");
  fs.writeFileSync(backupPath, csv, "utf-8");
  console.log(`  回滚前快照已导出: ${backupPath}`);

  const manualPlan = [];
  for (const fix of MANUAL_FIXES) {
    const rowsFound = await queryTikTok(
      `SELECT influencer_id, username, video_publish_country, video_publish_country_source
       FROM TikTok_influencer WHERE username = ? OR LOWER(username) = ?`,
      [fix.handle, fix.handle.toLowerCase()]
    );
    for (const r of rowsFound || []) {
      manualPlan.push({ ...fix, influencerId: r.influencer_id });
    }
    console.log(
      `  手工修正 @${fix.handle} → ${fix.iso}/${fix.source}（命中 ${rowsFound?.length || 0} 行）`
    );
  }

  if (!APPLY) {
    console.log("\n[DRY-RUN] 未写入数据库。确认无误后加 --apply 执行。");
    process.exit(0);
  }

  let execUpdated = 0;
  for (const r of rows) {
    const next = { ...r.snapshot };
    if (r.afterCountry) {
      next.videoPublishCountry = r.afterCountry;
      next.video_publish_country = r.afterCountry;
      next.videoPublishCountrySource = r.afterSource || RESTORE_SOURCE;
      next.countrySource = r.afterSource || RESTORE_SOURCE;
    } else {
      delete next.videoPublishCountry;
      delete next.video_publish_country;
      delete next.videoPublishCountrySource;
      delete next.countrySource;
    }
    delete next.countryRaw;
    delete next.countryConfidence;
    delete next.countryRelation;
    delete next.countryEvidence;
    delete next.countryReplySourceMessageId;
    await queryTikTok(
      `UPDATE tiktok_campaign_execution SET influencer_snapshot = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(next), r.id]
    );
    execUpdated += 1;
  }
  console.log(`执行快照已回滚: ${execUpdated} 条`);

  let inflUpdated = 0;
  for (const [influencerId, best] of influencerPlan.entries()) {
    if (!influencerId) continue;
    if (best?.iso) {
      await queryTikTok(
        `UPDATE TikTok_influencer
         SET video_publish_country = ?, video_publish_country_source = ?,
             video_publish_country_checked_at = NOW(), updated_at = NOW()
         WHERE influencer_id = ? AND video_publish_country_source = ?`,
        [best.iso, best.source || RESTORE_SOURCE, influencerId, LEGACY_SOURCE]
      );
    } else {
      await queryTikTok(
        `UPDATE TikTok_influencer
         SET video_publish_country = NULL, video_publish_country_source = NULL,
             video_publish_country_checked_at = NULL, updated_at = NOW()
         WHERE influencer_id = ? AND video_publish_country_source = ?`,
        [influencerId, LEGACY_SOURCE]
      );
    }
    inflUpdated += 1;
  }
  console.log(`红人表已回写: ${inflUpdated} 条`);

  for (const fix of manualPlan) {
    await queryTikTok(
      `UPDATE TikTok_influencer
       SET video_publish_country = ?, video_publish_country_source = ?,
           video_publish_country_checked_at = NOW(), updated_at = NOW()
       WHERE influencer_id = ?`,
      [fix.iso, fix.source, fix.influencerId]
    );
    const execs = await queryTikTok(
      `SELECT id, influencer_snapshot FROM tiktok_campaign_execution WHERE influencer_id = ?`,
      [fix.influencerId]
    );
    for (const e of execs || []) {
      const snap = parseJson(e.influencer_snapshot) || {};
      const next = {
        ...snap,
        videoPublishCountry: fix.iso,
        video_publish_country: fix.iso,
        countrySource: fix.source,
        videoPublishCountrySource: fix.source,
        countryUpdatedAt: new Date().toISOString(),
      };
      delete next.countryRaw;
      delete next.countryConfidence;
      delete next.countryRelation;
      delete next.countryEvidence;
      await queryTikTok(
        `UPDATE tiktok_campaign_execution SET influencer_snapshot = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(next), e.id]
      );
    }
    console.log(
      `手工修正完成: @${fix.handle} → ${fix.iso}（执行记录 ${execs?.length || 0} 条）`
    );
  }

  console.log("回滚完成。");
  // MySQL 连接池会吊住事件循环，显式退出
  process.exit(0);
}

main().catch((err) => {
  console.error("回滚失败:", err);
  process.exit(1);
});
