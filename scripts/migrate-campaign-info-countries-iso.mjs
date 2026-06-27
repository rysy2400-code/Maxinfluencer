/**
 * 一次性：为历史 tiktok_campaign 补齐 campaign_info.countries（ISO），
 * 并将 region 列同步为首个 ISO。保留 campaign_info.region 中文展示字段不变。
 *
 * 用法：node scripts/migrate-campaign-info-countries-iso.mjs
 *       node scripts/migrate-campaign-info-countries-iso.mjs --dry-run
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  enrichCampaignInfoCountryFields,
  primaryRegionIsoFromCampaignInfo,
  normalizeAllowedCountries,
  resolveAllowedCountriesFromCampaign,
} from "../lib/influencer/campaign-country-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const dryRun = process.argv.includes("--dry-run");

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function main() {
  const rows = await queryTikTok(
    `SELECT id, region, campaign_info FROM tiktok_campaign WHERE status <> 'deleted'`
  );
  console.log(
    `[migrate-campaign-info-countries-iso] ${dryRun ? "DRY RUN" : "APPLY"} rows=${rows?.length || 0}`
  );

  let updated = 0;
  let skipped = 0;

  for (const row of rows || []) {
    const id = row.id;
    const info = parseJson(row.campaign_info) || {};
    const storedCountries = normalizeAllowedCountries(info?.countries);
    // region 为展示源；历史数据可能 region 已扩多国但 countries 仍留旧 ISO，迁移时以 region 重算
    const enriched = enrichCampaignInfoCountryFields({
      ...info,
      countries: undefined,
    });
    const afterCountries = resolveAllowedCountriesFromCampaign(enriched, null);

    if (!afterCountries.length) {
      console.warn(`  skip ${id}: 无法从 region 解析 ISO`, info.region);
      skipped += 1;
      continue;
    }

    const same =
      JSON.stringify(storedCountries) === JSON.stringify(afterCountries) &&
      String(row.region || "").toUpperCase() === afterCountries[0];

    if (same) {
      skipped += 1;
      continue;
    }

    const regionIso = primaryRegionIsoFromCampaignInfo(enriched);
    console.log(
      `  ${id}: region列 ${row.region} → ${regionIso}, countries ${JSON.stringify(storedCountries)} → ${JSON.stringify(afterCountries)}, region展示保留 ${JSON.stringify(enriched.region)}`
    );

    if (!dryRun) {
      await queryTikTok(
        `UPDATE tiktok_campaign SET campaign_info = ?, region = ? WHERE id = ?`,
        [JSON.stringify(enriched), regionIso, id]
      );
    }
    updated += 1;
  }

  console.log(
    `[migrate-campaign-info-countries-iso] done updated=${updated} skipped=${skipped}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
