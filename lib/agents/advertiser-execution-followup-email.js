import { callDeepSeekLLM } from "../utils/llm-client.js";
import { influencerAgentBasePrompt } from "./influencer-agent-prompt.js";

const ACTION_BRIEF = {
  approveQuote_no_sample:
    "品牌方已确认合作并同意报价。请通知红人品牌已确认，并请红人开始准备素材草稿（draft），说明下一步会提交草稿链接供品牌审核。",
  approveQuote_need_sample_no_address:
    "品牌方已确认合作并同意报价。请通知红人品牌已确认，并请红人提供寄样收件信息（姓名、地址、电话等）。",
  approveQuote_need_sample_has_address:
    "品牌方已确认合作并同意报价；红人此前已提供寄样信息。请通知红人品牌已确认，样品将安排寄出，请红人留意收件。",
  confirmShip:
    "品牌方已确认样品已寄出。请通知红人样品已在路上（或已发出），并请红人收到后开始准备素材草稿，后续提交草稿链接。",
  approveDraft:
    "品牌方已通过草稿审核。请通知红人可以发布视频，并请红人在发布后回复最终 TikTok 视频链接。",
  rejectDraft:
    "品牌方未通过当前草稿并给出了修改建议。请把修改建议清晰转达给红人，并请红人修改后重新提交草稿链接。",
};

function resolveBriefKey(action, needSample, hasShippingInfo) {
  if (action === "approveQuote") {
    if (!needSample) return "approveQuote_no_sample";
    return hasShippingInfo
      ? "approveQuote_need_sample_has_address"
      : "approveQuote_need_sample_no_address";
  }
  return action;
}

/**
 * 生成广告主执行跟进邮件正文（英文）。
 */
export async function generateAdvertiserExecutionFollowupEmailBody({
  action,
  needSample,
  hasShippingInfo,
  campaignId,
  flatFee,
  currency,
  draftLink,
  draftFeedback,
  conversationHistory,
  influencer,
}) {
  const briefKey = resolveBriefKey(action, needSample, hasShippingInfo);
  const taskBrief = ACTION_BRIEF[briefKey] || ACTION_BRIEF[action] || "";

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：广告主在 Portal 完成了执行操作，你需要给红人发跟进邮件】
- action: ${action}
- campaignId: ${campaignId || "null"}
- 任务说明（中文，供你理解）：${taskBrief}
- 语气：专业、友好、简洁，英文正文，像一对一经纪人沟通。
- 根据 conversationHistory 续写对话，不要重复上一封几乎相同的内容。
- 若 conversationHistory 含多个 campaign，正文里自然区分当前 campaign，避免混淆。
- 只输出英文邮件正文（纯文本，不要 markdown，不要 JSON）。`;

  const payloadForLLM = {
    action,
    campaignId,
    needSample,
    hasShippingInfo,
    agreedPrice:
      flatFee != null && Number.isFinite(Number(flatFee))
        ? { amount: Number(flatFee), currency: currency || "USD" }
        : null,
    draftLink: draftLink || null,
    draftFeedback: draftFeedback || null,
    influencer: influencer
      ? {
          id: influencer.influencerId || influencer.id || null,
          displayName: influencer.displayName || null,
          username: influencer.username || null,
        }
      : null,
    conversationHistory,
  };

  const userContent = `请根据以下 JSON 上下文撰写跟进邮件正文：\n${JSON.stringify(payloadForLLM, null, 2)}`;

  const raw = await callDeepSeekLLM(
    [{ role: "user", content: userContent }],
    systemPrompt
  );
  return String(raw || "").trim();
}

export { resolveBriefKey, ACTION_BRIEF };
