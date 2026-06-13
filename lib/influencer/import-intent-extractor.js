import { callDeepSeekLLM } from "../utils/llm-client.js";
import { sampleAttachmentForLlm } from "./apply-extraction-plan.js";
import { readSessionImportFile } from "./session-import-storage.js";

/**
 * @param {string} text
 */
export function shouldRunImportIntentExtractor(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return true;
  if (/@[a-zA-Z0-9._-]+/.test(t)) return true;
  if (/联系|名单|导入|上传|发邮件|邀约|reach out|contact|import|upload/i.test(t)) return true;
  return false;
}

/**
 * @param {object} input
 * @param {string} input.userMessage
 * @param {Array} [input.attachments]
 * @param {string} [input.campaignId]
 */
export async function extractImportIntent(input = {}) {
  const userMessage = String(input.userMessage || "").trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const fileAttachments = attachments.filter((a) => a?.storageKey);

  let attachmentContext = "";
  for (const att of fileAttachments) {
    const buffer = readSessionImportFile(att.storageKey);
    if (!buffer?.length) continue;
    const sample = sampleAttachmentForLlm(buffer, {
      fileName: att.name || "file.xlsx",
      maxRows: 15,
    });
    const sheetBlocks = sample.samples
      .map(
        (s) =>
          `【Sheet: ${s.sheet}】约 ${s.totalRows} 行\n${s.previewText}`
      )
      .join("\n\n");
    attachmentContext += `\n附件「${att.name || sample.fileName}」（storageKey: ${att.storageKey}）\n${sheetBlocks}\n`;
  }

  const prompt = `你是 Campaign 执行阶段的「红人名单导入意图分析器」。根据用户消息与附件样本，输出 JSON。

【用户消息】
${userMessage || "(无文字，仅有附件)"}

【附件样本（表头+前15行）】
${attachmentContext || "(无附件)"}

【意图类型 intent】
- import_and_contact：用户要把红人导入 campaign，并在分析后按心跳规则联系
- chat_only：用户只是问表格内容、看报价是否合理，不是要导入联系
- unclear：无法判断

【规则】
1. 文字部分：从用户消息中识别明确出现的账号/链接，填入 textItems，每项给出完整 profileUrl，最多 200 条；不得编造用户未提供的账号。
2. 附件部分：只输出 attachmentPlan（列映射与 sheet），不要逐行输出全表。
3. rowRules 支持 profile_url 或 username_platform；平台列可为 ins/ytb/tk。
4. needsConfirmation=true 仅当 confidence=low 或 intent=unclear 或列映射歧义。

输出 JSON：
{
  "intent": "import_and_contact" | "chat_only" | "unclear",
  "confidence": "high" | "low",
  "needsConfirmation": boolean,
  "confirmationQuestion": string | null,
  "attachmentPlan": { "storageKey", "fileName", "sheet", "headerRow", "rowRules", "emailColumn" } | null,
  "textItems": [{ "profileUrl", "username", "platform", "evidence" }],
  "warnings": [string]
}

只返回 JSON。`;

  try {
    const raw = await callDeepSeekLLM(
      [{ role: "user", content: prompt }],
      "你只输出 JSON，用于判断用户是否要导入红人名单并联系。"
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!parsed || typeof parsed !== "object") {
      return fallbackResult(userMessage, fileAttachments, "无法解析模型输出");
    }

    if (!parsed.attachmentPlan?.storageKey && fileAttachments.length === 1) {
      parsed.attachmentPlan = {
        storageKey: fileAttachments[0].storageKey,
        fileName: fileAttachments[0].name,
        sheet: 0,
        headerRow: 1,
        rowRules: [
          { priority: 1, kind: "profile_url", column: "主页链接" },
          {
            priority: 2,
            kind: "username_platform",
            usernameColumn: "红人用户名",
            platformColumn: "红人平台",
          },
        ],
      };
    } else if (parsed.attachmentPlan?.storageKey) {
      const att = fileAttachments.find((a) => a.storageKey === parsed.attachmentPlan.storageKey);
      if (att) parsed.attachmentPlan.fileName = parsed.attachmentPlan.fileName || att.name;
    }

    if (!Array.isArray(parsed.textItems)) parsed.textItems = [];
    if (!Array.isArray(parsed.warnings)) parsed.warnings = [];

    if (parsed.intent === "unclear" || parsed.confidence === "low") {
      parsed.needsConfirmation = true;
    }
    if (parsed.needsConfirmation && !parsed.confirmationQuestion) {
      parsed.confirmationQuestion =
        "请确认：您是要将这批红人导入并按当前节奏排队联系，还是只想让我帮您解读这份表格？";
    }

    return parsed;
  } catch (err) {
    console.warn("[extractImportIntent] 失败:", err?.message || err);
    return fallbackResult(userMessage, fileAttachments, err?.message || "分析失败");
  }
}

function fallbackResult(userMessage, fileAttachments, warning) {
  const hasFile = fileAttachments.length > 0;
  const textLikely = shouldRunImportIntentExtractor(userMessage);
  return {
    intent: hasFile || textLikely ? "import_and_contact" : "unclear",
    confidence: "low",
    needsConfirmation: true,
    confirmationQuestion:
      "请确认您的意图：是要导入红人名单并排队联系，还是只想让我帮您解读附件/文字内容？",
    attachmentPlan: hasFile
      ? {
          storageKey: fileAttachments[0].storageKey,
          fileName: fileAttachments[0].name,
          sheet: 0,
          headerRow: 1,
          rowRules: [
            { priority: 1, kind: "profile_url", column: "主页链接" },
            {
              priority: 2,
              kind: "username_platform",
              usernameColumn: "用户名",
              platformColumn: "平台",
            },
          ],
        }
      : null,
    textItems: [],
    warnings: [warning].filter(Boolean),
  };
}
