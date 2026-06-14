/**
 * 将 TikTok_influencer.video_publish_country 同步进 execution influencer_snapshot
 * 用法: node scripts/sync-execution-snapshot-country.mjs --campaign CAMP-xxx
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

function parseJson(v) {
  if (v == null) return {};
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

async function main() {
  const campaignId = process.argv.includes("--campaign")
    ? process.argv[process.argv.indexOf("--campaign") + 1]
    : "CAMP-1780390702505-LQFEI5RJE";

  const rows = await queryTikTok(
    `
    SELECT e.tiktok_username, e.influencer_snapshot, ti.video_publish_country
    FROM tiktok_campaign_execution e
    LEFT JOIN TikTok_influencer ti ON ti.username = e.tiktok_username
    WHERE e.campaign_id = ?
      AND e.stage IN ('pending_quote', 'quote_submitted', 'quote_rejected')
      AND ti.video_publish_country IS NOT NULL
      AND ti.video_publish_country != ''
  `,
    [campaignId]
  );

  let updated = 0;
  for (const row of rows || []) {
    const iso = String(row.video_publish_country).trim();
    const snap = parseJson(row.influencer_snapshot);
    if (snap.videoPublishCountry === iso) continue;
    const next = { ...snap, videoPublishCountry: iso };
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET influencer_snapshot = ?, updated_at = NOW()
      WHERE campaign_id = ? AND tiktok_username = ?
    `,
      [JSON.stringify(next), campaignId, row.tiktok_username]
    );
    updated += 1;
    console.log(`  @${row.tiktok_username} → ${iso}`);
  }
  console.log(`[sync] updated ${updated}/${rows?.length || 0} snapshots`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
