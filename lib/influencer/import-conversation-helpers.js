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
