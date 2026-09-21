/**
 * 回填 Instagram 红人的「主页简介语言」到 tiktok_influencer_language。
 *
 * 背景：ins 专属机器上跑的是旧版 worker，enrich 阶段没有把 bioLanguage 写进
 * 候选快照、也没有写语言旁路表，导致前端卡片「语言」列大面积显示 —。
 * 这里按 ins 候选池的 influencer_id 回查主档 bio，重新推断语言并补写旁路表。
 *
 * 用法：
 *   node scripts/backfill-ins-bio-language.mjs --dry-run
 *   node scripts/backfill-ins-bio-language.mjs --apply
 *   node scripts/backfill-ins-bio-language.mjs --apply --limit 5000
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { detectBioLanguageProfile } from "../lib/influencer/infer-bio-language.js";
import { INFLUENCER_LANGUAGE_TABLE } from "../lib/influencer/influencer-language-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY || process.argv.includes("--dry-run");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  const n = i >= 0 ? Number(process.argv[i + 1]) : null;
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const CHUNK = 500;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  // 1) 取出 ins 候选池里的全部红人 id（避免大表 join，先取集合再分片比对）
  const candRows = await queryTikTok(
    `SELECT DISTINCT influencer_id
     FROM tiktok_campaign_influencer_candidates
     WHERE platform = 'instagram'
       AND influencer_id IS NOT NULL
       AND influencer_id <> ''
     ${LIMIT ? `LIMIT ${LIMIT}` : ""}`
  );
  const candIds = [...new Set((candRows || [])
    .map((r) => String(r.influencer_id || "").trim())
    .filter(Boolean))];
  console.log(`[ins-backfill] ins 候选红人 ${candIds.length} 个，开始比对语言表...`);

  // 2) 分片查询语言表，找出缺记录的红人
  const haveLang = new Set();
  for (const idsChunk of chunk(candIds, CHUNK)) {
    const rows = await queryTikTok(
      `SELECT influencer_id FROM ${INFLUENCER_LANGUAGE_TABLE}
       WHERE influencer_id IN (${idsChunk.map(() => "?").join(",")})`,
      idsChunk
    );
    for (const r of rows || []) haveLang.add(String(r.influencer_id || "").trim());
  }
  const ids = candIds.filter((id) => !haveLang.has(id));
  console.log(
    `[ins-backfill] 缺语言的 ins 候选红人 ${ids.length} 个${DRY_RUN ? "（dry-run）" : "（apply）"}`
  );
  if (!ids.length) return;

  let scanned = 0;
  let withBio = 0;
  let detected = 0;
  const distribution = {};
  const pending = [];

  for (const idsChunk of chunk(ids, CHUNK)) {
    const rows = await queryTikTok(
      `SELECT influencer_id, bio
       FROM tiktok_influencer
       WHERE influencer_id IN (${idsChunk.map(() => "?").join(",")})`,
      idsChunk
    );
    for (const r of rows || []) {
      scanned += 1;
      const bio = r.bio == null ? "" : String(r.bio);
      if (!bio.trim()) continue;
      withBio += 1;
      const hit = detectBioLanguageProfile(bio);
      if (!hit.language) continue;
      detected += 1;
      distribution[hit.language] = (distribution[hit.language] || 0) + 1;
      pending.push({
        influencerId: String(r.influencer_id),
        language: hit.language,
        confidence: hit.confidence,
        source: hit.source,
      });
    }
  }

  console.log(
    `[ins-backfill] 读到主档 ${scanned} 个；有 bio ${withBio} 个；识别出语言 ${detected} 个`
  );
  const top = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  console.log(`[ins-backfill] 语言分布（前 15）：${top}`);

  if (DRY_RUN) {
    console.log("[ins-backfill] dry-run 结束，未写库。加 --apply 执行。");
    return;
  }

  let written = 0;
  for (const batch of chunk(pending, 200)) {
    const values = batch.map(() => "(?, ?, ?, ?, NOW(), NOW())").join(",");
    const params = [];
    for (const p of batch) {
      params.push(p.influencerId, p.language, p.confidence, p.source);
    }
    await queryTikTok(
      `INSERT INTO ${INFLUENCER_LANGUAGE_TABLE}
         (influencer_id, bio_language, bio_language_confidence, bio_language_source,
          bio_language_checked_at, updated_at)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
         bio_language = VALUES(bio_language),
         bio_language_confidence = VALUES(bio_language_confidence),
         bio_language_source = VALUES(bio_language_source),
         bio_language_checked_at = NOW(),
         updated_at = NOW()`,
      params
    );
    written += batch.length;
    if (written % 2000 === 0) {
      console.log(`[ins-backfill] 已写入 ${written}/${pending.length}`);
    }
  }
  console.log(`✅ [ins-backfill] 完成，写入 ${written} 行`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ [ins-backfill] 失败:", err?.message || err);
    process.exit(1);
  });
