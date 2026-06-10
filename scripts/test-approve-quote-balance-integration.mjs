/**
 * 同意报价扣款 — 五场景集成测试（真实 DB，隔离测试 campaign）
 * 运行：node scripts/test-approve-quote-balance-integration.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import assert from "node:assert/strict";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";
import { approveQuoteWithCharge } from "../lib/billing/approve-quote-charge.js";
import { executeApproveQuote } from "../lib/execution/approve-quote.js";
import { executeCampaignExecutionTool } from "../lib/tools/campaign-execution/campaign-execution-tools.js";
import {
  NON_USD_QUOTE_MESSAGE,
  formatInsufficientBalanceMessage,
} from "../lib/billing/balance-messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMPAIGN_ID = "CAMP-BALANCE-TEST";
const SESSION_ID = "sess-balance-test-001";
const ADVERTISER_ID = 1;
const ADVERTISER_USER_ID = 2;

const HANDLES = {
  sufficient: "bal_test_usd_ok",
  insufficient: "bal_test_usd_low",
  eur: "bal_test_eur",
  commission: "bal_test_comm",
  agent: "bal_test_agent",
};

const PRODUCT_INFO = { brand: "TestBrand", product: "Test", productType: "电商" };
const CAMPAIGN_INFO_ECPM = {
  platform: "TikTok",
  region: "美国",
  influencerPricing: { mode: "ecpm_with_cap", ecpmUsd: 3, maxFlatFeeUsd: 1000 },
};
const CAMPAIGN_INFO_COMM = {
  ...CAMPAIGN_INFO_ECPM,
  influencerPricing: { mode: "commission_only" },
};

async function getBalance(advertiserId) {
  const rows = await queryTikTok(
    `SELECT balance_amount FROM tiktok_advertiser WHERE id = ? LIMIT 1`,
    [advertiserId]
  );
  const n = Number(rows?.[0]?.balance_amount);
  return Number.isFinite(n) ? n : 0;
}

async function setBalance(advertiserId, amount) {
  await queryTikTok(
    `UPDATE tiktok_advertiser SET balance_amount = ?, balance_currency = 'USD' WHERE id = ?`,
    [amount, advertiserId]
  );
}

async function getStage(campaignId, handle) {
  const rows = await queryTikTok(
    `SELECT stage FROM tiktok_campaign_execution WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    [campaignId, ...paramsExecutionCreatorMatch(handle)]
  );
  return rows?.[0]?.stage || null;
}

async function resetExec(handle, { flatFee, currency = "USD" }) {
  await queryTikTok(
    `DELETE FROM tiktok_advertiser_balance_ledger
     WHERE campaign_id = ? AND influencer_id = ?`,
    [CAMPAIGN_ID, handle]
  );
  await queryTikTok(
    `UPDATE tiktok_campaign_execution
     SET stage = 'quote_submitted', flat_fee = ?, currency = ?,
         last_event = JSON_OBJECT('quoteSubmittedAt', UTC_TIMESTAMP())
     WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    [flatFee, currency, CAMPAIGN_ID, ...paramsExecutionCreatorMatch(handle)]
  );
}

async function setupFixture() {
  await queryTikTok(
    `INSERT INTO tiktok_campaign_sessions (id, title, status, messages, context, advertiser_user_id, created_at, updated_at)
     VALUES (?, '余额扣款测试', 'published', '[]', '{}', ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE advertiser_user_id = VALUES(advertiser_user_id), status = 'published'`,
    [SESSION_ID, ADVERTISER_USER_ID]
  );

  await queryTikTok(`DELETE FROM tiktok_advertiser_balance_ledger WHERE campaign_id = ?`, [
    CAMPAIGN_ID,
  ]);
  await queryTikTok(`DELETE FROM tiktok_campaign_execution WHERE campaign_id = ?`, [CAMPAIGN_ID]);
  await queryTikTok(`DELETE FROM tiktok_campaign WHERE id = ?`, [CAMPAIGN_ID]);

  await queryTikTok(
    `INSERT INTO tiktok_campaign (
      id, session_id, platform, region, budget, commission,
      product_info, campaign_info, influencer_profile, content_script,
      influencers_per_day, status
    ) VALUES (?, ?, 'tiktok', 'US', 5000, 10, ?, ?, '{}', '{}', 5, 'running')`,
    [
      CAMPAIGN_ID,
      SESSION_ID,
      JSON.stringify(PRODUCT_INFO),
      JSON.stringify(CAMPAIGN_INFO_ECPM),
    ]
  );

  const rows = [
    [HANDLES.sufficient, 100],
    [HANDLES.insufficient, 500],
    [HANDLES.eur, 300],
    [HANDLES.commission, null],
    [HANDLES.agent, 50],
  ];

  for (const [handle, fee] of rows) {
    const snap = JSON.stringify({ name: handle, username: handle });
    await queryTikTok(
      `INSERT INTO tiktok_campaign_execution (
        campaign_id, tiktok_username, influencer_snapshot, stage, flat_fee, currency, last_event
      ) VALUES (?, ?, ?, 'quote_submitted', ?, ?, '{}')`,
      [
        CAMPAIGN_ID,
        handle,
        snap,
        fee,
        handle === HANDLES.eur ? "EUR" : "USD",
      ]
    );
  }
}

async function testSufficientBalance() {
  console.log("\n[1] 余额充足 → 同意 → 扣款 + stage 推进");
  await queryTikTok(
    `UPDATE tiktok_campaign SET campaign_info = ? WHERE id = ?`,
    [JSON.stringify(CAMPAIGN_INFO_ECPM), CAMPAIGN_ID]
  );
  await resetExec(HANDLES.sufficient, { flatFee: 100 });
  await setBalance(ADVERTISER_ID, 10000);
  const before = await getBalance(ADVERTISER_ID);

  const result = await executeApproveQuote({
    campaignId: CAMPAIGN_ID,
    influencerId: HANDLES.sufficient,
    advertiserId: ADVERTISER_ID,
    advertiserUserId: ADVERTISER_USER_ID,
  });

  assert.equal(result.success, true, "应成功");
  assert.equal(result.chargedAmount, 100);
  assert.equal(result.stage, "pending_sample");

  const after = await getBalance(ADVERTISER_ID);
  assert.equal(after, before - 100, `余额应从 ${before} 变为 ${before - 100}`);
  assert.equal(await getStage(CAMPAIGN_ID, HANDLES.sufficient), "pending_sample");
  console.log("  ✓ 扣款 $100，余额", after, "，stage=pending_sample");
}

async function testInsufficientBalance() {
  console.log("\n[2] 余额不足 → 详版提示，stage 不变");
  await resetExec(HANDLES.insufficient, { flatFee: 500 });
  await setBalance(ADVERTISER_ID, 120);

  const result = await approveQuoteWithCharge({
    campaignId: CAMPAIGN_ID,
    influencerId: HANDLES.insufficient,
    advertiserId: ADVERTISER_ID,
    advertiserUserId: ADVERTISER_USER_ID,
  });

  assert.equal(result.success, false);
  assert.equal(
    result.message,
    formatInsufficientBalanceMessage(500, 120),
    "详版文案应一致"
  );
  assert.equal(await getStage(CAMPAIGN_ID, HANDLES.insufficient), "quote_submitted");
  assert.equal(await getBalance(ADVERTISER_ID), 120);
  console.log("  ✓", result.message);
}

async function testEurQuote() {
  console.log("\n[3] EUR 报价 → 拒绝同意");
  await resetExec(HANDLES.eur, { flatFee: 300, currency: "EUR" });
  const balanceBefore = await getBalance(ADVERTISER_ID);

  const result = await approveQuoteWithCharge({
    campaignId: CAMPAIGN_ID,
    influencerId: HANDLES.eur,
    advertiserId: ADVERTISER_ID,
    advertiserUserId: ADVERTISER_USER_ID,
  });

  assert.equal(result.success, false);
  assert.equal(result.message, NON_USD_QUOTE_MESSAGE);
  assert.equal(await getStage(CAMPAIGN_ID, HANDLES.eur), "quote_submitted");
  assert.equal(await getBalance(ADVERTISER_ID), balanceBefore);
  console.log("  ✓", result.message);
}

async function testCommissionOnlyZeroCharge() {
  console.log("\n[4] commission_only 无 flat_fee → $0 同意成功");
  await queryTikTok(
    `UPDATE tiktok_campaign SET campaign_info = ? WHERE id = ?`,
    [JSON.stringify(CAMPAIGN_INFO_COMM), CAMPAIGN_ID]
  );
  await resetExec(HANDLES.commission, { flatFee: null });
  const balanceBefore = await getBalance(ADVERTISER_ID);

  const result = await executeApproveQuote({
    campaignId: CAMPAIGN_ID,
    influencerId: HANDLES.commission,
    advertiserId: ADVERTISER_ID,
    advertiserUserId: ADVERTISER_USER_ID,
  });

  assert.equal(result.success, true);
  assert.equal(result.chargedAmount, 0);
  assert.equal(result.stage, "pending_sample");
  assert.equal(await getBalance(ADVERTISER_ID), balanceBefore);
  assert.equal(await getStage(CAMPAIGN_ID, HANDLES.commission), "pending_sample");
  console.log("  ✓ $0 扣款，stage=pending_sample");
}

async function testAgentApproveQuote() {
  console.log("\n[5] Agent approve_quote → 与按钮一致扣款");
  await queryTikTok(
    `UPDATE tiktok_campaign SET campaign_info = ? WHERE id = ?`,
    [JSON.stringify(CAMPAIGN_INFO_ECPM), CAMPAIGN_ID]
  );
  await resetExec(HANDLES.agent, { flatFee: 50 });
  const balanceBefore = await getBalance(ADVERTISER_ID);

  const toolResult = await executeCampaignExecutionTool(
    "approve_quote",
    { campaignId: CAMPAIGN_ID, influencerId: HANDLES.agent },
    {
      campaignId: CAMPAIGN_ID,
      advertiserAuth: {
        advertiserId: ADVERTISER_ID,
        advertiserUserId: ADVERTISER_USER_ID,
        isAdmin: false,
        companyName: "MaxinAI",
      },
    }
  );

  assert.equal(toolResult.success, true, toolResult.message || "agent 应成功");
  assert.equal(toolResult.data?.chargedAmount, 50);
  assert.equal(toolResult.data?.stage, "pending_sample");
  assert.equal(await getBalance(ADVERTISER_ID), balanceBefore - 50);
  assert.equal(await getStage(CAMPAIGN_ID, HANDLES.agent), "pending_sample");
  console.log("  ✓ Agent 扣款 $50，余额", await getBalance(ADVERTISER_ID));
}

async function main() {
  const originalBalance = await getBalance(ADVERTISER_ID);
  console.log("准备测试夹具…（原 MaxinAI 余额:", originalBalance, "）");
  await setupFixture();

  try {
    await testSufficientBalance();
    await testInsufficientBalance();
    await testEurQuote();
    await testCommissionOnlyZeroCharge();
    await testAgentApproveQuote();
    console.log("\n✅ 全部 5 项集成测试通过");
  } finally {
    await setBalance(ADVERTISER_ID, originalBalance);
    console.log("已恢复 MaxinAI 余额为", originalBalance);
  }
}

main().catch((e) => {
  console.error("\n❌ 测试失败:", e.message);
  console.error(e);
  process.exit(1);
});
