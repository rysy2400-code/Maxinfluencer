#!/usr/bin/env node
/**
 * 验证 modify_campaign 改 region 时 countries 与 session context 同步。
 *
 * 用法：node scripts/test-modify-campaign-region-countries.mjs
 * 可选：CAMPAIGN_ID=CAMP-xxx node scripts/test-modify-campaign-region-countries.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getCampaignById, updateCampaign } from "../lib/db/campaign-dao.js";
import {
  getCampaignSessionById,
  updateCampaignSession,
} from "../lib/db/campaign-session-dao.js";
import {
  resolveAllowedCountriesFromCampaign,
} from "../lib/influencer/campaign-country-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const REGION_30 = [
  "澳大利亚",
  "美国",
  "德国",
  "英国",
  "法国",
  "意大利",
  "西班牙",
  "加拿大",
  "阿根廷",
  "乌拉圭",
  "哥斯达黎加",
  "摩洛哥",
  "阿尔及利亚",
  "埃及",
  "突尼斯",
  "利比亚",
  "冰岛",
  "波兰",
  "捷克",
  "斯洛伐克",
  "瑞典",
  "挪威",
  "芬兰",
  "丹麦",
  "荷兰",
  "比利时",
  "葡萄牙",
  "瑞士",
  "奥地利",
  "爱尔兰",
];

const EXPECTED_ISO_FULL = resolveAllowedCountriesFromCampaign({
  region: REGION_30,
});

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

/** 模拟 modifyCampaign 写 region 的核心逻辑 */
async function simulateRegionUpdate(campaignId, newRegion) {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} 不存在`);

  const nextCampaignInfo = { ...(campaign.campaignInfo || {}) };
  nextCampaignInfo.region = newRegion;
  delete nextCampaignInfo.countries;

  await updateCampaign(campaignId, { campaignInfo: nextCampaignInfo });

  const sessionId =
    typeof campaign.sessionId === "string" ? campaign.sessionId.trim() : "";
  if (sessionId) {
    const session = await getCampaignSessionById(sessionId);
    if (session) {
      const prevContext =
        session.context && typeof session.context === "object"
          ? session.context
          : {};
      const refreshed = await getCampaignById(campaignId);
      await updateCampaignSession(sessionId, {
        context: {
          ...prevContext,
          campaignInfo: refreshed?.campaignInfo ?? nextCampaignInfo,
        },
      });
    }
  }

  return getCampaignById(campaignId);
}

async function findCmbCampaignId() {
  if (process.env.CAMPAIGN_ID) return process.env.CAMPAIGN_ID.trim();
  const rows = await queryTikTok(
    `
    SELECT id FROM tiktok_campaign
    WHERE status <> 'deleted'
      AND JSON_UNQUOTE(JSON_EXTRACT(product_info, '$.brandName')) LIKE '%Coffee Meets Bagel%'
    ORDER BY updated_at DESC
    LIMIT 1
  `
  );
  return rows?.[0]?.id || null;
}

async function main() {
  let failed = 0;

  // delete countries + enrich：落库时从 region 重算 ISO
  const stale = { region: REGION_30, countries: ["AU"], platform: ["Instagram"] };
  const next = { ...stale, region: REGION_30 };
  delete next.countries;
  const { enrichCampaignInfoCountryFields } = await import(
    "../lib/influencer/campaign-country-codes.js"
  );
  const enriched = enrichCampaignInfoCountryFields(next);
  const iso = resolveAllowedCountriesFromCampaign(enriched);
  if (iso.length !== 30) {
    console.error("FAIL unit: expected 30 ISO, got", iso);
    failed += 1;
  } else {
    console.log("OK unit: delete countries + enrich → 30 ISO");
  }

  // --- 集成：CMB campaign DB 状态 ---
  const campaignId = await findCmbCampaignId();
  if (!campaignId) {
    console.warn("SKIP integration: 未找到 Coffee Meets Bagel campaign");
    process.exit(failed === 0 ? 0 : 1);
  }

  const before = await getCampaignById(campaignId);
  const beforeIso = resolveAllowedCountriesFromCampaign(before.campaignInfo || {});
  console.log(`\nCampaign ${campaignId} before: countries=${JSON.stringify(beforeIso)}`);

  // 用 SQL 绕过 enrich，注入 stale countries（模拟历史脏数据）
  await queryTikTok(
    `UPDATE tiktok_campaign SET campaign_info = JSON_SET(campaign_info, '$.countries', CAST(? AS JSON)) WHERE id = ?`,
    [JSON.stringify(["AU"]), campaignId]
  );
  const dirtyIso = resolveAllowedCountriesFromCampaign(
    (await getCampaignById(campaignId)).campaignInfo || {}
  );
  assert(dirtyIso.length === 1 && dirtyIso[0] === "AU", "脏数据写入失败");
  console.log("OK setup: 已注入 stale countries=[AU]");

  const after = await simulateRegionUpdate(campaignId, REGION_30);
  const afterIso = resolveAllowedCountriesFromCampaign(after.campaignInfo || {});
  assert(afterIso.length === 30, `countries 应为 30 国，实际 ${afterIso.length}: ${JSON.stringify(afterIso)}`);
  assert(
    JSON.stringify(afterIso) === JSON.stringify(EXPECTED_ISO_FULL),
    `ISO 列表不匹配 expected=${JSON.stringify(EXPECTED_ISO_FULL)} got=${JSON.stringify(afterIso)}`
  );
  console.log("OK integration: simulateRegionUpdate → 30 ISO");

  const session = await getCampaignSessionById(after.sessionId);
  const ctxRegion = session?.context?.campaignInfo?.region;
  const ctxCountries = session?.context?.campaignInfo?.countries;
  const ctxIso = resolveAllowedCountriesFromCampaign(
    session?.context?.campaignInfo || {}
  );
  assert(ctxIso.length === 30, `session context countries 应为 30，实际 ${ctxIso.length}`);
  assert(
    Array.isArray(ctxRegion) ? ctxRegion.length === 30 : false,
    `session context region 应为 30 国数组`
  );
  console.log("OK integration: session context 已同步", {
    regionCount: ctxRegion?.length,
    countries: ctxCountries?.length,
  });

  console.log(
    failed === 0
      ? "\ntest-modify-campaign-region-countries: ALL OK"
      : `\ntest-modify-campaign-region-countries: ${failed} failed`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
