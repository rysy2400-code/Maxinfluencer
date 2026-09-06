/**
 * Worker 层回归测试：generateAdvertiserFollowupBody 必须把 action 透传给正文生成函数。
 *
 * 回归背景：commit 8f1c6db 引入发送前兜底 wrapper 时漏传 action，
 * 导致 rejectQuote/submitQuote 等跟进邮件失去动作语义（如“拒绝报价”被写成
 * “品牌已同意报价”）。此测试不调用 LLM、不连库，只验证 worker 的 wrapper 参数链路。
 *
 * 运行：node scripts/test-advertiser-followup-worker-guard.mjs
 */
import assert from "node:assert/strict";
import { generateAdvertiserFollowupBody } from "./process-influencer-agent-events.js";
import {
  ACTION_BRIEF,
  resolveBriefKey,
} from "../lib/agents/advertiser-execution-followup-email.js";

const CLEAN_BODY =
  "Plain update text without shipping or address confirmation content.";

async function main() {
  console.log("=== worker followup guard: action 透传回归测试 ===\n");

  const actions = [
    "rejectQuote",
    "submitQuote",
    "approveQuote",
    "confirmShip",
    "approveScript",
    "approveDraft",
    "rejectDraft",
    "confirmSystemQuote",
    "askSystemQuoteAtPrice",
  ];
  for (const action of actions) {
    const calls = [];
    const fakeGenerate = async (args) => {
      calls.push(args);
      return CLEAN_BODY;
    };

    await generateAdvertiserFollowupBody(
      {
        action,
        needSample: false,
        hasShippingInfo: false,
        askShippingConfirmation: false,
        campaignId: "CAMP-TEST",
        flatFee: 100,
        currency: "USD",
      },
      { generateBody: fakeGenerate }
    );

    assert.equal(calls.length, 1, `${action} 应只生成一次`);
    assert.equal(calls[0].action, action, `${action} 必须原样透传给正文生成函数`);
    assert.equal(calls[0].campaignId, "CAMP-TEST", `${action} 应保留其它入参`);
  }
  console.log(
    `OK: ${actions.join(" / ")} 的 action 均正确透传`
  );

  // 每个动作都必须有对应的正文任务指令（拒绝≠同意、counter≠同意、脚本/视频/寄样各语义独立）
  const semanticChecks = [
    ["rejectQuote", ACTION_BRIEF.rejectQuote, "拒绝报价必须有独立任务说明"],
    ["submitQuote", ACTION_BRIEF.submitQuote, "counter 报价必须有独立任务说明"],
    ["approveQuote", ACTION_BRIEF.approveQuote_no_sample, "同意报价必须有任务说明"],
    ["confirmShip", ACTION_BRIEF.confirmShip, "确认寄出必须有任务说明"],
    ["approveScript", ACTION_BRIEF.approveScript, "同意脚本必须有任务说明"],
    ["approveDraft", ACTION_BRIEF.approveDraft, "同意视频草稿必须有任务说明"],
    ["rejectDraft", ACTION_BRIEF.rejectDraft, "拒绝脚本/视频草稿必须有任务说明"],
    ["confirmSystemQuote", ACTION_BRIEF.confirmSystemQuote, "系统报价询问必须有任务说明"],
    [
      "askSystemQuoteAtPrice",
      ACTION_BRIEF.askSystemQuoteAtPrice,
      "系统指定价询问必须有任务说明",
    ],
  ];
  for (const [action, brief, msg] of semanticChecks) {
    assert.ok(brief && brief.trim().length > 0, `${action}: ${msg}`);
    const briefKey = resolveBriefKey(action, false, false);
    assert.ok(
      Object.prototype.hasOwnProperty.call(ACTION_BRIEF, briefKey),
      `${action}: brief 命中键 ${briefKey} 应存在于 ACTION_BRIEF`
    );
  }
  console.log("OK: 各动作均有独立任务说明且 brief 命中");

  // 兜底重写分支同样必须携带 action
  const calls = [];
  const sequence = [
    "Please confirm your shipping address before we send the sample.",
    "Your sample is on its way. Please start your draft.",
  ];
  const fakeRegen = async (args) => {
    calls.push(args);
    return sequence.shift();
  };

  await generateAdvertiserFollowupBody(
    { action: "confirmShip", hasShippingInfo: true },
    { generateBody: fakeRegen }
  );

  assert.equal(calls.length, 2, "confirmShip 含地址确认应触发重写");
  assert.equal(calls[0].action, "confirmShip", "首次生成应携带 action");
  assert.equal(calls[1].action, "confirmShip", "兜底重写应继续携带 action");
  assert.match(calls[1].extraInstruction || "", /confirm address/);
  console.log("OK: 兜底重写分支仍携带 action");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
