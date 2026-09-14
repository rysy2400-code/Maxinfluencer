/**
 * 把「已经用新链路写入、但还落在平台列」的常住地搬迁到独立列。
 *
 * 背景：worker 早期版本把红人本人确认的常住地写在 video_publish_country
 * （source=email_reply_llm）。改成独立列后需要搬迁一次：
 *   - video_publish_country 的值 → residence_country*（含 relation/evidence/confidence）
 *   - video_publish_country 回退成平台证据值（候选快照 → profile_data → NULL）
 *
 * 用法：
 *   node scripts/migrate-residence-country.mjs            # dry-run
 *   node scripts/migrate-residence-country.mjs --apply
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
const RESIDENCE_SOURCE = "email_reply_llm";

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

/** 平台侧国家：跳过 email 来源，只认平台证据 */
function platformCountry(snapshot, sourceHint = null) {
  const s = parseJson(snapshot);
  if (!s) return null;
  const source = sourceHint || s.videoPublishCountrySource || s.countrySource || null;
  if (source === "email_reply" || source === RESIDENCE_SOURCE) return null;
  for (const key of [
    "videoPublishCountry",
    "video_publish_country",
    "accountCountry",
    "country",
  ]) {
    const iso = usableIso(s[key]);
    if (iso) return { iso, source: source || "platform_snapshot" };
  }
  const pd = parseJson(s.profile_data) || parseJson(s.profileData) || null;
  const iso = usableIso(
    pd?.videoPublishCountry || pd?.userInfo?.country || pd?.accountCountry
  );
  return iso ? { iso, source: source || "profile_data" } : null;
}

async function candidateMap(rows) {
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < campaignIds.length; i += 200) {
    const chunk = campaignIds.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const cands = await queryTikTok(
      `SELECT campaign_id, tiktok_username, influencer_snapshot
       FROM tiktok_campaign_influencer_candidates WHERE campaign_id IN (${ph})`,
      chunk
    );
    for (const c of cands || []) {
      map.set(
        `${c.campaign_id}|${String(c.tiktok_username || "").toLowerCase()}`,
        c.influencer_snapshot
      );
    }
  }
  return map;
}

async function main() {
  const execs = await queryTikTok(
    `SELECT id, campaign_id, tiktok_username, influencer_id, influencer_snapshot
     FROM tiktok_campaign_execution
     WHERE JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot, '$.countrySource')) = ?`,
    [RESIDENCE_SOURCE]
  );
  const influencers = await queryTikTok(
    `SELECT influencer_id, username, video_publish_country, video_publish_country_source,
            profile_data
     FROM TikTok_influencer WHERE video_publish_country_source = ?`,
    [RESIDENCE_SOURCE]
  );

  console.log(
    `待搬迁：执行快照 ${execs.length} 条 / 红人表 ${influencers.length} 行${APPLY ? "" : "（dry-run）"}`
  );
  if (!execs.length && !influencers.length) {
    console.log("没有需要搬迁的数据。");
    process.exit(0);
  }

  const cands = await candidateMap(execs);
  const plan = [];
  for (const e of execs) {
    const snap = parseJson(e.influencer_snapshot) || {};
    const iso = usableIso(snap.videoPublishCountry);
    if (!iso) continue;
    const platform = platformCountry(
      cands.get(`${e.campaign_id}|${String(e.tiktok_username || "").toLowerCase()}`)
    );
    plan.push({
      id: e.id,
      handle: e.tiktok_username,
      influencerId: e.influencer_id,
      iso,
      relation: snap.countryRelation || "self_residence",
      evidence: snap.countryEvidence || null,
      confidence: snap.countryConfidence ?? null,
      platform,
      snap,
    });
  }
  console.log(
    `执行快照搬迁明细: ${plan
      .map((p) => `@${p.handle}→${p.iso}(平台值 ${p.platform?.iso || "无"})`)
      .join(", ") || "无"}`
  );

  const ts = Date.now();
  const backupPath = path.join(
    __dirname,
    `../exports/residence-migration-before-${ts}.csv`
  );
  fs.writeFileSync(
    backupPath,
    [
      "kind,execution_id,handle,influencer_id,residence_country,platform_country,platform_source",
      ...plan.map((p) =>
        ["execution", p.id, p.handle, p.influencerId, p.iso, p.platform?.iso || "", p.platform?.source || ""].join(",")
      ),
      ...influencers.map((i) =>
        ["influencer", "", i.username, i.influencer_id, usableIso(i.video_publish_country) || "", "", ""].join(",")
      ),
    ].join("\n"),
    "utf-8"
  );
  console.log(`搬迁前快照: ${backupPath}`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] 未写入数据库。确认无误后加 --apply 执行。");
    process.exit(0);
  }

  for (const p of plan) {
    const next = { ...p.snap };
    next.residenceCountry = p.iso;
    next.residence_country = p.iso;
    next.residenceCountrySource = RESIDENCE_SOURCE;
    next.residenceCountryRelation = p.relation || null;
    next.residenceCountryEvidence = p.evidence || null;
    next.residenceCountryConfidence = p.confidence ?? null;
    next.residenceCountryUpdatedAt = new Date().toISOString();
    if (p.platform?.iso) {
      next.videoPublishCountry = p.platform.iso;
      next.video_publish_country = p.platform.iso;
      next.videoPublishCountrySource = p.platform.source;
    } else {
      delete next.videoPublishCountry;
      delete next.video_publish_country;
      delete next.videoPublishCountrySource;
    }
    for (const k of [
      "countrySource",
      "countryRaw",
      "countryRelation",
      "countryEvidence",
      "countryConfidence",
      "countryUpdatedAt",
      "countryReplySourceMessageId",
    ]) {
      delete next[k];
    }
    await queryTikTok(
      `UPDATE tiktok_campaign_execution SET influencer_snapshot = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(next), p.id]
    );
  }
  console.log(`执行快照已搬迁: ${plan.length} 条`);

  for (const inf of influencers) {
    const iso = usableIso(inf.video_publish_country);
    if (!iso) continue;
    const pd = parseJson(inf.profile_data);
    const platform = usableIso(
      pd?.videoPublishCountry || pd?.userInfo?.country || pd?.accountCountry
    );
    await queryTikTok(
      `UPDATE TikTok_influencer
       SET residence_country = ?,
           residence_country_source = ?,
           residence_country_checked_at = NOW(),
           video_publish_country = ?,
           video_publish_country_source = ?,
           updated_at = NOW()
       WHERE influencer_id = ?`,
      [iso, RESIDENCE_SOURCE, platform, platform ? "profile_data" : null, inf.influencer_id]
    );
    console.log(
      `红人表搬迁: @${inf.username} residence=${iso}，平台列回退为 ${platform || "NULL"}`
    );
  }

  console.log("搬迁完成。");
  process.exit(0);
}

main().catch((err) => {
  console.error("搬迁失败:", err);
  process.exit(1);
});
