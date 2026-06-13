/**
 * @deprecated 导入意图已合并至 resolve-influencer-import-turn（Campaign 执行单链路）。
 * 此文件保留 helper 导出与 extractImportIntent 兼容别名。
 */
export {
  shouldRunImportIntentExtractor,
  looksLikeImportConfirmation,
  collectAttachmentsFromHistory,
  extractProfileUrlsFromMessages,
  urlsToTextItems,
  formatRecentDialogue,
} from "./import-conversation-helpers.js";

export { resolveInfluencerImportTurn } from "./resolve-influencer-import-turn.js";

import { resolveInfluencerImportTurn } from "./resolve-influencer-import-turn.js";

/** @deprecated 请使用 resolveInfluencerImportTurn */
export async function extractImportIntent(input = {}) {
  const turn = await resolveInfluencerImportTurn(input);
  return {
    intent:
      turn.phase === "import"
        ? "import_and_contact"
        : turn.phase === "chat_only"
          ? "chat_only"
          : "unclear",
    confidence: turn.phase === "confirm" ? "low" : "high",
    needsConfirmation: turn.phase === "confirm",
    confirmationQuestion: turn.phase === "confirm" ? turn.reply : null,
    attachmentPlan: turn.attachmentPlan,
    textItems: turn.textItems,
    warnings: turn.warnings,
    reply: turn.reply,
  };
}
