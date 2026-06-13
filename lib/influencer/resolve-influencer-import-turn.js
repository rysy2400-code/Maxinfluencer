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

const IMPORT_TURN_SYSTEM = `你是 Bin 的 Campaign 执行助手，正在处理「红人名单导入」相关的一轮对话。

你的任务（一次完成）：
1. 阅读最近对话、用户最新消息、Excel 样本（如有）
2. 用自然中文生成 reply（可直接展示给用户）
3. 决定 phase，并填充 textItems / attachmentPlan 供后续 import_influencer_list 工具使用

【phase】
- confirm：用户尚未明确同意导入并联系（仅发链接/文件、或占位文案「上传附件：…」）。reply 须描述你看到的名单（链接数、平台、或 Excel 表头/行数），并询问是否分析后联系。此阶段勿调用工具。
- import：用户已明确同意（说了联系/导入/分析并联系，或在上轮确认后回复「是/好的」）。reply 可简短说明即将处理；须填好 textItems 和/或 attachmentPlan。
- chat_only：用户只想解读表格/链接，不要导入联系。reply 直接回答，textItems 可留空。

【结构化字段】
- textItems：从对话中出现过的主页链接提取，每项含 profileUrl；不得编造
- attachmentPlan：Excel 列映射；含 storageKey、fileName、headerRow、rowRules（profile_url 或 username_platform）
- 用户确认「是/好的」时，从**更早的用户消息**找回链接或历史 attachment 的 storageKey

【回复风格】
- 自然、具体，像 DeepSeek 一样基于上下文回复
- 勿用「已收到附件」等固定套话；纯文字链接不要说「附件」
- 确认阶段不要声称已开始导入

只输出 JSON：
{
  "phase": "confirm" | "import" | "chat_only",
  "reply": "给用户的中文回复",
  "textItems": [{ "profileUrl", "username", "platform", "evidence" }],
  "attachmentPlan": { "storageKey", "fileName", "sheet", "headerRow", "rowRules", "emailColumn" } | null,
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
 *   phase: 'confirm'|'import'|'chat_only',
 *   reply: string,
 *   textItems: Array,
 *   attachmentPlan: object|null,
 *   warnings: string[],
 * }>}
 */
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
    if (!["confirm", "import", "chat_only"].includes(phase)) {
      phase = parsed.needsConfirmation === false ? "import" : "confirm";
    }

    let decision = hydrateImportPayload(
      {
        phase,
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
