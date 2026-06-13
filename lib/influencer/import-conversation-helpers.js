import { sampleAttachmentForLlm } from "./apply-extraction-plan.js";
import { readSessionImportFile } from "./session-import-storage.js";
import { canonicalizeProfileUrl } from "./parse-profile-url.js";

const PROFILE_URL_IN_TEXT =
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w-]+)|tiktok\.com\/@[\w.-]+|instagram\.com\/[\w.-]+)/gi;

const DEFAULT_ROW_RULES = [
  { priority: 1, kind: "profile_url", column: "主页链接" },
  {
    priority: 2,
    kind: "username_platform",
    usernameColumn: "红人用户名",
    platformColumn: "红人平台",
  },
  {
    priority: 3,
    kind: "username_platform",
    usernameColumn: "用户名",
    platformColumn: "平台",
  },
];

/** @param {string} text */
export function shouldRunImportIntentExtractor(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return true;
  if (/(?:youtube|tiktok|instagram)\.com\//i.test(t)) return true;
  if (/@[a-zA-Z0-9._-]+/.test(t)) return true;
  if (/联系|名单|导入|上传|发邮件|邀约|reach out|contact|import|upload/i.test(t)) return true;
  return false;
}

export function looksLikeImportConfirmation(text, messages) {
  const t = String(text || "").trim();
  if (!t || t.length > 24) return false;
  if (!/^(是|是的|好|好的|确认|对|没错|可以|行|嗯|ok|yes|yep|要|同意)\.?$/i.test(t)) {
    return false;
  }
  const recent = Array.isArray(messages) ? messages.slice(-8) : [];
  return recent.some(
    (m) =>
      m?.role === "assistant" &&
      /导入|联系|分析并联系|是否希望|请问你是否|确认/.test(String(m.content || ""))
  );
}

export function collectAttachmentsFromHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 2; i >= 0 && i >= list.length - 10; i--) {
    const m = list[i];
    if (m?.role !== "user" || !Array.isArray(m.attachments)) continue;
    const fileAtt = m.attachments.filter((a) => a?.storageKey);
    if (fileAtt.length) return fileAtt;
  }
  return [];
}

export function extractProfileUrlsFromMessages(messages, { excludeLastUser = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const urls = new Set();
  const end = excludeLastUser ? list.length - 1 : list.length;
  for (let i = Math.max(0, end - 10); i < end; i++) {
    const m = list[i];
    if (m?.role !== "user") continue;
    const content = String(m.content || "");
    const matches = content.match(PROFILE_URL_IN_TEXT);
    if (matches) matches.forEach((u) => urls.add(u.trim()));
  }
  return [...urls];
}

export function urlsToTextItems(urls) {
  const items = [];
  for (const rawUrl of urls) {
    const parsed = canonicalizeProfileUrl(rawUrl);
    if (!parsed) continue;
    items.push({
      profileUrl: parsed.profileUrl,
      username: parsed.username,
      platform: parsed.platform,
      evidence: rawUrl,
    });
  }
  return items;
}

export function formatRecentDialogue(messages, limit = 10) {
  const list = Array.isArray(messages) ? messages.slice(-limit) : [];
  return list
    .map((m) => {
      const role = m?.role === "assistant" ? "Bin" : "用户";
      const content = String(m?.content || "").trim().slice(0, 800);
      const att =
        Array.isArray(m?.attachments) && m.attachments.length
          ? ` [附件: ${m.attachments.map((a) => a?.name || "file").join("、")}]`
          : "";
      return `${role}: ${content || "(空)"}${att}`;
    })
    .join("\n");
}

export function buildAttachmentContextForPrompt(fileAttachments) {
  let attachmentContext = "";
  for (const att of fileAttachments) {
    const buffer = readSessionImportFile(att.storageKey);
    if (!buffer?.length) continue;
    const sample = sampleAttachmentForLlm(buffer, {
      fileName: att.name || "file.xlsx",
      maxRows: 15,
    });
    const sheetBlocks = sample.samples
      .map((s) => `【Sheet: ${s.sheet}】约 ${s.totalRows} 行\n${s.previewText}`)
      .join("\n\n");
    attachmentContext += `\n附件「${att.name || sample.fileName}」（storageKey: ${att.storageKey}）\n${sheetBlocks}\n`;
  }
  return attachmentContext;
}

export function defaultAttachmentPlan(att) {
  if (!att?.storageKey) return null;
  return {
    storageKey: att.storageKey,
    fileName: att.name || "list.xlsx",
    sheet: 0,
    headerRow: 1,
    rowRules: DEFAULT_ROW_RULES,
  };
}

export function normalizeAttachmentPlan(parsed, fileAttachments, messages) {
  const plan = parsed?.attachmentPlan || null;
  if (plan?.storageKey) {
    const att = fileAttachments.find((a) => a.storageKey === plan.storageKey);
    if (att) plan.fileName = plan.fileName || att.name;
    return plan;
  }
  if (fileAttachments.length === 1) {
    return defaultAttachmentPlan(fileAttachments[0]);
  }
  const histAtt = collectAttachmentsFromHistory(messages);
  if (histAtt.length === 1) {
    return defaultAttachmentPlan(histAtt[0]);
  }
  return null;
}

export function hydrateImportPayload(decision, messages, userMessage) {
  const out = { ...decision };
  if (!Array.isArray(out.textItems)) out.textItems = [];

  if (!out.textItems.length) {
    const fromHistory = urlsToTextItems(
      extractProfileUrlsFromMessages(messages, {
        excludeLastUser: looksLikeImportConfirmation(userMessage, messages),
      })
    );
    if (fromHistory.length) out.textItems = fromHistory;
  }

  if (looksLikeImportConfirmation(userMessage, messages)) {
    if (out.phase === "confirm") out.phase = "import";
  }

  return out;
}

export function buildImportTurnFallback(userMessage, fileAttachments, messages, warning) {
  const hasFile = fileAttachments.length > 0;
  const histAtt = collectAttachmentsFromHistory(messages);
  const confirming = looksLikeImportConfirmation(userMessage, messages);
  const textItems = urlsToTextItems(
    extractProfileUrlsFromMessages(messages, { excludeLastUser: confirming })
  );

  if (confirming && (textItems.length || hasFile || histAtt.length)) {
    return {
      phase: "import",
      reply: "好的，正在按您确认的红人名单处理。",
      textItems,
      attachmentPlan: hasFile
        ? defaultAttachmentPlan(fileAttachments[0])
        : histAtt.length === 1
          ? defaultAttachmentPlan(histAtt[0])
          : null,
      warnings: [warning].filter(Boolean),
    };
  }

  const fileHint = hasFile ? `「${fileAttachments[0].name || "文件"}」` : "";
  const reply = hasFile
    ? `我看到您提供了 Excel ${fileHint}。请确认：是否希望我将其中的红人导入当前 Campaign，并在分析后按节奏联系？`
    : textItems.length
      ? `我看到您提供了 ${textItems.length} 个红人主页链接。请确认：是否希望导入并分析后按节奏联系？`
      : "请确认：是要导入红人名单并排队联系，还是只想让我帮您解读内容？";

  return {
    phase: "confirm",
    reply,
    textItems,
    attachmentPlan: hasFile ? defaultAttachmentPlan(fileAttachments[0]) : null,
    warnings: [warning].filter(Boolean),
  };
}
