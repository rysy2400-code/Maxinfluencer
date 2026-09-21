/**
 * 发信语言规则（给 LLM 的提示词片段）。
 *
 * 2026-09 起语言判断交给模型自己看会话历史：
 * - 首封（conversationHistory 为空）→ 用兜底语言（红人主档 bio 语言）；
 * - 已有来回 → 跟随红人最近使用过的语言，红人换语言就跟着换；
 * - 只有历史里没有可判断语言的文本时，才回落到兜底语言。
 *
 * 这样「后续邮件用什么语言」不再依赖按 influencer_id 查出来的语言字段，
 * 那个字段只用于首封和兜底。
 */

const SOURCE_LABEL = {
  reply: "红人最近一次回复语言",
  bio: "红人主页简介语言（首封兜底）",
  default: "默认英语（无语言证据）",
};

/**
 * 生成中文的「语言规则」提示行，可直接拼进 system prompt。
 * @param {{
 *   language?: string|null,
 *   languageName?: string|null,   // 中文名，如「英语」
 *   languageEn?: string|null,     // 英文名，如 English
 *   source?: "reply"|"bio"|"default"|null,
 *   label?: string|null,          // 用途，如「邮件正文」
 * }} [opts]
 * @returns {string}
 */
export function buildReplyLanguageRule({
  language = "en",
  languageName = "",
  languageEn = "",
  source = null,
  label = "邮件正文",
} = {}) {
  const code = String(language || "en").trim() || "en";
  const nameZh = String(languageName || "").trim() || code;
  const nameEn = String(languageEn || "").trim() || code;
  const sourceText = SOURCE_LABEL[source] || SOURCE_LABEL.default;
  return (
    `- **语言（重要）**：${label}语言以 conversationHistory 里**红人最近使用过的语言**为准` +
    `（从他/她历史邮件的正文判断，不要只看主题或签名）。` +
    `若对话历史为空（首封），或历史里没有可判断语言的正文，才用兜底语言 ${nameZh}（${nameEn}）【来源：${sourceText}】。` +
    `红人中途换语言就跟着他/她换；不要在会话中途自行切换语言，也不要在正文里解释语言选择。` +
    `品牌名、产品名、链接、文件名、地址、日期等保留原文。`
  );
}

/**
 * 用户消息里的语言尾注（英文），与 buildReplyLanguageRule 配套。
 * @param {{ languageEn?: string|null, label?: string|null }} [opts]
 * @returns {string}
 */
export function buildReplyLanguageTail({
  languageEn = "",
  label = "email body",
} = {}) {
  const nameEn = String(languageEn || "").trim() || "English";
  return (
    `Write the ${label} in the language the creator last used in conversationHistory ` +
    `(fallback if there is no history or no readable text: ${nameEn}); ` +
    `plain text, no JSON, no extra commentary.`
  );
}
