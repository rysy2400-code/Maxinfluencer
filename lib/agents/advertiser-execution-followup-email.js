import { callDeepSeekLLM } from "../utils/llm-client.js";
import { influencerAgentBasePrompt } from "./influencer-agent-prompt.js";
import { buildApproveQuoteContentBriefRules } from "../execution/content-brief.js";

const ACTION_BRIEF = {
  confirmSystemQuote:
    "品牌方愿意按系统建议价格向红人发起合作询问，但红人此前并未对本次合作报价或确认。请完整说明当前品牌、产品、交付要求和价格，询问红人是否接受这次合作及该价格。必须明确尚待红人确认，禁止使用 confirmed、approved、let's proceed 或要求开始制作/提供地址。",
  approveQuote_no_sample:
    "品牌方已确认合作并同意报价。请通知红人品牌已确认，并请红人开始准备素材草稿（draft），说明下一步会提交草稿链接供品牌审核。",
  approveQuote_need_sample_no_address:
    "品牌方已确认合作并同意报价。请通知红人品牌已确认，并请红人提供寄样收件信息（姓名、地址、电话等）。",
  approveQuote_need_sample_has_address:
    "品牌方已确认合作并同意报价；红人此前已提供寄样信息。请通知红人品牌已确认，样品将安排寄出，请红人留意收件。",
  confirmShip:
    "品牌方已确认样品已寄出。请通知红人样品已在路上（或已发出），并请红人收到后开始准备素材草稿，后续提交草稿链接。",
  approveDraft:
    "品牌方已通过草稿审核。请通知红人可以发布，并请红人在发布后回复最终上线视频链接。",
  rejectDraft:
    "品牌方未通过当前草稿并给出了修改建议。请把 draftFeedback 中的修改建议完整、清晰地转达给红人（不可省略或笼统带过），并请红人修改后重新提交草稿链接。",
  rejectQuote:
    "品牌方本轮未能按当前报价确认合作。请委婉通知红人：你已收到并曾同步其报价，但品牌方因预算/档期等原因本轮无法推进；感谢红人的时间与兴趣；表示会持续为其留意更合适的未来合作机会。禁止转述品牌方内部拒绝原因或任何具体反馈；禁止主动邀请红人调整报价或 counter；禁止让红人现在开始制作素材或提供寄样地址。语气温暖、专业，责任落在品牌/预算侧，不暗示红人不够好。",
  submitQuote:
    "品牌方对红人当前报价给出了 counter offer（还价），尚未确认合作。请通知红人：你已收到品牌方的还价，并代为转达具体金额（及币种）；询问红人是否愿意按该金额推进，或希望如何回应（接受 / 暂不接受 / 其他想法）。必须明确：这仍是报价协商阶段，品牌尚未最终确认合作；请红人暂时不要开始制作素材或提供寄样地址。若 counterReason 有内容，可中性、简短转述，帮助红人理解背景；若无则只报金额即可。语气：专业、友好、像经纪人在中间传话，不施压。禁止：使用 confirmed / approved / let's proceed / start creating / shipping address 等暗示合作已定的表述。",
};

function buildActionExtraRules(action, contentBrief = null) {
  if (action === "confirmSystemQuote") {
    return `
- 这是首次向红人询问当前合作及价格是否接受，不是合作确认通知。
- 必须写出价格、币种和本 campaign 的完整 deliverables。
- 历史商务档案只用于系统生成建议价，不得向红人提及底价、30% 加价或内部算法。
- 请红人明确回复接受、拒绝或提出其他价格。`;
  }
  if (action === "askSystemQuoteAtPrice") {
    return `
- 这是首次向红人询问当前合作及指定价格，不得称为还价或协商。
- 必须写出 counterOffer 金额、币种和本 campaign 的完整 deliverables。
- 请红人明确回复接受、拒绝或提出其他价格。`;
  }
  if (action === "approveQuote") {
    return buildApproveQuoteContentBriefRules(contentBrief);
  }
  if (action === "rejectQuote") {
    return `
- 本条为报价未通过通知：用预算/档期等中性原因说明品牌本轮无法推进；**不要**引用或暗示任何品牌内部拒绝理由。
- **不要**主动邀请红人降价、改 package 或提交 counter offer。
- **要**表达会为其留意 future opportunities / keep in mind for upcoming fits。`;
  }
  if (action === "submitQuote") {
    return `
- 本条为品牌 counter offer 通知：正文**必须**写出 counterOffer 中的金额与币种。
- **必须**说明：品牌尚未 final confirm，红人回复后你会再同步品牌方。
- **要**邀请红人回复是否接受或有何想法；不要施压。
- **不要**暗示合作已定，不要请红人开始制作或提供寄样地址。
- 若有 counterReason，可简短、中性转述；不要渲染成对红人的批评。`;
  }
  if (action === "approveDraft") {
    return `
- 本条为草稿已通过通知：正文须说明可以发布/上线。
- 请红人在发布后回复**最终上线视频链接**（final published video link / live post link 等中性表述）。
- **不要**限定 TikTok 或某一固定平台，除非 conversationHistory 中该 campaign 明确只有单一平台且已自然提及。`;
  }
  if (action === "rejectDraft") {
    return `
- 本条为草稿未通过通知：draftFeedback 非空，正文**必须**完整、清晰转述品牌修改建议，不可省略或只用「please revise」等笼统表述。
- 请红人按建议修改后重新提交 draft 链接。`;
  }
  return "";
}

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
  counterOffer,
  counterReason,
  contentBrief,
  campaignContext,
  conversationHistory,
  influencer,
}) {
  const briefKey = resolveBriefKey(action, needSample, hasShippingInfo);
  const taskBrief = ACTION_BRIEF[briefKey] || ACTION_BRIEF[action] || "";
  const actionExtraRules = buildActionExtraRules(action, contentBrief);

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：广告主在 Portal 完成了执行操作，你需要给红人发跟进邮件】
- action: ${action}
- 当前 campaign（权威事实）: ${JSON.stringify(campaignContext || {})}
- 任务说明（中文，供你理解）：${taskBrief}
- 语气：专业、友好、简洁，英文正文，像一对一经纪人沟通。
- 根据 conversationHistory 续写对话，不要重复上一封几乎相同的内容。
- 当前任务的品牌、产品和交付要求只能以“当前 campaign（权威事实）”为准；conversationHistory 仅用于理解关系、语气和对话进展，不得用历史中的其他品牌替换当前品牌。
- 若 conversationHistory 含多个 campaign，正文里自然区分当前 campaign，避免混淆。
- 正文禁止输出 campaignId 或 CAMP-... 等内部标识；提及合作时使用当前品牌名，例如 “the Lovart collaboration”。
- 只输出英文邮件正文（纯文本，不要 markdown，不要 JSON）。${actionExtraRules}`;

  const payloadForLLM = {
    action,
    campaignId,
    campaignContext: campaignContext || null,
    needSample,
    hasShippingInfo,
    agreedPrice:
      flatFee != null && Number.isFinite(Number(flatFee))
        ? { amount: Number(flatFee), currency: currency || "USD" }
        : null,
    draftLink: draftLink || null,
    draftFeedback: draftFeedback || null,
    counterOffer: counterOffer || null,
    counterReason: counterReason || null,
    contentBrief: contentBrief || null,
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
  askSystemQuoteAtPrice:
    "品牌方希望以指定价格首次询问红人是否愿意接受当前合作。这不是在转述品牌还价，因为红人尚未对本 campaign 报价。请完整说明品牌、产品、交付要求和 counterOffer 金额，询问红人是否接受本次合作及该价格。禁止使用 counter、bargain、negotiation、confirmed、approved 或暗示合作已经成立。",
