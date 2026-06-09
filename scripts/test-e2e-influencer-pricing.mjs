#!/usr/bin/env node
/**
 * 端到端验证：两种单位红人报价策略 → 首封邀约 → flat_fee 落库 + 邮件正文
 *
 * 运行: node scripts/test-e2e-influencer-pricing.mjs
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { upsertInfluencer, getInfluencerById } from "../lib/db/influencer-dao.js";
import { sendOutreach } from "../lib/agents/influencer-agent.js";
import {
  PRICING_MODE_COMMISSION_ONLY,
  PRICING_MODE_ECPM_WITH_CAP,
  computeQuotedFlatFeeUsd,
} from "../lib/campaign/influencer-pricing.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TEST_INFLUENCER_ID = "e2e_pricing_test_1";
const TEST_USERNAME = "e2e_pricing_creator";
const TEST_EMAIL = "rysy2400@gmail.com";
const AVG_VIEWS = 100000; // eCPM=3 → $300 flat fee

const ts = Date.now();
const CAMPAIGN_ECPM = `E2E-PRICING-ECPM-${ts}`;
const CAMPAIGN_COMM = `E2E-PRICING-COMM-${ts}`;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function ensureInfluencer() {
  await upsertInfluencer({
    influencerId: TEST_INFLUENCER_ID,
    platform: "tiktok",
    region: "US",
    username: TEST_USERNAME,
    displayName: "E2E Pricing Test",
    avatarUrl: null,
    profileUrl: `https://www.tiktok.com/@${TEST_USERNAME}`,
    followerCount: 50000,
    avgViews: AVG_VIEWS,
    influencerEmail: TEST_EMAIL,
    source: "e2e_test",
    sourceRef: null,
    sourcePayload: null,
    lastFetchedAt: new Date(),
  });
}

async function insertCampaign({
  id,
  campaignInfo,
  productInfo,
}) {
  await queryTikTok(
    `
    INSERT INTO tiktok_campaign (
      id, session_id, platform, region, budget, commission,
      product_info, campaign_info, influencer_profile, content_script,
      influencers_per_day, status, created_at, updated_at
    ) VALUES (?, ?, 'tiktok', 'US', ?, ?, ?, ?, '{}', '{}', 5, 'running', NOW(), NOW())
  `,
    [
      id,
      `sess-${id}`,
      campaignInfo.budget,
      campaignInfo.commission,
      JSON.stringify(productInfo),
      JSON.stringify(campaignInfo),
    ]
  );
}

async function ensureExecutionRow(campaignId) {
  const snapshot = {
    influencerId: TEST_INFLUENCER_ID,
    username: TEST_USERNAME,
    displayName: "E2E Pricing Test",
    views: { avg: AVG_VIEWS, display: "100K" },
    influencerEmail: TEST_EMAIL,
  };

  await queryTikTok(
    `
    INSERT INTO tiktok_campaign_execution (
      campaign_id, tiktok_username, influencer_id, influencer_snapshot,
      stage, last_event, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending_quote', NULL, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      influencer_snapshot = VALUES(influencer_snapshot),
      flat_fee = NULL,
      last_event = NULL,
      updated_at = NOW()
  `,
    [
      campaignId,
      TEST_USERNAME,
      TEST_INFLUENCER_ID,
      JSON.stringify(snapshot),
    ]
  );

  return snapshot;
}

async function cleanupConversation(campaignId) {
  await queryTikTok(
    `DELETE FROM tiktok_influencer_conversation_messages
     WHERE campaign_id = ? AND influencer_id = ? AND source_type = 'seed_outreach'`,
    [campaignId, TEST_INFLUENCER_ID]
  );
}

async function getExecutionState(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT flat_fee, currency, last_event
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(TEST_USERNAME)]
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    flatFee: row.flat_fee != null ? Number(row.flat_fee) : null,
    currency: row.currency,
    lastEvent: parseJson(row.last_event),
  };
}

async function getLatestOutreachBody(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT body_text, subject, sent_at
    FROM tiktok_influencer_conversation_messages
    WHERE campaign_id = ? AND influencer_id = ? AND source_type = 'seed_outreach'
    ORDER BY id DESC LIMIT 1
  `,
    [campaignId, TEST_INFLUENCER_ID]
  );
  return rows?.[0] || null;
}

async function runScenario({
  label,
  campaignId,
  campaignInfo,
  expectFlatFee,
  emailMustNotContain = [],
  emailMustContain = [],
}) {
  console.log(`\n========== 场景: ${label} ==========`);

  const productInfo = {
    brandName: "E2E Brand",
    productName: "E2E Product",
    productLink: "https://example.com/e2e-product",
  };

  await insertCampaign({ id: campaignId, campaignInfo, productInfo });
  const snapshot = await ensureExecutionRow(campaignId);
  await cleanupConversation(campaignId);

  const expectedQuote = computeQuotedFlatFeeUsd(AVG_VIEWS, campaignInfo.influencerPricing);
  console.log(`  预期首封 flat fee: ${expectedQuote ?? "null"}`);
  assert(expectedQuote === expectFlatFee, `报价计算 = ${expectFlatFee ?? "null"}`);

  let outreachResult;
  try {
    outreachResult = await sendOutreach({
      campaignId,
      platformInfluencerId: TEST_INFLUENCER_ID,
      tiktokUsername: TEST_USERNAME,
      snapshot,
    });
    console.log(`  发信结果: messageId=${outreachResult?.messageId || "—"} dedup=${!!outreachResult?.deduplicated}`);
  } catch (err) {
    console.error(`  发信失败: ${err.message}`);
    failed += 1;
    return;
  }

  assert(!outreachResult?.deduplicated, "首封未命中幂等跳过");

  const exec = await getExecutionState(campaignId);
  console.log(`  DB flat_fee=${exec?.flatFee ?? "null"} currency=${exec?.currency ?? "—"}`);

  if (expectFlatFee != null) {
    assert(exec?.flatFee === expectFlatFee, `flat_fee 落库 = $${expectFlatFee}`);
    assert(
      exec?.lastEvent?.outreachEmail?.quotedFlatFeeUsd === expectFlatFee,
      `last_event.outreachEmail.quotedFlatFeeUsd = $${expectFlatFee}`
    );
    assert(
      exec?.lastEvent?.outreachEmail?.pricingMode === PRICING_MODE_ECPM_WITH_CAP,
      "last_event 记录 pricingMode=ecpm_with_cap"
    );
  } else {
    assert(exec?.flatFee == null, "flat_fee 未写入（commission_only）");
    assert(
      exec?.lastEvent?.outreachEmail?.pricingMode === PRICING_MODE_COMMISSION_ONLY,
      "last_event 记录 pricingMode=commission_only"
    );
  }

  const msg = await getLatestOutreachBody(campaignId);
  assert(!!msg?.body_text, "对话表存在 seed_outreach 邮件正文");

  if (msg?.body_text) {
    const body = String(msg.body_text);
    const lower = body.toLowerCase();
    for (const token of emailMustContain) {
      assert(
        lower.includes(String(token).toLowerCase()),
        `邮件正文包含「${token}」`
      );
    }
    for (const token of emailMustNotContain) {
      assert(
        !lower.includes(String(token).toLowerCase()),
        `邮件正文不含「${token}」`
      );
    }
    console.log(`  邮件摘要 (前 280 字):\n  ${body.slice(0, 280).replace(/\n/g, " ")}…`);
  }
}

async function cleanupCampaigns() {
  for (const id of [CAMPAIGN_ECPM, CAMPAIGN_COMM]) {
    await cleanupConversation(id);
    await queryTikTok(
      `DELETE FROM tiktok_campaign_execution WHERE campaign_id = ?`,
      [id]
    );
    await queryTikTok(`DELETE FROM tiktok_campaign WHERE id = ?`, [id]);
  }
}

async function main() {
  console.log("端到端验证：单位红人报价策略 → 首封邮件 + flat_fee\n");
  console.log(`测试红人: ${TEST_INFLUENCER_ID} → ${TEST_EMAIL}`);
  console.log(`平均播放量: ${AVG_VIEWS.toLocaleString()}\n`);

  await ensureInfluencer();
  const inf = await getInfluencerById(TEST_INFLUENCER_ID);
  assert(!!inf?.influencerEmail, "测试红人邮箱已配置");

  try {
    await runScenario({
      label: "策略 A — eCPM=$3，上限 $1000",
      campaignId: CAMPAIGN_ECPM,
      campaignInfo: {
        platform: "TikTok",
        region: "美国",
        publishTimeRange: "2026-07-01 至 2026-07-31",
        budget: 50000,
        commission: 15,
        influencerPricing: {
          mode: PRICING_MODE_ECPM_WITH_CAP,
          ecpmUsd: 3,
          maxFlatFeeUsd: 1000,
        },
      },
      expectFlatFee: 300,
      emailMustContain: ["300", "15"],
      emailMustNotContain: [],
    });

    await runScenario({
      label: "策略 B — 无固定费用，仅佣金 20%",
      campaignId: CAMPAIGN_COMM,
      campaignInfo: {
        platform: "TikTok",
        region: "美国",
        publishTimeRange: "2026-08-01 至 2026-08-31",
        budget: 30000,
        commission: 20,
        influencerPricing: {
          mode: PRICING_MODE_COMMISSION_ONLY,
          ecpmUsd: 3,
          maxFlatFeeUsd: 1000,
        },
      },
      expectFlatFee: null,
      emailMustContain: ["20", "commission"],
      emailMustNotContain: ["$300", "300 usd fixed"],
    });
  } finally {
    console.log("\n清理测试 campaign…");
    await cleanupCampaigns();
  }

  console.log(`\n========== 汇总: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
