/** @typedef {'reference_script' | 'free_creative'} ContentBriefMode */

export const CONTENT_BRIEF_MODE_REFERENCE = "reference_script";
export const CONTENT_BRIEF_MODE_FREE = "free_creative";

const HTTPS_URL_RE = /^https:\/\/.+/i;

/**
 * @param {unknown} payload
 * @param {string} [source]
 * @returns {{ ok: true, contentBrief: object } | { ok: false, message: string }}
 */
export function validateAndNormalizeContentBrief(payload, source = "advertiser_portal") {
  const p = payload && typeof payload === "object" ? payload : {};
  const rawMode = p.contentBriefMode ?? p.mode ?? null;
  const mode = String(rawMode || "").trim();

  if (mode !== CONTENT_BRIEF_MODE_REFERENCE && mode !== CONTENT_BRIEF_MODE_FREE) {
    return { ok: false, message: "请选择内容指引模式（严格参考脚本 / 自由发挥）" };
  }

  const notesRaw =
    typeof p.scriptNotes === "string"
      ? p.scriptNotes.trim()
      : typeof p.notes === "string"
        ? p.notes.trim()
        : "";
  const scriptNotes = notesRaw ? notesRaw.slice(0, 2000) : null;

  let scriptLink = null;
  if (mode === CONTENT_BRIEF_MODE_REFERENCE) {
    const linkRaw =
      typeof p.scriptLink === "string"
        ? p.scriptLink.trim()
        : typeof p.link === "string"
          ? p.link.trim()
          : "";
    if (!linkRaw) {
      return { ok: false, message: "严格参考脚本模式下请填写脚本链接" };
    }
    if (!HTTPS_URL_RE.test(linkRaw)) {
      return { ok: false, message: "脚本链接须以 https:// 开头" };
    }
    scriptLink = linkRaw;
  }

  return {
    ok: true,
    contentBrief: {
      mode,
      scriptLink,
      scriptNotes,
      chosenAt: new Date().toISOString(),
      source: String(source || "advertiser_portal").slice(0, 64),
    },
  };
}

/**
 * @param {object | null | undefined} contentBrief
 */
export function buildApproveQuoteContentBriefRules(contentBrief) {
  if (!contentBrief || typeof contentBrief !== "object") {
    return `
- 本条为合作确认邮件，但未收到 contentBrief；仅通知合作已确认与下一步（样品/草稿），勿编造脚本链接。`;
  }

  const mode = contentBrief.mode;
  const scriptLink = contentBrief.scriptLink || null;
  const scriptNotes = contentBrief.scriptNotes || null;

  if (mode === CONTENT_BRIEF_MODE_REFERENCE) {
    return `
- 本条为合作确认 + **严格参考脚本**模式。
- 正文**必须**包含 scriptLink 中的完整 URL（一字不差）：${scriptLink || "(missing)"}
- 若有 scriptNotes，用英文自然转述为 brand notes；若无则省略。
- **禁止**在正文粘贴脚本全文、分镜、hashtags、时长要求或 keyPoints 列表。
- **禁止**说必须逐字照读，除非 scriptNotes 明确要求；语气为 please use this as a reference brief.`;
  }

  if (mode === CONTENT_BRIEF_MODE_FREE) {
    return `
- 本条为合作确认 + **自由发挥**模式。
- 正文须说明红人可按**产品卖点**与个人视频风格自由创作（no fixed script / creative freedom）。
- 若有 scriptNotes，用英文自然转述；若无则省略。
- **禁止**提供脚本链接、分镜、必说台词、hashtags 或 keyPoints 列表。`;
  }

  return "";
}

/**
 * Prompt 片段：合作确认前红人问脚本时的纪律。
 */
export const CONTENT_BRIEF_PRE_APPROVAL_PROMPT_RULES = `
【脚本 / 创意要求 · 合作确认前（quoteApprovedAt 不存在）】
- 红人询问 script / creative brief / shot list / content requirements 等时：
  - 可简要说明产品/合作背景（若有 productInfo）；
  - **必须**明确：具体脚本或创意要求会在品牌确认合作后同步；
  - **禁止**提供脚本链接、分镜、必说台词、hashtags 或详细 brief；
  - **禁止**暗示合作已确认或请红人开始拍摄/交稿。`;
