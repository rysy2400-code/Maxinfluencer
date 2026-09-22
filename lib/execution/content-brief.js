import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  isChatUploadFileName,
  normalizeAttachmentContentType,
} from "../influencer/attachment-file-types.js";

/** @typedef {'reference_script' | 'free_creative'} ContentBriefMode */

export const CONTENT_BRIEF_MODE_REFERENCE = "reference_script";
export const CONTENT_BRIEF_MODE_FREE = "free_creative";

const HTTPS_URL_RE = /^https:\/\/.+/i;

/**
 * 归一化「严格参考脚本」模式下随确认邮件发给红人的附件：
 * 过滤缺失 storageKey / 文件名、扩展名不在聊天框白名单内、重复项的记录，
 * 并按单封上限截断。体积在专用上传接口已校验。
 */
function normalizeContentBriefAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const items = [];
  for (const item of raw) {
    if (items.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    const fileName = String(item?.fileName ?? item?.name ?? "").trim();
    const storageKey = String(item?.storageKey || "").trim();
    if (!fileName || !storageKey) continue;
    if (!isChatUploadFileName(fileName)) continue;
    if (seen.has(storageKey)) continue;
    seen.add(storageKey);
    const sizeBytes = Number(item?.sizeBytes);
    items.push({
      fileName,
      storageKey,
      contentType: normalizeAttachmentContentType(fileName, item?.contentType),
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    });
  }
  return items;
}

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
    const attachments = normalizeContentBriefAttachments(p.attachments);
    if (!linkRaw && !attachments.length) {
      return {
        ok: false,
        message: "严格参考脚本模式下请填写脚本链接，或上传脚本附件（两者至少一个）",
      };
    }
    if (linkRaw && !HTTPS_URL_RE.test(linkRaw)) {
      return { ok: false, message: "脚本链接须以 https:// 开头" };
    }
    scriptLink = linkRaw || null;

    return {
      ok: true,
      contentBrief: {
        mode,
        scriptLink,
        attachments,
        scriptNotes,
        chosenAt: new Date().toISOString(),
        source: String(source || "advertiser_portal").slice(0, 64),
      },
    };
  }

  return {
    ok: true,
    contentBrief: {
      mode,
      scriptLink,
      scriptNotes,
      attachments: [],
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
- 本条为合作确认邮件，但未收到 contentBrief；请通知合作已确认，并请红人**先提交脚本（script）供品牌审核**（脚本通过后再进入拍摄、提交视频草稿）。勿编造脚本链接。`;
  }

  const mode = contentBrief.mode;
  const scriptLink = contentBrief.scriptLink || null;
  const scriptNotes = contentBrief.scriptNotes || null;
  const attachments = Array.isArray(contentBrief.attachments)
    ? contentBrief.attachments
    : [];
  const attachmentNames = attachments
    .map((a) => String(a?.fileName || "").trim())
    .filter(Boolean);

  if (mode === CONTENT_BRIEF_MODE_REFERENCE) {
    const linkRule = scriptLink
      ? `- 正文**必须**包含 scriptLink 中的完整 URL（一字不差）：${scriptLink}`
      : `- 本次没有脚本链接（scriptLink 为空）：正文**禁止**编造链接，也**禁止**声称下方有链接；参考内容以随信附件为准。`;
    const attachmentRule = attachmentNames.length
      ? `- 本次随信附带了脚本 / 参考资料附件：${attachmentNames.join("、")}。正文**必须**用文件名自然提及附件（例如「please see the attached ${attachmentNames[0]}」），并说明品牌给的参考方向见附件。`
      : "";
    return `
- 本条为合作确认 + **严格参考脚本**模式。
${linkRule}
${attachmentRule}
- 若有 scriptNotes，用英文自然转述为 brand notes；若无则省略。
- 合作确认后的下一步**仍然是先提交脚本**：参考脚本只是方向指引，不能替代红人自己提交的脚本；请红人据此**先提交脚本（script）供品牌审核**，脚本通过后再按脚本拍摄并提交视频草稿（video draft）链接。
- **禁止**在正文粘贴脚本全文、分镜、hashtags、时长要求或 keyPoints 列表。
- **禁止**说必须逐字照读，除非 scriptNotes 明确要求；语气为 please use this as a reference brief.`;
  }

  if (mode === CONTENT_BRIEF_MODE_FREE) {
    return `
- 本条为合作确认 + **自由发挥**模式。
- 正文可说明红人可按**产品卖点**与个人视频风格自由创作（no fixed script / creative freedom），但**创作自由不等于跳过脚本**：必须请红人**先提交脚本（script）供品牌审核**，脚本通过后再按脚本拍摄并提交视频草稿（video draft）链接。
- 若有 scriptNotes，**必须**用英文自然转述，尤其是其中「先出脚本 / 尽快开始脚本 / 期待你的脚本」这类对脚本的要求；不得因为「自由发挥」而省略或弱化；若无 scriptNotes 则省略。
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
