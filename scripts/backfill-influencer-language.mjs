/**
 * 回填「红人主页简介语言」到 tiktok_influencer_language。
 *
 * 范围：只回填进入过 Campaign 执行表的红人（几万量级），避免全表扫 600 万行大表。
 * 语言来源：TikTok_influencer.bio（爬虫已存的简介文本）。
 *
 * 用法：
 *   node scripts/backfill-influencer-language.mjs --dry-run
 *   node scripts/backfill-influencer-language.mjs --apply
 *   node scripts/backfill-influencer-language.mjs --apply --limit 2000
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
  const idRows = await queryTikTok(
    `SELECT DISTINCT influencer_id
     FROM tiktok_campaign_execution
     WHERE influencer_id IS NOT NULL AND influencer_id <> ''
     ${LIMIT ? `LIMIT ${LIMIT}` : ""}`
  );
  const ids = (idRows || [])
    .map((r) => String(r.influencer_id || "").trim())
    .filter(Boolean);
  console.log(
    `[backfill-language] 目标红人 ${ids.length} 个${DRY_RUN ? "（dry-run，不写库）" : "（apply）"}`
  );

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
    `[backfill-language] 命中主档 ${scanned} 个；有 bio ${withBio} 个；识别出语言 ${detected} 个`
  );
  const top = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  console.log(`[backfill-language] 语言分布（前 15）：${top}`);

  if (DRY_RUN) {
    console.log("[backfill-language] dry-run 结束，未写库。加 --apply 执行。");
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
      console.log(`[backfill-language] 已写入 ${written}/${pending.length}`);
    }
  }
  console.log(`✅ [backfill-language] 完成，写入 ${written} 行`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ backfill-language 失败:", err?.message || err);
    process.exit(1);
  });
