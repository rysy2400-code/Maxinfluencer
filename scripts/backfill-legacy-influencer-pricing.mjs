#!/usr/bin/env node
/**
 * 存量保护：给缺失 influencerPricing 字段的 campaign 显式补旧默认
 * （ecpm_with_cap, eCPM=$3, 上限 $1000），防止默认策略改为
 * 「不主动报价，询问红人合作价格」后，存量 campaign 在归一化回退时被新默认影响。
 *
 * 运行（默认只读巡检，不改数据）:
 *   node scripts/backfill-legacy-influencer-pricing.mjs
 *
 * 确认后执行回填:
 *   node scripts/backfill-legacy-influencer-pricing.mjs --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  PRICING_MODE_ASK_CREATOR_QUOTE,
  PRICING_MODE_COMMISSION_ONLY,
  DEFAULT_ECPM_USD,
  DEFAULT_MAX_FLAT_FEE_USD,
  PRICING_MODE_ECPM_WITH_CAP,
} from "../lib/campaign/influencer-pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const APPLY = process.argv.includes("--apply");
const KNOWN_MODES = new Set([
  PRICING_MODE_ASK_CREATOR_QUOTE,
  PRICING_MODE_COMMISSION_ONLY,
  PRICING_MODE_ECPM_WITH_CAP,
]);

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function main() {
  const rows = await queryTikTok(
    `SELECT id, campaign_info FROM tiktok_campaign WHERE deleted_at IS NULL`
  );

  const missing = [];
  for (const row of rows || []) {
    const ci = parseJson(row.campaign_info);
    if (!ci || typeof ci !== "object") continue;
    const ip = ci.influencerPricing;
    if (!ip || typeof ip !== "object") {
      missing.push({ id: row.id, campaignInfo: ci, reason: "缺失 influencerPricing" });
    } else if (!KNOWN_MODES.has(ip.mode)) {
      missing.push({
        id: row.id,
        campaignInfo: ci,
        reason: `未知 mode=${ip.mode}`,
      });
    }
  }

  console.log(
    `共 ${rows?.length || 0} 个未删除 campaign，缺失 influencerPricing 的 ${missing.length} 个`
  );
  if (missing.length === 0) {
    console.log("无需回填。");
    return;
  }

  for (const { id, reason } of missing) {
    console.log(`  - ${id} (${reason})`);
  }

  if (!APPLY) {
    console.log(
      "\n这是只读巡检，未修改任何数据。确认后执行: node scripts/backfill-legacy-influencer-pricing.mjs --apply"
    );
    return;
  }

  const legacy = {
    mode: PRICING_MODE_ECPM_WITH_CAP,
    ecpmUsd: DEFAULT_ECPM_USD,
    maxFlatFeeUsd: DEFAULT_MAX_FLAT_FEE_USD,
  };

  let done = 0;
  for (const { id, campaignInfo } of missing) {
    const next = { ...campaignInfo, influencerPricing: legacy };
    await queryTikTok(
      `UPDATE tiktok_campaign SET campaign_info = ? WHERE id = ?`,
      [JSON.stringify(next), id]
    );
    done += 1;
  }
  console.log(`\n已回填 ${done} 个 campaign：${JSON.stringify(legacy)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 巡检/回填失败:", err?.message || err);
    process.exit(1);
  });
