/**
 * 关键词信号池 DB 集成测试（ingest → prompt → consume）。
 * 用法: node scripts/test-keyword-signals-db.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  ingestKeywordSignalsFromRecommendedInfluencer,
  getPromptKeywordSignals,
  consumeKeywordSignalForSearch,
  normalizeSignalMatchKey,
} from "../lib/db/campaign-keyword-signals-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TEST_CAMPAIGN_ID = `test-kw-signals-${Date.now()}`;
const PLATFORM = "tiktok";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function cleanup() {
  await queryTikTok(
    `DELETE FROM tiktok_campaign_keyword_signal_contributor WHERE campaign_id = ?`,
    [TEST_CAMPAIGN_ID]
  );
  await queryTikTok(
    `DELETE FROM tiktok_campaign_keyword_signals WHERE campaign_id = ?`,
    [TEST_CAMPAIGN_ID]
  );
}

async function main() {
  await cleanup();

  const influencerA = {
    isRecommended: true,
    username: "poolcreator_a",
    platform: PLATFORM,
    profile_data: {
      videos: [{ description: "hack #saltwaterpool @beatbot" }],
    },
  };
  const influencerB = {
    isRecommended: true,
    username: "poolcreator_b",
    platform: PLATFORM,
    profile_data: {
      videos: [{ description: "day #saltwaterpool #poolmaintenance" }],
    },
  };

  const r1 = await ingestKeywordSignalsFromRecommendedInfluencer(TEST_CAMPAIGN_ID, influencerA, {
    productInfo: {},
  });
  const r2 = await ingestKeywordSignalsFromRecommendedInfluencer(TEST_CAMPAIGN_ID, influencerB, {
    productInfo: {},
  });
  assert(r1.ingested >= 2, "influencer A ingested signals");
  assert(r2.ingested >= 2, "influencer B ingested signals");

  const rows = await queryTikTok(
    `
    SELECT signal_value AS v, influencer_count AS c
    FROM tiktok_campaign_keyword_signals
    WHERE campaign_id = ? AND platform = ? AND signal_type = 'hashtag'
      AND signal_value = '#saltwaterpool'
  `,
    [TEST_CAMPAIGN_ID, PLATFORM]
  );
  assert(rows?.[0]?.c === 2, `#saltwaterpool influencer_count should be 2, got ${rows?.[0]?.c}`);

  const promptSignals = await getPromptKeywordSignals(TEST_CAMPAIGN_ID, PLATFORM);
  assert(promptSignals.length >= 2, "prompt should have signals");
  assert(
    promptSignals[0].signal_value === "#saltwaterpool",
    "top signal should be #saltwaterpool by influencer_count"
  );

  const consumeZero = await consumeKeywordSignalForSearch({
    campaignId: TEST_CAMPAIGN_ID,
    platform: PLATFORM,
    keyword: "saltwaterpool",
    newRecommendedCount: 0,
  });
  assert(consumeZero.consumed === true, "consume by normalized keyword");

  const afterConsume = await getPromptKeywordSignals(TEST_CAMPAIGN_ID, PLATFORM);
  assert(
    !afterConsume.some((s) => normalizeSignalMatchKey(s.signal_value) === "saltwaterpool"),
    "consumed signal should be excluded during cooldown"
  );

  await cleanup();
  console.log("✅ keyword-signals DB integration tests passed");
}

main().catch(async (err) => {
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  console.error("❌", err?.message || err);
  process.exit(1);
});
