/**
 * Campaign 执行阶段：红人名单导入「单轮决策」
 * 一次 LLM 调用 = 理解对话 + 生成用户回复 + 结构化 textItems / attachmentPlan
 */
import { callDeepSeekLLM } from "../utils/llm-client.js";
import {
  buildAttachmentContextForPrompt,
  buildImportTurnFallback,
  formatRecentDialogue,
  hydrateImportPayload,
  looksLikeImportConfirmation,
  normalizeAttachmentPlan,
} from "./import-conversation-helpers.js";

const IMPORT_TURN_SYSTEM = `你是 Bin 的 Campaign 执行助手。本轮消息可能关于「红人名单导入」，也可能关于「Campaign 状态/寻源模式切换」。请先判断用户意图，再选 phase。

你的任务（一次完成）：
1. 阅读最近对话、用户最新消息、【当前 Campaign 数据库状态】、Excel 样本（如有）
2. 用自然中文生成 reply（可直接展示给用户）
3. 决定 phase，并按 phase 填充字段

【phase — 五选一】
- status_tool：用户要改 Campaign **状态或寻源模式**，且**本轮没有**要导入的具体红人名单（无链接、无 Excel、无 @handle）。例如：
  · 「只按给定名单找红人」「改为名单模式」「不要自动找红人」→ statusAction=to_passive
  · 「改回自动找红人」「恢复自主分析联系」→ statusAction=to_auto
  · 「暂停 campaign」→ pause；「恢复/继续 campaign」→ resume；「完成/结项」→ complete
  须填 statusAction；reply 可简短说明即将处理，**不得**在未改库前声称「已切换/已暂停」。
- confirm：用户提供了名单/链接/Excel，但尚未明确同意导入并联系。reply 须描述看到的名单并询问是否分析后联系。
- import：用户已明确同意导入并联系（或在上轮确认后回复「是/好的」）。须填 textItems 和/或 attachmentPlan。
- chat_only：用户只想解读表格/链接，不要导入联系。
- defer_tool_router：用户在问说明类问题（如「有哪些 Campaign 状态可以修改」），或意图不清、与导入/改状态都无关。reply 直接回答；说明**当前状态**时必须严格依据【当前 Campaign 数据库状态】，不得臆测。

【statusAction】（仅 phase=status_tool 时必填）
to_passive | to_auto | pause | resume | complete

【结构化字段 — 导入相关】
- textItems：从对话中的主页链接提取，每项含 profileUrl；不得编造
- attachmentPlan：Excel 列映射；含 storageKey、fileName、headerRow、rowRules

【重要】
- 「只按名单找红人」若**没有**附带具体红人链接/文件，是改模式（status_tool），不是 confirm。
- 含「名单」二字但只是在描述寻源策略、无具体红人数据 → status_tool，不是 confirm。

只输出 JSON：
{
  "phase": "status_tool" | "confirm" | "import" | "chat_only" | "defer_tool_router",
  "statusAction": "to_passive" | "to_auto" | "pause" | "resume" | "complete" | null,
  "reply": "给用户的中文回复",
  "textItems": [{ "profileUrl", "username", "platform", "evidence" }],
  "attachmentPlan": { ... } | null,
  "warnings": [string]
}`;

/**
 * @param {{
 *   messages: Array,
 *   attachments?: Array,
 *   userMessage?: string,
 *   campaignId?: string,
 *   sessionId?: string,
 *   campaignStatusHint?: string,
 * }} input
 * @returns {Promise<{
 *   phase: 'confirm'|'import'|'chat_only'|'status_tool'|'defer_tool_router',
 *   statusAction?: string|null,
 *   reply: string,
 *   textItems: Array,
 *   attachmentPlan: object|null,
 *   warnings: string[],
 * }>}
 */
const VALID_STATUS_ACTIONS = new Set([
  "to_passive",
  "to_auto",
  "pause",
  "resume",
  "complete",
]);

export async function resolveInfluencerImportTurn(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const userMessage = String(input.userMessage ?? messages[messages.length - 1]?.content ?? "").trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const fileAttachments = attachments.filter((a) => a?.storageKey);
  const confirmingFollowUp = looksLikeImportConfirmation(userMessage, messages);
  const recentDialogue = formatRecentDialogue(messages);
  const attachmentContext = buildAttachmentContextForPrompt(fileAttachments);
  const attachmentOnlyPlaceholder =
    !userMessage ||
    /^上传附件[：:]/i.test(userMessage) ||
    userMessage === "[attachments]";

  const userPrompt = `Campaign ID: ${input.campaignId || "(未知)"}
${input.campaignStatusHint || ""}

【最近对话】
${recentDialogue || "(无)"}

【用户最新消息】
${userMessage || "(无文字，仅有附件)"}
${attachmentOnlyPlaceholder ? "\n（可能是仅上传文件/占位文案，未说明意图）" : ""}
${confirmingFollowUp ? "\n（用户在对上一轮确认问题作肯定；phase=import，从 history 提取名单）" : ""}

【Excel 样本（表头+前15行）】
${attachmentContext || "(当前轮无附件；历史消息中的 attachment storageKey 仍可用于 attachmentPlan)"}

输出 JSON。`;

  try {
    const raw = await callDeepSeekLLM(
      [{ role: "user", content: userPrompt }],
      IMPORT_TURN_SYSTEM
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!parsed || typeof parsed !== "object") {
      return buildImportTurnFallback(userMessage, fileAttachments, messages, "无法解析模型输出");
    }

    let phase = parsed.phase;
    const validPhases = [
      "confirm",
      "import",
      "chat_only",
      "status_tool",
      "defer_tool_router",
    ];
    if (!validPhases.includes(phase)) {
      phase = parsed.needsConfirmation === false ? "import" : "confirm";
    }

    const statusActionRaw =
      typeof parsed.statusAction === "string" ? parsed.statusAction.trim().toLowerCase() : "";
    const statusAction = VALID_STATUS_ACTIONS.has(statusActionRaw)
      ? statusActionRaw
      : null;

    let decision = hydrateImportPayload(
      {
        phase,
        statusAction,
        reply: String(parsed.reply || parsed.confirmationQuestion || "").trim(),
        textItems: Array.isArray(parsed.textItems) ? parsed.textItems : [],
        attachmentPlan: normalizeAttachmentPlan(parsed, fileAttachments, messages),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      },
      messages,
      userMessage
    );

    if (!decision.reply) {
      decision.reply =
        decision.phase === "import"
          ? "好的，正在处理这批红人名单。"
          : "请确认：是否希望将这批红人导入并在分析后按节奏联系？";
    }

    if (decision.phase === "import" && !decision.textItems.length && !decision.attachmentPlan) {
      return buildImportTurnFallback(
        userMessage,
        fileAttachments,
        messages,
        "模型未返回可导入的链接或附件映射"
      );
    }

    return decision;
  } catch (err) {
    console.warn("[resolveInfluencerImportTurn] 失败:", err?.message || err);
    return buildImportTurnFallback(
      userMessage,
      fileAttachments,
      messages,
      err?.message || "分析失败"
    );
  }
}
