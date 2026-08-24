/**
 * Phase 1 状态机单元测试（无 DB 依赖）
 * 运行：node scripts/test-stage-transition.mjs
 */
import {
  resolveInfluencerAgentUpdate,
  EXECUTION_STAGES,
} from "../lib/execution/stage-transition.js";
import { resolveNeedSample } from "../lib/execution/need-sample.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error("FAIL:", msg);
}

const quoteApproved = { quoteApprovedAt: "2026-01-01T00:00:00.000Z" };
const scriptApproved = {
  ...quoteApproved,
  scriptApprovedAt: "2026-03-01T00:00:00.000Z",
};
const draftApproved = {
  ...quoteApproved,
  draftApprovedAt: "2026-06-01T00:00:00.000Z",
};

// 允许的阶段跳转
assert(
  resolveInfluencerAgentUpdate({
    currentStage: EXECUTION_STAGES.PENDING_QUOTE,
    requestedStage: EXECUTION_STAGES.QUOTE_SUBMITTED,
    lastEventRaw: {},
  }).effectiveStage === EXECUTION_STAGES.QUOTE_SUBMITTED,
  "pending_quote → quote_submitted"
);

assert(
  resolveInfluencerAgentUpdate({
    currentStage: EXECUTION_STAGES.PENDING_SCRIPT,
    requestedStage: EXECUTION_STAGES.SCRIPT_REVIEW,
    lastEventRaw: quoteApproved,
  }).effectiveStage === EXECUTION_STAGES.SCRIPT_REVIEW,
  "pending_script → script_review"
);

assert(
  resolveInfluencerAgentUpdate({
    currentStage: EXECUTION_STAGES.PENDING_VIDEO,
    requestedStage: EXECUTION_STAGES.VIDEO_REVIEW,
    lastEventRaw: scriptApproved,
  }).effectiveStage === EXECUTION_STAGES.VIDEO_REVIEW,
  "pending_video → video_review"
);

assert(
  resolveInfluencerAgentUpdate({
    currentStage: EXECUTION_STAGES.PENDING_SHIPPING_ADDRESS,
    requestedStage: EXECUTION_STAGES.PENDING_SAMPLE,
    lastEventRaw: quoteApproved,
  }).effectiveStage === EXECUTION_STAGES.PENDING_SAMPLE,
  "pending_shipping_address → pending_sample"
);

// 越权拦截
for (const to of [
  EXECUTION_STAGES.PENDING_SAMPLE,
  EXECUTION_STAGES.PENDING_SCRIPT,
  EXECUTION_STAGES.PUBLISHED,
]) {
  const r = resolveInfluencerAgentUpdate({
    currentStage: EXECUTION_STAGES.QUOTE_SUBMITTED,
    requestedStage: to,
    lastEventRaw: {},
  });
  assert(
    r.effectiveStage === EXECUTION_STAGES.QUOTE_SUBMITTED && r.skippedStageReason,
    `quote_submitted 不可 → ${to}`
  );
}

// 报价阶段红人主动给地址：不写本次 execution 快照，由邮件 worker 写红人级记忆
const shipCase = resolveInfluencerAgentUpdate({
  currentStage: EXECUTION_STAGES.QUOTE_SUBMITTED,
  requestedStage: EXECUTION_STAGES.PENDING_SAMPLE,
  lastEventRaw: {},
});
assert(
  shipCase.effectiveStage === EXECUTION_STAGES.QUOTE_SUBMITTED &&
    !shipCase.allowShippingInfoUpdate,
  "报价未确认时 pending_sample 请求被拦且不写 execution shipping"
);

// 已发布仅更新链接
const pubCase = resolveInfluencerAgentUpdate({
  currentStage: EXECUTION_STAGES.PUBLISHED,
  requestedStage: EXECUTION_STAGES.PUBLISHED,
  lastEventRaw: draftApproved,
});
assert(pubCase.allowVideoLinkUpdate, "published 可更新 videoLink");

const pubBlocked = resolveInfluencerAgentUpdate({
  currentStage: EXECUTION_STAGES.SCRIPT_REVIEW,
  requestedStage: EXECUTION_STAGES.PUBLISHED,
  lastEventRaw: quoteApproved,
});
assert(
  pubBlocked.effectiveStage === EXECUTION_STAGES.SCRIPT_REVIEW,
  "script_review 不可直接 published"
);

// needSample 兜底
assert(resolveNeedSample({ productType: "应用" }) === false, "应用不需寄样");
assert(resolveNeedSample({ productType: "游戏" }) === false, "游戏不需寄样");
assert(resolveNeedSample({ productType: "电商" }) === true, "电商需寄样");
assert(resolveNeedSample({ needSample: false, productType: "电商" }) === false, "显式 needSample 优先");

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
