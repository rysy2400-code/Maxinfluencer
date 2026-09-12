/**
 * 受控验证：合同 Additional Terms / 版本升级 / 自动发送 全链路。
 * 隔离环境：已删除的测试 campaign CAMP-BALANCE-TEST + 测试红人 test_rysy_1。
 *
 * 用法：
 *   node scripts/test-contract-flow.mjs setup          # 建/重置测试执行行
 *   node scripts/test-contract-flow.mjs state          # 查看当前执行行与合同版本
 *   node scripts/test-contract-flow.mjs r1             # 生成并发首版（R1）
 *   node scripts/test-contract-flow.mjs update1        # 应用新增条款 -> 自动发 R2
 *   node scripts/test-contract-flow.mjs update1-again  # 同 source 重复应用（应幂等跳过）
 *   node scripts/test-contract-flow.mjs update2        # 应用固定条款覆盖 -> 自动发 R3
 *   node scripts/test-contract-flow.mjs update3        # 再改付款条款 -> 自动发 R4（验证邮件不复述旧条款）
 *
 * 注意：会向测试邮箱 rysy2400@gmail.com 真实发信；执行行落在已删除的 CAMP-BALANCE-TEST，不影响线上。
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { applyContractUpdate } from "../lib/contract/apply-contract-update.js";
import { enqueueContractEmail } from "../lib/contract/enqueue-contract-email.js";

const CAMPAIGN_ID = "CAMP-BALANCE-TEST";
const HANDLE = "rysy_test_creator";
const INFLUENCER_ID = "test_rysy_1";

function pj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function showState() {
  const rows = await queryTikTok(
    `SELECT id, campaign_id, tiktok_username, influencer_id, stage, flat_fee, currency, quote_origin, last_event
       FROM tiktok_campaign_execution WHERE campaign_id = ? AND tiktok_username = ?`,
    [CAMPAIGN_ID, HANDLE]
  );
  const le = pj(rows?.[0]?.last_event) || {};
  console.log(
    JSON.stringify(
      {
        execId: rows?.[0]?.id,
        stage: rows?.[0]?.stage,
        flatFee: rows?.[0]?.flat_fee,
        contractRevision: le.contractRevision ?? null,
        contractAdditionalTerms: le.contractAdditionalTerms ?? null,
        contractSectionOverrides: le.contractSectionOverrides ?? null,
        contractAppliedUpdates: le.contractAppliedUpdates ?? null,
      },
      null,
      2
    )
  );
}

async function setup() {
  const lastEvent = {
    createdBy: "controlled_test",
    createdAt: new Date().toISOString(),
    note: "受控验证：合同 Additional Terms / 版本升级 / 自动发送全链路",
  };
  const snapshot = {
    username: HANDLE,
    displayName: "Rysy Test",
    platform: "TikTok",
    profileUrl: `https://www.tiktok.com/@${HANDLE}`,
    email: "rysy2400@gmail.com",
  };
  await queryTikTok(
    `INSERT INTO tiktok_campaign_execution
       (campaign_id, tiktok_username, influencer_id, stage, flat_fee, currency, quote_origin, source, influencer_snapshot, last_event)
     VALUES (?, ?, ?, 'pending_video', 100.00, 'USD', 'creator_quote', 'manual_test', ?, ?)
     ON DUPLICATE KEY UPDATE
       influencer_id = VALUES(influencer_id),
       stage = VALUES(stage),
       flat_fee = VALUES(flat_fee),
       currency = VALUES(currency),
       quote_origin = VALUES(quote_origin),
       influencer_snapshot = VALUES(influencer_snapshot),
       last_event = VALUES(last_event)`,
    [CAMPAIGN_ID, HANDLE, INFLUENCER_ID, JSON.stringify(snapshot), JSON.stringify(lastEvent)]
  );
  console.log("setup done");
  await showState();
}

async function r1() {
  const enq = await enqueueContractEmail({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    platformInfluencerId: INFLUENCER_ID,
  });
  console.log("R1 enqueued eventId:", enq.eventId);
  await showState();
}

async function update1() {
  const r = await applyContractUpdate({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    platformInfluencerId: INFLUENCER_ID,
    contractUpdate: {
      sourceSpecialRequestId: "SR-TEST-TERMS-1",
      additionalTerms: [
        "The copyright of the video and the underlying script remains with the Creator. The Agency and the brand may feature the published video on the brand's official website as part of the project showcase. Any paid promotion of the video requires the Creator's prior written consent.",
      ],
      changeSummary:
        "the copyright of the video and the underlying script remains with you as the Creator, and any paid promotion requires your prior written consent",
    },
  });
  console.log("update1 result:", JSON.stringify(r));
  await showState();
}

async function update1Again() {
  const r = await applyContractUpdate({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    platformInfluencerId: INFLUENCER_ID,
    contractUpdate: {
      sourceSpecialRequestId: "SR-TEST-TERMS-1",
      additionalTerms: ["Should NOT be appended again."],
    },
  });
  console.log("update1-again result:", JSON.stringify(r));
  await showState();
}

async function update2() {
  const r = await applyContractUpdate({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    platformInfluencerId: INFLUENCER_ID,
    contractUpdate: {
      sourceSpecialRequestId: "SR-TEST-TERMS-2",
      sectionOverrides: {
        paymentTiming:
          "3.2 Payment Timing. The Fee shall be paid within seven (7) days after the Deliverables go live (i.e., after the video is published).",
      },
      changeSummary: "the payment timeline was shortened to seven days after the video goes live",
    },
  });
  console.log("update2 result:", JSON.stringify(r));
  await showState();
}

async function update3() {
  const r = await applyContractUpdate({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    platformInfluencerId: INFLUENCER_ID,
    contractUpdate: {
      sourceSpecialRequestId: "SR-TEST-TERMS-3",
      sectionOverrides: {
        paymentTiming:
          "3.2 Payment Timing. The Fee shall be paid within ten (10) days after the Deliverables go live (i.e., after the video is published).",
      },
      changeSummary: "the payment timeline was updated to ten days after the video goes live",
    },
  });
  console.log("update3 result:", JSON.stringify(r));
  await showState();
}

const stage = process.argv[2] || "state";
const fn = { setup, state: showState, r1, update1, "update1-again": update1Again, update2, update3 }[stage];
if (!fn) {
  console.error("未知阶段:", stage);
  process.exit(1);
}
fn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERR", e?.stack || e);
    process.exit(1);
  });
