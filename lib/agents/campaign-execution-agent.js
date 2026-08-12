/**
 * Campaign Execution Agent：发布后的执行阶段
 * 负责：定时汇报配置、执行速度、修改 campaign、与红人特殊情况沟通（委托红人经纪人 agent）
 * 统一由「单一工具调度器」（LLM prompt）决策所有意图：状态/节奏/汇报/修改/特殊请求/
 * 进度与配置询问/红人名单导入。导入的 confirm 两轮流程与附件/正文名单补全由代码兜底。
 */
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM, callDeepSeekLLMStream } from "../utils/llm-client.js";
import {
  CAMPAIGN_EXECUTION_TOOL_SCHEMAS,
  CAMPAIGN_STATUS_UI_LABEL,
} from "../tools/campaign-execution/campaign-execution-tools.js";
import { getCampaignById, getCampaignBySessionId } from "../db/campaign-dao.js";
import { getReportConfigByCampaignId } from "../db/campaign-report-config-dao.js";
import { buildCampaignAgentSnapshotHint } from "../campaign/format-work-notes-summary.js";
import { CAMPAIGN_STATUS_WORK_NOTES_LABEL } from "../campaign/campaign-status.js";
import {
  buildAttachmentContextForPrompt,
  collectAttachmentsFromHistory,
  extractProfileUrlsFromMessages,
  normalizeAttachmentPlan,
  urlsToTextItems,
} from "../influencer/import-conversation-helpers.js";

const TOOL_NAMES = CAMPAIGN_EXECUTION_TOOL_SCHEMAS.map((t) => t.name);

function screeningValueText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    if (o.min != null && o.max != null) return `${o.min}-${o.max}`;
    if (o.min != null) return `${o.min}以上`;
    if (o.max != null) return `${o.max}以下`;
    if (typeof o.value === "string") return o.value;
  }
  const s = String(v);
  return s === "[object Object]" ? "" : s;
}

function formatConciseModifyCampaignReply(changes = {}) {
  const ch = changes && typeof changes === "object" ? changes : {};
  const sc = ch.screeningConditions;
  if (sc && typeof sc === "object") {
    if (sc.followerRange != null) {
      const t = screeningValueText(sc.followerRange);
      if (t) return `已将红人粉丝量要求改为 ${t}。`;
    }
    if (sc.viewRange != null) {
      const t = screeningValueText(sc.viewRange);
      if (t) return `已将红人播放量要求改为 ${t}。`;
    }
    if (sc.accountType != null) {
      const t = screeningValueText(sc.accountType);
      if (t) return `已将红人帐号类型要求改为 ${t}。`;
    }
  }
  if (ch.brandName != null) return `已将品牌改为 ${ch.brandName}。`;
  if (ch.productName != null) return `已将产品改为 ${ch.productName}。`;
  if (ch.platform != null) {
    const p = Array.isArray(ch.platform) ? ch.platform.join("、") : ch.platform;
    return `已将投放平台改为 ${p}。`;
  }
  if (ch.region != null) return `已将投放地区改为 ${ch.region}。`;
  if (ch.publishTimeRange != null) return `已将发布时间段改为 ${ch.publishTimeRange}。`;
  if (ch.budget != null) return `已将总预算改为 ${ch.budget}。`;
  if (ch.commission != null) return `已将佣金改为 ${ch.commission}%。`;
  if (ch.keywordStrategy !== undefined) return `已更新红人搜索关键词策略。`;
  if (
    ch.influencerPricing != null ||
    ch.pricingMode != null ||
    ch.pricingEcpmUsd != null ||
    ch.pricingMaxFlatFeeUsd != null
  ) {
    return `已更新单位红人报价策略。`;
  }
  if (ch.deliverables != null) return `已更新交付结果。`;
  if (ch.contentRequirements != null) return `已更新内容要求。`;
  return "已更新 Campaign 配置。";
}

function isReplyTooVerbose(reply) {
  const text = String(reply || "");
  return (
    text.includes("当前工作笔记将显示") ||
    text.includes("并通知红人经纪人同步给相关红人") ||
    /投放平台.*投放地区.*总预算/s.test(text)
  );
}

/** 执行进度一句（仅数字，与执行面板阶段对齐） */
export function formatConciseExecutionProgressSentence(executionData) {
  if (!executionData || typeof executionData !== "object") {
    return "暂无执行进度数据。";
  }
  const cols = executionData.columns || {};
  const analyzed =
    executionData.analyzedCount != null ? Number(executionData.analyzedCount) : null;
  const pendingPrice = Array.isArray(cols.pendingPrice) ? cols.pendingPrice.length : 0;
  const pendingSample = Array.isArray(cols.pendingSample) ? cols.pendingSample.length : 0;
  const pendingDraft = Array.isArray(cols.pendingDraft) ? cols.pendingDraft.length : 0;
  const published = Array.isArray(cols.published) ? cols.published.length : 0;
  const contacted = Array.isArray(cols.contacted) ? cols.contacted.length : 0;

  const parts = [];
  if (analyzed != null && Number.isFinite(analyzed)) {
    parts.push(`已分析红人 ${analyzed}`);
  }
  if (contacted > 0) parts.push(`已联系 ${contacted}`);
  parts.push(`待审核价格 ${pendingPrice}`);
  parts.push(`待寄样 ${pendingSample}`);
  parts.push(`待审核草稿 ${pendingDraft}`);
  parts.push(`已发布 ${published}`);
  return parts.join("，") + "。";
}

async function loadCampaignSnapshotBundle(campaignId) {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return { campaign: null, reportConfig: null, campaignSnapshotHint: "" };
  }
  const reportConfig = await getReportConfigByCampaignId(campaignId);
  const status = campaign.status || "running";
  const statusLabel =
    CAMPAIGN_STATUS_UI_LABEL[status] ||
    CAMPAIGN_STATUS_WORK_NOTES_LABEL[status] ||
    status;
  const campaignSnapshotHint = buildCampaignAgentSnapshotHint({
    campaign,
    reportConfig,
    statusLabel,
  });
  return { campaign, reportConfig, campaignSnapshotHint, statusLabel };
}

async function generateProgressInquiryReply({
  messages,
  campaignSnapshotHint,
  executionData,
}) {
  const lastMessage = messages[messages.length - 1]?.content || "";
  const progressLine = formatConciseExecutionProgressSentence(executionData);

  const systemPrompt = `你是 Bin 的 Campaign 执行助手。用户正在**询问**（只读）配置或进度，不是修改。
- **配置类问题**：必须严格引用【当前 Campaign 配置快照】中的对应字段；字段为空或快照写「未设置」时，回答「未设置」；**禁止**声称库中为空若快照有值。
- **进度类问题**：使用【执行进度摘要】中的数字；用一句中文概括，只报数字，不要列出红人名单。
- **同时问配置与进度**：在同一条回复里分别简短作答，仍只答被问到的项。
- **交付结果**：若快照为多行（如 YouTube/Instagram 分行），询问交付结果时可原样保留分行。
- **极简**：不要复述整份快照，不要带 Campaign ID，不要 markdown 标题。`;

  const userContent = `${campaignSnapshotHint}

【执行进度摘要】
${progressLine}

【用户问题】
${lastMessage}

请用中文极简回答（纯文本）。`;

  const raw = await callDeepSeekLLM([{ role: "user", content: userContent }], systemPrompt);
  return String(raw || progressLine).trim();
}

async function generateConfigInquiryReply({ messages, campaignSnapshotHint }) {
  const lastMessage = messages[messages.length - 1]?.content || "";
  const systemPrompt = `你是 Bin 的 Campaign 执行助手。用户正在**询问**当前 Campaign 配置（只读）。
- 必须严格引用【当前 Campaign 配置快照】；只回答用户所问字段；同类可合并一句。
- 快照字段为「未设置」时回答「未设置」；**禁止**臆测或声称库中为空若快照有值。
- 交付结果多行时可原样保留分行（与工作笔记一致）。
- 极简：不要复述未问到的字段，不要 markdown 标题。`;

  const userContent = `${campaignSnapshotHint}

【用户问题】
${lastMessage}

请用中文极简回答（纯文本）。`;

  const raw = await callDeepSeekLLM([{ role: "user", content: userContent }], systemPrompt);
  return String(raw || "请具体说明你想查看哪一项配置。").trim();
}

/**
 * 构建执行阶段「单一工具调度器」prompt：状态/节奏/汇报/修改/特殊请求/进度与配置询问/
 * 红人名单导入，全部由同一个 LLM 决策，避免多链路互相截胡（如导入链路误吞 @handle 消息）。
 */
export function buildExecutionSchedulerPrompt({
  campaignId,
  campaignStatusHint = "",
  campaignSnapshotHint = "",
  lastMessage = "",
  recentMessages = "",
  attachmentsContext = "",
  toolsDesc = "",
}) {
  return `当前 Campaign ID: ${campaignId}
${campaignStatusHint}
${campaignSnapshotHint}
${attachmentsContext ? `\n【附件/名单上下文】\n${attachmentsContext}` : ""}

【用户最后一条消息（以此为准）】
${lastMessage}

最近对话（最近 5 条）：
${recentMessages || "(无)"}

可用工具：
${toolsDesc}

你是「工具调度器」，只根据用户最后一条消息输出 JSON，判断要不要调工具。

【判定要点】
1. 若最后一条消息是在要求**暂停 / 恢复 / 继续 / 完成 / 切换自主或名单模式**（含 to_passive、to_auto 及「只按名单联系」「不要自动找红人」）→ 必须 needTool=true，toolName=set_campaign_status，并填 params.action。
2. 不得因对话里出现过「已恢复」等历史 assistant 话术就认为已经改库；只有 set_campaign_status 能改状态。
3. 若最后一条消息要求**调整执行节奏**（如「每天联系 50 位」「每天只联系 3 个红人」）→ 必须 needTool=true，toolName=set_execution_pacing，params.influencersPerDay=数字；**禁止** needTool=false 口头声称已改节奏。
4. 若最后一条消息要求**调整汇报**（间隔、时间点、汇报形式、重点指标）→ 必须 needTool=true，toolName=set_report_schedule；**禁止** needTool=false 口头声称已改汇报设置。
5. 若最后一条消息要求**修改 Campaign 信息或执行筛选**（品牌、产品、平台、地区、预算、佣金、报价策略、交付结果、红人画像、关键词策略等，含「改成」「设置为」「更新为」）→ 必须 needTool=true，toolName=modify_campaign，scope=whole；**禁止** needTool=false 口头声称已改 Campaign。
6. 若最后一条消息 @某位或多位红人 并**询问/协商/回复/同步消息**（如「帮我回复达 @xxx」「把这段话发给 @xxx」「问他能否接受某价格/做几条视频/改时间/给具体报价」「给 @a、@b、@c 分别发送寄样物流链接与内容建议」）→ 必须 needTool=true，toolName=ask_influencer_special_request。
   - 单一位红人：params.influencerId=handle（无 @），params.requestDetail=该红人对应的完整文案（原样保留，不要改写）。
   - **多位红人**：params.requests 为数组，每位红人一个元素 { influencerId, requestType, requestDetail }；requestDetail 只包含该红人对应的完整文案（如各自的物流单号、内容建议、参考视频），由你自主理解并拆分归属，**禁止把多位红人的内容混在一起或互相串用**；同一红人重复出现时只保留一次；数量没有上限。
   - requestType：消息未明确表达语义（价格/时间/内容）时统一用 other；明确表达了才按语义填 adjust_price / delay_publish / change_content。
   **优先级**：含 @handle 的「回复/协商/报价/沟通」消息优先按特殊请求处理；即使消息里同时出现佣金、预算、交付结果、合作细则等 Campaign 词，也不要误判为 modify_campaign；更不要当作红人名单导入。
7. 若用户问「红人回了没」「特殊请求有反馈吗」且对话中有 specialRequestId → needTool=true，toolName=get_influencer_special_request_feedback。
8. 若用户**仅询问执行进度**（各阶段人数、已分析多少红人、待报价/待草稿/已发布数量、整体进度、某 @红人 当前 stage）→ 必须 needTool=true，toolName=get_campaign_execution_status；**禁止** needTool=false 编造进度数字。
9. 若用户**同时询问配置与进度**（如「交付结果是什么？分析了多少红人？」）→ 必须 needTool=true，toolName=get_campaign_execution_status（只调一次）；配置部分由后续回复引用【当前 Campaign 配置快照】，进度部分用工具结果。
10. 若用户**仅询问当前 Campaign 配置**（交付结果、红人要求、预算、平台、关键词策略等，含「是什么」「目前多少」「查看」且非修改意图）→ needTool=false，reply 留空；系统会引用【当前 Campaign 配置快照】自动回答，只答所问项。
11. 寒暄、问汇报选项说明书、问「有哪些 Campaign 状态可以修改」等说明类问题 → needTool=false，并在 reply 中用自然语言回答；说明当前状态时必须引用【当前 Campaign 数据库状态】与配置快照，不得声称已是名单模式除非 status=running_passive。
12. **禁止** needTool=false 时声称已向红人发送询问、已收到红人反馈，或声称已修改执行节奏/汇报/Campaign 配置/寻源模式。
13. 红人名单导入：用户**上传 Excel/CSV 附件**、粘贴**红人主页链接**或 **@用户名 列表** → 属于名单导入场景（见第 14 条两轮确认；注意第 6 条的「回复达人」优先级更高）。
14. 名单导入两轮确认：
    - 若用户**仅提供名单/附件、尚未明确同意导入并联系** → needTool=false，并在 reply 中用自然语言描述看到的名单/附件，询问「是否导入并分析后联系？」；**不要**调用工具。
    - 若用户已明确同意（如「导入吧」「用这份名单联系」），或**上一轮 Bin 刚问过是否导入、用户回复「是/好的/确认」** → 必须 needTool=true，toolName=import_influencer_list；params.textItems / params.attachmentPlan **可留空**，系统会从最近对话历史与附件自动补全，**不要编造 profileUrl 或 attachmentPlan.storageKey**。
    - 若用户**明确只想解读表格/链接内容、不要导入联系**（如「帮我看看这份表格里有哪些红人」「这些链接能分析吗」）→ needTool=false，并在 reply 中结合附件样本/链接直接解读，**不要**调用工具。
15. 禁止把「回复某位达人」的消息当作名单导入（见第 6 条优先级）。

输出格式：
{ "needTool": true, "toolName": "工具名", "params": { ... } }
或
{ "needTool": false, "toolName": null, "params": null, "reply": "自然语言回复（配置询问类可留空，系统会引用配置快照回答）" }

工具名必须是以下之一：${TOOL_NAMES.join(", ")}
params 中 campaignId 可省略（将使用 ${campaignId}）。

【set_campaign_status 示例 — 状态变更禁止 needTool=false】
{ "needTool": true, "toolName": "set_campaign_status", "params": { "action": "pause" } }
{ "needTool": true, "toolName": "set_campaign_status", "params": { "action": "resume" } }
{ "needTool": true, "toolName": "set_campaign_status", "params": { "action": "complete" } }
{ "needTool": true, "toolName": "set_campaign_status", "params": { "action": "to_passive" } }
{ "needTool": true, "toolName": "set_campaign_status", "params": { "action": "to_auto" } }

【set_execution_pacing 示例 — 执行节奏禁止 needTool=false】
{ "needTool": true, "toolName": "set_execution_pacing", "params": { "influencersPerDay": 50 } }
{ "needTool": true, "toolName": "set_execution_pacing", "params": { "influencersPerDay": 3 } }

【set_report_schedule 示例 — 汇报设置禁止 needTool=false】
{ "needTool": true, "toolName": "set_report_schedule", "params": { "intervalHours": 48 } }
{ "needTool": true, "toolName": "set_report_schedule", "params": { "reportTime": "09:00" } }
{ "needTool": true, "toolName": "set_report_schedule", "params": { "contentPreference": "detailed" } }
{ "needTool": true, "toolName": "set_report_schedule", "params": { "includeMetrics": ["pending_price_count", "pending_draft_count", "published_count", "pending_sample_count"] } }
说明：用户「多加某指标」时，includeMetrics 必须在【当前重点指标】基础上追加，且不要传 intervalHours / interval / reportTime / contentPreference 除非用户明确要求改这些。

【modify_campaign 示例】
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "screeningConditions": { "viewRange": "5万以上" } } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "screeningConditions": { "followerRange": "1万-50万", "accountType": "健身博主" } } } }
说明：followerRange / viewRange / accountType 必须写在 screeningConditions 内，值为用户原话字符串，不要用 {min,max} 对象。
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "keywordStrategy": "用户原话" } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "brandName": "Anker", "region": "美国", "platform": "Instagram" } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "platform": ["YouTube", "TikTok"] } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "influencerPricing": { "mode": "commission_only" }, "commission": 15 } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "pricingEcpmUsd": 5, "pricingMaxFlatFeeUsd": 500 } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "pricingEcpmUsd": 1, "pricingMaxFlatFeeUsd": 1000 } } }
{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "budget": 15450, "commission": 0 } } }

【ask_influencer_special_request 示例 — 禁止 needTool=false 口头承诺已发送】
{ "needTool": true, "toolName": "ask_influencer_special_request", "params": { "influencerId": "zaharagrwm1", "requestType": "adjust_price", "requestDetail": "询问红人是否接受 $590 制作 2 条视频" } }
{ "needTool": true, "toolName": "ask_influencer_special_request", "params": { "influencerId": "904outdoor", "requestType": "adjust_price", "requestDetail": "回复红人：我们认可你的内容，希望以「产品赞助+拍摄稿费+销售佣金」合作，请根据合作细则给具体报价。" } }
{ "needTool": true, "toolName": "ask_influencer_special_request", "params": { "requests": [ { "influencerId": "genswrrld", "requestType": "other", "requestDetail": "物流单号：9214490374018512951692\n内容建议：分享护理学校新生学习建议\n请红人制作视频前先给脚本审核" }, { "influencerId": "technicallyshai", "requestType": "other", "requestDetail": "物流单号：9214490374018512854115\n内容建议：做26新生科技学习产品推荐\n请红人制作视频前先给脚本审核" } ] } }

【get_influencer_special_request_feedback 示例】
{ "needTool": true, "toolName": "get_influencer_special_request_feedback", "params": { "requestId": "SR-xxx" } }

【get_campaign_execution_status 示例 — 进度/混合询问禁止 needTool=false】
{ "needTool": true, "toolName": "get_campaign_execution_status", "params": {} }

【import_influencer_list 示例 — 名单导入（两轮确认）】
第一轮（仅名单，未同意）：
{ "needTool": false, "toolName": null, "params": null, "reply": "我看到你提供了 2 个红人主页链接，是否导入并分析后按节奏联系？" }
第二轮（用户回复「是/好的/确认」）：
{ "needTool": true, "toolName": "import_influencer_list", "params": {} }
说明：第二轮 textItems / attachmentPlan 由系统从最近对话历史与附件自动恢复；用户明确提供名单并同意时可填入 textItems（如 [{"profileUrl":"https://www.tiktok.com/@alice","username":"alice","platform":"tiktok"}]）。

只返回 JSON，不要其他文字。`;
}

/** 解析调度器 LLM 输出（兼容 markdown 代码块包裹）。 */
export function parseExecutionSchedulerDecision(raw) {
  const jsonMatch = String(raw || "").match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  return {
    needTool: parsed.needTool === true,
    toolName: typeof parsed.toolName === "string" ? parsed.toolName : null,
    params: parsed.params && typeof parsed.params === "object" ? parsed.params : {},
    reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
  };
}

/**
 * 导入参数兜底：LLM 决定 import_influencer_list 后，从附件与最近对话历史自动补全
 * attachmentPlan / textItems / userMessage，避免模型编造或漏传名单来源。
 */
export function hydrateImportParams(
  decision,
  { messages = [], attachmentsForImport = [] } = {}
) {
  const params = { ...(decision.params || {}) };
  const attachmentPlan = normalizeAttachmentPlan(
    { attachmentPlan: params.attachmentPlan || null },
    attachmentsForImport,
    messages
  );
  if (attachmentPlan) params.attachmentPlan = attachmentPlan;

  const hasAttachmentImport = Boolean(params.attachmentPlan?.storageKey);
  if (!hasAttachmentImport) {
    const textItems = Array.isArray(params.textItems)
      ? params.textItems.filter(Boolean)
      : [];
    if (!textItems.length) {
      const urls = extractProfileUrlsFromMessages(messages, { excludeLastUser: false });
      params.textItems = urlsToTextItems(urls);
    } else {
      params.textItems = textItems;
    }
  }
  params.userMessage = String(messages[messages.length - 1]?.content || "");
  return params;
}

/**
 * 单一调度器：构建 prompt → 调 LLM → 解析决策 → 补全导入参数。
 * @param {Object} input - buildExecutionSchedulerPrompt 所需字段 + messages / attachmentsForImport
 * @param {Object} deps - 可注入 { callLlm, callLlmStream, onSchedulerProgress } 便于测试/进度反馈
 * @returns {Promise<{ decision: Object, prompt: string }>}
 */
export async function decideExecutionSchedulerTurn(
  input = {},
  { callLlm, callLlmStream, onSchedulerProgress } = {}
) {
  const prompt = buildExecutionSchedulerPrompt(input);
  const systemPrompt =
    "你是指令执行专家，只输出 JSON。用户要求暂停/恢复/完成 campaign 时必须 needTool=true 且使用 set_campaign_status；@红人回复/询问/协商时必须 ask_influencer_special_request（一位红人用 params.influencerId，多位红人用 params.requests 数组）；红人名单确认后必须 import_influencer_list。";

  let raw;
  if (callLlm) {
    // 测试/注入路径：非流式
    raw = await callLlm([{ role: "user", content: prompt }], systemPrompt);
  } else {
    // 生产路径：流式调用，边接收边推送进度，避免用户在空白气泡前长时间等待
    const streamFn = callLlmStream || callDeepSeekLLMStream;
    let received = "";
    let lastPushAt = 0;
    raw = await streamFn(
      [{ role: "user", content: prompt }],
      systemPrompt,
      (chunk) => {
        received += chunk;
        if (!onSchedulerProgress) return;
        const now = Date.now();
        if (now - lastPushAt >= 500) {
          lastPushAt = now;
          onSchedulerProgress(`正在识别意图（已接收 ${received.length} 字符）…`);
        }
      },
      { maxTokens: 8192 }
    );
    if (onSchedulerProgress) {
      onSchedulerProgress("意图识别完成，正在处理…");
    }
  }

  const decision = parseExecutionSchedulerDecision(raw);
  if (decision.needTool && decision.toolName === "import_influencer_list") {
    const params = hydrateImportParams(decision, {
      messages: input.messages || [],
      attachmentsForImport: input.attachmentsForImport || [],
    });
    decision.params = params;
    const hasImportSource = Boolean(
      (Array.isArray(params.textItems) && params.textItems.length) ||
        params.attachmentPlan?.storageKey
    );
    if (!hasImportSource) {
      // LLM 决定导入但代码无法恢复任何名单来源：转成确认/引导，不调用工具。
      decision.needTool = false;
      decision.toolName = null;
      decision.reply =
        decision.reply ||
        "我这边没有识别到可导入的红人链接或附件，请重新提供红人主页链接或上传 Excel 名单。";
    }
  }
  return { decision, prompt };
}

export class CampaignExecutionAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是 Bin 的 Campaign 执行助手。当前对话对应的 Campaign 已发布，你负责帮助广告主：
1. 设置定时汇报（汇报间隔、时间点、内容偏好）
2. 调整执行速度（每天联系多少位红人）
3. 暂停 / 恢复 / 标记已完成：调整 campaign 生命周期（仅停/恢复自动拉新与定时汇报；标记完成后不再拉新；队列中搜索会跑完；红人回信与手动操作不受影响）
4. 修改 campaign 内容（品牌、产品、平台、地区、预算、筛选条件、发布时间等，可整体或单个红人），修改后会由红人经纪人同步给红人
5. 向某位或多位红人发起特殊请求（如延后发布时间、改价、改条数、同步物流单号与内容建议），并回收红人反馈后同步给广告主；一条消息涉及多位红人时，为每位红人分别发起一次特殊请求（params.requests 数组）
6. 查询 campaign 执行状态
7. 红人执行阶段操作：
   - 同意/通过某红人报价 → approve_quote（**必须先确认** contentBriefMode：reference_script 需 https scriptLink；free_creative 为自由发挥；scriptNotes 可选。用户未说明模式时先追问，批量同意多位红人时**分别**询问每位红人的模式与链接/备注，再逐个调用）
   - 暂不通过/拒绝某红人报价 → reject_quote
   - 确认已寄样给某红人 → confirm_ship
   - 通过某红人视频草稿 → approve_draft
   - 不通过某红人草稿并给修改建议 → reject_draft（feedback 必填）
   - 更新某红人已发布视频数据（链接、投流码、播放量等）→ update_published
8. 红人名单导入：粘贴红人主页链接、@用户名或 📎 Excel 时，由统一工具调度器按「先确认再导入」两轮流程处理；用户确认后调用 import_influencer_list（textItems / attachmentPlan 由系统自动补全，勿编造）。用户只想解读表格/链接时直接解读，不导入。用语自然，勿固定说「已收到附件」。

【汇报形式可选项】
- brief（简要汇总）：只给关键数字和简单结论。
- detailed（详细报告）：包含各阶段、各红人的详细说明。
- summary_only（仅汇总数字）：只给总量，不列出名单。

【重点指标常见选项】
- pending_price_count：待审核价格的红人数。
- pending_sample_count：待寄送样品的红人数。
- pending_draft_count：待审核草稿的红人数。
- published_count：已发布视频的红人数。
（也可以根据需要扩展更多指标，但应该向用户说明这些名称的含义。）

红人 ID 可从用户名、@handle、昵称推断，如 alice_fashion、bob_lifestyle、emma_fit 等。

重要约定：
- 当用户说「每天联系 20 位」「每天只联系 3 个」等，必须调用 set_execution_pacing，并在 params.influencersPerDay 中填入该数字，避免只设置 pacingMode。
- **寻源模式（自主/名单）与生命周期状态（暂停/恢复/完成）只能由 set_campaign_status 写入数据库**。你在对话里**不得**在未通过工具成功改库前，向用户声称「已切换为名单模式」「已暂停」「已恢复」「已完成」；工具执行后的说明以工具返回为准。说明当前状态时必须以【当前 Campaign 数据库状态】为准，不得臆测。
- 用户表达暂停/恢复/完成意图时（含无空格写法如「恢复campaign」「继续campaign」「暂停campaign」），在意图识别阶段必须 needTool=true 且 toolName=set_campaign_status，并填写 params.action：pause / resume / complete。
- 用户表达切换寻源模式时：「改为只按名单联系」「不要自动找红人」「只用我导入的名单」→ action=to_passive；「改回自动找红人」「恢复自主分析联系」→ action=to_auto。
- 暂停：「暂停 campaign」「先停一下」「别联系了」「pause campaign」等 → action=pause。
- 恢复：「继续 campaign」「恢复」「恢复campaign」「继续campaign」「重新开始」「resume campaign」等 → action=resume（恢复到暂停前的自主或名单模式）。
- 完成：「campaign 完成了」「可以结束了」「结项」「mark complete」「end campaign」等 → action=complete。
- running_passive（名单模式）下不会自动搜索红人，应引导用户上传/粘贴名单；running（自主模式）会按心跳自动搜索。
- 当用户说「每 2 天汇报一次」「每周一汇报一次」「每天上午 9 点汇报」等，必须调用 set_report_schedule，并在 params.intervalHours/params.interval 或 params.reportTime 中反映这些信息。
- 当用户要求「以后日报里多加 XXX 指标」时，应该先读取现有 includeMetrics，再在数组中追加新指标整体写回。
- 当用户修改红人画像（粉丝量、播放量、帐号类型/内容方向）时，必须调用 modify_campaign，**params.scope 必须精确为字符串 whole**（不要用 single_influencer），changes.screeningConditions 填入 followerRange、viewRange、accountType（可只填要改的键；**值必须是字符串**，如 "5万以上"，不要用 JSON 对象）。
- 当用户修改「红人搜索关键词策略」时，必须调用 modify_campaign，**params.scope 必须为 whole**，changes 仅填 **keywordStrategy** 字符串（把用户原话或整理后的策略写进去）；禁止用 single_influencer，否则无法写入数据库。若用户说「暂无」「清空」，keywordStrategy 可为「暂无」或空字符串。
- 当用户修改发布时的 Campaign / 产品信息（品牌、产品名、投放平台、投放地区、发布时间段、总预算、佣金、单位红人报价策略、交付结果）时，必须调用 modify_campaign，**params.scope 必须为 whole**，在 changes 中只填用户明确要改的字段：brandName、productName、platform、region、publishTimeRange、budget（数字，总预算）、commission（数字，如 0 表示 0%）、influencerPricing（{ mode, ecpmUsd, maxFlatFeeUsd }）或 pricingMode/pricingEcpmUsd/pricingMaxFlatFeeUsd、deliverables（交付结果，**必须是字符串**；多平台时用换行分段，如「YouTube：1条视频；Bio 14天\\nInstagram：1条 Reel；Ad code 60天」，**禁止传 JSON 对象**）。例如「品牌改为 Anker」「改成只要佣金」「ecpm 改成 5、上限 500」「交付结果改为 2 条视频，Bio 保留 30 天」。**budget / commission / ecpmUsd / maxFlatFeeUsd 必须填纯数字（如 1000、15450），勿用 "$1,000" 或带逗号字符串**。报价策略与交付结果变更**仅影响尚未发出首封邀约的红人**。
- **投放平台 platform**：写入 changes 时必须用规范全称 "TikTok" / "Instagram" / "YouTube" / "X"；多平台用数组 ["YouTube","TikTok","X"]。用户说 ytb、tk、ins、x、twitter 或「ytb和tk」时，你先理解再转成全称数组，勿把缩写组合原样写入。
- 当用户 @某红人 并询问/协商/回复/同步消息（改价、条数、时间、内容、报价等，含「帮我回复达 @xxx」「把这段发给 @xxx」）时，必须调用 ask_influencer_special_request；params.influencerId 为 handle（去掉 @），params.requestDetail 为用户要求的完整文案（原样保留），params.requestType 按语义选择 adjust_price / delay_publish / change_content / other。**即使消息同时包含佣金、预算、交付结果等 Campaign 词，也优先该工具，不要误判为 modify_campaign 或名单导入。**
- 当用户询问「红人回了没」「特殊请求有反馈吗」且对话中有 specialRequestId 时，调用 get_influencer_special_request_feedback。
- 不得在未调用 ask_influencer_special_request 成功前，声称「已向红人发送询问」。
- 当用户询问「汇报形式和重点指标有哪些」「有哪些汇报方式可以选」这类问题时，这是在问说明书，不需要调用任何工具（needTool=false）。你应该直接用自然语言解释上面的选项，并举 1-2 个例子帮助理解。
- **回复风格（修改 vs 询问）**：
  - **修改类**（用户要求改成/设置为/更新）：工具成功后的回复极简，只确认刚改的那一项；未成功调用工具前不得声称已改库。
  - **询问类**（用户问「是什么」「目前多少」「查看」当前配置）：必须引用上下文中的【当前 Campaign 配置快照】，**只答被问字段**；快照为「未设置」则答「未设置」；不要罗列未问到的字段。
  - 询问**执行进度/各阶段人数**时，由系统调用 get_campaign_execution_status 后生成回复；你在此阶段若 needTool=false 且仅问配置，勿编造进度数字。

当不需要调用工具时，你必须直接输出中文自然语言回复（不要输出 JSON）。`;

    super("CampaignExecutionAgent", systemPrompt);
  }

  /**
   * 意图识别 + 工具决策
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（必含 campaignId, published）
   * @returns {Promise<Object>} - { reply: string, toolCall: { toolName, params } | null }
   */
  async processWithTools(messages, context = {}, options = {}) {
    let campaignId =
      typeof context.campaignId === "string" ? context.campaignId.trim() : "";
    const sessionId =
      typeof context.sessionId === "string" ? context.sessionId.trim() : "";

    if (sessionId) {
      try {
        const bySession = await getCampaignBySessionId(sessionId);
        if (bySession?.id) campaignId = bySession.id;
      } catch (e) {
        console.warn("[CampaignExecutionAgent] 按 session 解析 campaignId 失败:", e?.message || e);
      }
    }

    const lastMsg = messages[messages.length - 1] || {};
    const lastMessage = lastMsg.content || "";
    const lastAttachments = Array.isArray(lastMsg.attachments) ? lastMsg.attachments : [];

    if (!campaignId) {
      return {
        reply: "当前会话暂无已发布的 Campaign，无法执行操作。请先完成 Campaign 发布。",
        toolCall: null,
      };
    }

    let campaignStatusHint = "";
    let campaignSnapshotHint = "";
    try {
      const bundle = await loadCampaignSnapshotBundle(campaignId);
      const campaign = bundle.campaign;
      campaignSnapshotHint = bundle.campaignSnapshotHint || "";
      if (campaign?.status) {
        const label =
          CAMPAIGN_STATUS_UI_LABEL[campaign.status] || campaign.status;
        campaignStatusHint = `
【当前 Campaign 数据库状态】${campaign.status}（${label}）
- 若用户要「恢复/继续」且当前为 paused → 必须调用 set_campaign_status，params.action=resume（勿 needTool=false）。
- 若用户要「暂停」且当前为 running 或 running_passive → 必须调用 set_campaign_status，params.action=pause。
- 若用户要「完成/结项」且当前为 running、running_passive 或 paused → 必须调用 set_campaign_status，params.action=complete。
- 若用户要切换为名单模式 → action=to_passive；切回自主 → action=to_auto。
- 若用户要暂停但当前已是 paused，或要恢复但当前已是 running/running_passive：仍调用 set_campaign_status 对应 action（工具会返回幂等说明）。`;
      }
    } catch {
      /* ignore */
    }

    const hasFileAttachments = lastAttachments.some((a) => a?.storageKey);
    const historyAttachments = collectAttachmentsFromHistory(messages);
    const attachmentsForImport = hasFileAttachments ? lastAttachments : historyAttachments;
    try {
      const attachmentsContext = buildAttachmentContextForPrompt(
        attachmentsForImport.filter((a) => a?.storageKey)
      );

      const { decision } = await decideExecutionSchedulerTurn(
        {
          campaignId,
          campaignStatusHint,
          campaignSnapshotHint,
          lastMessage,
          recentMessages: messages
            .slice(-5)
            .map((m) => `${m.role}: ${String(m.content || "").slice(0, 800)}`)
            .join("\n"),
          attachmentsContext,
          toolsDesc: CAMPAIGN_EXECUTION_TOOL_SCHEMAS.map(
            (t) => `- ${t.name}: ${t.description}`
          ).join("\n"),
          messages,
          attachmentsForImport,
        },
        { onSchedulerProgress: options.onSchedulerProgress }
      );

      if (decision.needTool && decision.toolName && TOOL_NAMES.includes(decision.toolName)) {
        let params = {
          ...(decision.params || {}),
          campaignId: decision.params?.campaignId || campaignId,
        };

        if (decision.toolName === "ask_influencer_special_request") {
          if (typeof params.influencerId === "string") {
            params.influencerId = params.influencerId.replace(/^@/, "").trim();
          }
          if (Array.isArray(params.requests) && params.requests.length) {
            params.requests = params.requests.map((r) => ({
              ...(r || {}),
              influencerId: String(r?.influencerId || "").replace(/^@/, "").trim(),
            }));
          }
        }

        if (decision.toolName === "set_campaign_status" && !params.action && params.status) {
          const st = String(params.status).toLowerCase();
          if (st === "paused") params.action = "pause";
          else if (st === "running" || st === "running_passive") params.action = "resume";
          else if (st === "completed") params.action = "complete";
        }

        let reply = "正在处理你的请求…";
        if (decision.toolName === "set_report_schedule") reply = "正在设置汇报偏好…";
        else if (decision.toolName === "set_execution_pacing") reply = "正在调整执行速度…";
        else if (decision.toolName === "set_campaign_status") reply = "正在更新 Campaign 运行状态…";
        else if (decision.toolName === "modify_campaign") reply = "正在修改 campaign 并通知红人经纪人…";
        else if (decision.toolName === "ask_influencer_special_request") reply = "正在向红人发起请求…";
        else if (decision.toolName === "get_influencer_special_request_feedback") reply = "正在查询红人反馈…";
        else if (decision.toolName === "get_campaign_execution_status") reply = "正在获取执行状态…";
        else if (decision.toolName === "approve_quote") reply = "正在同意报价…";
        else if (decision.toolName === "reject_quote") reply = "正在暂不通过…";
        else if (decision.toolName === "confirm_ship") reply = "正在确认寄样…";
        else if (decision.toolName === "approve_draft") reply = "正在通过草稿…";
        else if (decision.toolName === "reject_draft") reply = "正在记录修改建议…";
        else if (decision.toolName === "update_published") reply = "正在更新发布数据…";
        else if (decision.toolName === "import_influencer_list") reply = "正在处理红人名单…";
        return {
          reply,
          toolCall: { toolName: decision.toolName, params },
          campaignSnapshotHint,
        };
      }

      if (decision.reply) {
        return { reply: decision.reply, toolCall: null, campaignSnapshotHint };
      }

      const directReply = await generateConfigInquiryReply({
        messages,
        campaignSnapshotHint,
      });
      return { reply: directReply, toolCall: null, campaignSnapshotHint };
    } catch (err) {
      console.error("[CampaignExecutionAgent] processWithTools 失败:", err);
      return {
        reply: "处理时出了点问题，请重试或换一种说法。",
        toolCall: null,
      };
    }
  }

  /**
   * 根据工具执行结果生成面向用户的回复（可选，用于润色）
   * @param {string} toolName
   * @param {Object} toolResult - { success, data, message }
   * @param {Array} messages
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async replyFromToolResult(toolName, toolResult, messages, context) {
    if (toolResult.success === false && toolResult.message) {
      return toolResult.message;
    }
    if (toolName === "import_influencer_list") {
      return toolResult.message || "红人名单已提交处理。";
    }
    if (toolName === "modify_campaign" && toolResult.success) {
      const changes = toolResult.data?.changes || {};
      return formatConciseModifyCampaignReply(changes);
    }
    if (toolName === "set_execution_pacing" && toolResult.success) {
      const daily = toolResult.data?.influencersPerDay;
      if (typeof daily === "number" && daily > 0) {
        return `已调整为每天联系 ${daily} 位红人。`;
      }
    }
    if (toolName === "set_campaign_status" && toolResult.success) {
      const label = toolResult.data?.statusLabel;
      if (label) return `Campaign 状态已更新为「${label}」。`;
    }
    if (toolName === "get_campaign_execution_status" && toolResult.success) {
      const campaignId =
        typeof context.campaignId === "string" ? context.campaignId.trim() : "";
      let snapshotHint = context.campaignSnapshotHint || "";
      if (!snapshotHint && campaignId) {
        try {
          const bundle = await loadCampaignSnapshotBundle(campaignId);
          snapshotHint = bundle.campaignSnapshotHint || "";
        } catch {
          /* ignore */
        }
      }
      return generateProgressInquiryReply({
        messages,
        campaignSnapshotHint: snapshotHint,
        executionData: toolResult.data,
      });
    }
    if (toolResult.message && !isReplyTooVerbose(toolResult.message)) {
      return toolResult.message;
    }
    if (toolResult.success && toolResult.data) {
      return `操作完成。${JSON.stringify(toolResult.data, null, 2)}`;
    }
    return toolResult.message || "操作已完成。";
  }
}
