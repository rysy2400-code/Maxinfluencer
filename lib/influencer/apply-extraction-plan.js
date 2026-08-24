import { loadXlsx } from "./load-xlsx.js";

function getXlsx() {
  const XLSX = loadXlsx();
  if (!XLSX?.read) {
    throw new Error("xlsx 模块加载失败");
  }
  return XLSX;
}
import {
  parseProfileUrl,
  normalizePlatformSlugInput,
  buildProfileUrl,
  canonicalizeProfileUrl,
  platformLabelFromSlug,
} from "./parse-profile-url.js";

const URL_HEADER_HINTS = [
  "主页链接",
  "主页",
  "profile",
  "profileurl",
  "profile url",
  "link",
  "url",
  "tiktok主页链接",
  "频道链接",
  "channel",
];
const EMAIL_HEADER_HINTS = ["email", "邮箱", "e-mail", "mail"];
const PLATFORM_HEADER_HINTS = ["平台", "platform", "channel type"];
const USERNAME_HEADER_HINTS = [
  "用户名",
  "账号",
  "handle",
  "username",
  "红人用户名",
  "红人账号",
  "昵称",
  "creator",
];

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function findColumnIndex(headers, hints) {
  for (let i = 0; i < headers.length; i++) {
    const h = normHeader(headers[i]);
    if (!h) continue;
    for (const hint of hints) {
      const nh = normHeader(hint);
      if (h === nh || h.includes(nh)) return i;
    }
  }
  return -1;
}

function resolveColumnIndex(headers, columnRef) {
  if (columnRef == null || columnRef === "") return -1;
  if (typeof columnRef === "number") return columnRef;
  const s = String(columnRef).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const idx = headers.findIndex(
    (h) => normHeader(h) === normHeader(s) || normHeader(h).includes(normHeader(s))
  );
  return idx;
}

function isCsvFileName(fileName) {
  return String(fileName || "").toLowerCase().endsWith(".csv");
}

/**
 * @param {Buffer} buffer
 * @param {string} [fileName]
 */
export function readWorkbook(buffer, fileName = "") {
  const isCsv = isCsvFileName(fileName);
  const XLSX = getXlsx();
  return XLSX.read(buffer, { type: "buffer", ...(isCsv ? { raw: false } : {}) });
}

/**
 * @param {Buffer} buffer
 * @param {string} [fileName]
 * @returns {string[]}
 */
export function listSheetNames(buffer, fileName = "") {
  const wb = readWorkbook(buffer, fileName);
  return wb.SheetNames || [];
}

/**
 * @param {Buffer} buffer
 * @param {string} [fileName]
 * @param {number|string} [sheetRef]
 */
export function sheetToMatrix(buffer, fileName = "", sheetRef = 0) {
  const wb = readWorkbook(buffer, fileName);
  const names = wb.SheetNames || [];
  if (!names.length) return { matrix: [], sheetName: null };
  let sheetName = names[0];
  if (typeof sheetRef === "number") {
    sheetName = names[sheetRef] || names[0];
  } else if (sheetRef != null && String(sheetRef).trim()) {
    const want = String(sheetRef).trim();
    sheetName = names.find((n) => n === want) || names[0];
  }
  const sheet = wb.Sheets[sheetName];
  const XLSX = getXlsx();
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  return { matrix, sheetName };
}

/**
 * @param {Buffer} buffer
 * @param {{ fileName?: string, maxRows?: number }} [options]
 */
export function sampleAttachmentForLlm(buffer, options = {}) {
  const fileName = options.fileName || "file.xlsx";
  const maxRows = Math.max(1, Number(options.maxRows || 15));
  const wb = readWorkbook(buffer, fileName);
  const samples = (wb.SheetNames || []).map((sheetName) => {
    const sheet = wb.Sheets[sheetName];
    const XLSX = getXlsx();
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const preview = matrix.slice(0, maxRows + 1);
    const lines = preview.map((row) =>
      (Array.isArray(row) ? row : []).map((c) => String(c ?? "").trim()).join("\t")
    );
    return { sheet: sheetName, previewText: lines.join("\n"), totalRows: Math.max(0, matrix.length - 1) };
  });
  return { fileName, sheetNames: wb.SheetNames || [], samples };
}

function rowFromProfileUrlRule(line, headers, rule) {
  const col = resolveColumnIndex(headers, rule.column);
  if (col < 0) return null;
  const rawUrl = String(line[col] || "").trim();
  if (!rawUrl) return null;
  const parsed = canonicalizeProfileUrl(rawUrl);
  if (!parsed) return { error: `无法解析主页链接: ${rawUrl.slice(0, 80)}` };
  return { row: parsedToImportRow(parsed, null) };
}

function rowFromUsernamePlatformRule(line, headers, rule) {
  const uCol = resolveColumnIndex(headers, rule.usernameColumn);
  const pCol = resolveColumnIndex(headers, rule.platformColumn);
  if (uCol < 0) return null;
  const username = String(line[uCol] || "").replace(/^@/, "").trim();
  if (!username) return null;
  const platformRaw = pCol >= 0 ? String(line[pCol] || "").trim() : "";
  const platformSlug = normalizePlatformSlugInput(platformRaw);
  if (!platformSlug) {
    return { error: `平台无法识别: ${platformRaw || "(空)"}` };
  }
  const profileUrl = buildProfileUrl(username, platformSlug);
  const parsed = canonicalizeProfileUrl(profileUrl);
  if (!parsed) return { error: `无法拼出主页链接: ${username} / ${platformRaw}` };
  return { row: parsedToImportRow(parsed, null) };
}

function parsedToImportRow(parsed, email) {
  return {
    profileUrl: parsed.profileUrl,
    username: parsed.username,
    platformSlug: parsed.platformSlug,
    platform: parsed.platform,
    email: email && String(email).includes("@") ? String(email).toLowerCase() : null,
  };
}

function extractEmailFromLine(line, headers, emailColumn) {
  if (emailColumn != null && emailColumn !== "") {
    const col = resolveColumnIndex(headers, emailColumn);
    if (col >= 0) {
      const raw = String(line[col] || "").trim();
      if (raw.includes("@")) return raw.toLowerCase();
    }
  }
  const emailCol = findColumnIndex(headers, EMAIL_HEADER_HINTS);
  if (emailCol >= 0) {
    const raw = String(line[emailCol] || "").trim();
    if (raw.includes("@")) return raw.toLowerCase();
  }
  return null;
}

function normalizeRuleKind(raw) {
  const k = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (!k) return null;
  if (k === "profile_url" || k === "profileurl" || k === "url" || k === "link") {
    return "profile_url";
  }
  if (
    k === "username_platform" ||
    k === "usernameplatform" ||
    k === "handle_platform" ||
    k === "handleplatform"
  ) {
    return "username_platform";
  }
  return null;
}

function normalizeRowRules(rowRules) {
  if (Array.isArray(rowRules)) {
    return rowRules
      .map((r, i) => ({
        priority: Number(r?.priority ?? i + 1),
        kind: normalizeRuleKind(r?.kind || r?.type || r?.ruleType),
        column: r?.column || r?.urlColumn || r?.profileUrlColumn,
        usernameColumn: r?.usernameColumn || r?.handleColumn,
        platformColumn: r?.platformColumn,
      }))
      .filter((r) => r.kind);
  }
  if (rowRules && typeof rowRules === "object") {
    const kind = normalizeRuleKind(rowRules.kind || rowRules.type || rowRules.ruleType);
    if (kind === "username_platform" || kind === "profile_url") {
      return [
        {
          priority: 1,
          kind,
          column: rowRules.column,
          usernameColumn: rowRules.usernameColumn,
          platformColumn: rowRules.platformColumn,
        },
      ];
    }
    const out = [];
    if (rowRules.profile_url || rowRules.profileUrl) {
      const block = rowRules.profile_url || rowRules.profileUrl;
      out.push({
        priority: 1,
        kind: "profile_url",
        column: block.column || block.urlColumn || block.profileUrlColumn,
      });
    }
    if (rowRules.username_platform || rowRules.usernamePlatform) {
      const block = rowRules.username_platform || rowRules.usernamePlatform;
      out.push({
        priority: 2,
        kind: "username_platform",
        usernameColumn: block.usernameColumn || block.handleColumn,
        platformColumn: block.platformColumn,
      });
    }
    return out.filter((r) => r.kind);
  }
  return [];
}

export const DEFAULT_ATTACHMENT_ROW_RULES = [
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
  {
    priority: 4,
    kind: "username_platform",
    usernameColumn: "handle",
    platformColumn: "platform",
  },
];

/**
 * @param {Buffer} buffer
 * @param {object} plan
 * @param {{ fileName?: string, maxRows?: number }} [options]
 */
export function applyAttachmentExtractionPlan(buffer, plan, options = {}) {
  const fileName = plan?.fileName || options.fileName || "file.xlsx";
  const maxRows = Math.min(10000, Math.max(1, Number(options.maxRows || 10000)));
  const headerRow = Math.max(1, Number(plan?.headerRow || 1));
  const { matrix, sheetName } = sheetToMatrix(buffer, fileName, plan?.sheet ?? 0);
  if (!matrix.length) {
    return { rows: [], parseErrors: [{ row: 0, reason: "工作表为空", source: "attachment" }], sheetName };
  }

  const headers = matrix[headerRow - 1] || matrix[0] || [];
  let rowRules = normalizeRowRules(plan?.rowRules);
  if (!rowRules.length) {
    rowRules.push({ priority: 1, kind: "profile_url", column: "主页链接" });
    rowRules.push({
      priority: 2,
      kind: "username_platform",
      usernameColumn: "红人用户名",
      platformColumn: "红人平台",
    });
  }
  rowRules.sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));

  const rows = [];
  const parseErrors = [];
  const seen = new Set();

  for (let r = headerRow; r < matrix.length && rows.length < maxRows; r++) {
    const line = matrix[r];
    if (!line || !line.length) continue;

    let parsedRow = null;
    let lastError = null;
    for (const rule of rowRules) {
      let result = null;
      if (rule.kind === "profile_url") {
        result = rowFromProfileUrlRule(line, headers, rule);
      } else if (rule.kind === "username_platform") {
        result = rowFromUsernamePlatformRule(line, headers, rule);
      }
      if (result?.row) {
        parsedRow = result.row;
        break;
      }
      if (result?.error) lastError = result.error;
    }

    if (!parsedRow) {
      if (lastError) parseErrors.push({ row: r + 1, reason: lastError, source: "attachment" });
      continue;
    }

    const email = extractEmailFromLine(line, headers, plan?.emailColumn);
    if (email) parsedRow.email = email;

    const key = `${parsedRow.platformSlug}:${parsedRow.username.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(parsedRow);
  }

  return {
    rows,
    parseErrors,
    sheetName,
    totalRawRows: Math.max(0, matrix.length - headerRow),
  };
}

/**
 * @param {Array<{ profileUrl: string, email?: string|null, evidence?: string }>} textItems
 * @param {{ maxItems?: number }} [options]
 */
export function rowsFromTextItems(textItems, options = {}) {
  const maxItems = Math.min(10000, Math.max(1, Number(options.maxItems || 10000)));
  const rows = [];
  const parseErrors = [];
  const seen = new Set();
  const list = Array.isArray(textItems) ? textItems.slice(0, maxItems) : [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {};
    const rawUrl = String(item.profileUrl || "").trim();
    if (!rawUrl) {
      parseErrors.push({
        row: i + 1,
        reason: "缺少 profileUrl",
        source: "message_text",
        evidence: item.evidence || null,
      });
      continue;
    }
    const parsed = canonicalizeProfileUrl(rawUrl);
    if (!parsed) {
      parseErrors.push({
        row: i + 1,
        reason: `链接无法识别: ${rawUrl.slice(0, 80)}`,
        source: "message_text",
        evidence: item.evidence || null,
      });
      continue;
    }
    const key = `${parsed.platformSlug}:${parsed.username.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const emailRaw = String(item.email || "").trim();
    rows.push({
      ...parsedToImportRow(parsed, emailRaw.includes("@") ? emailRaw : null),
      source: "message_text",
      evidence: item.evidence || null,
    });
  }

  return { rows, parseErrors };
}

/**
 * 合并附件行与正文行；邮箱优先用附件。
 * @param {Array<object>} attachmentRows
 * @param {Array<object>} textRows
 */
export function mergeImportRows(attachmentRows, textRows) {
  const map = new Map();

  for (const row of attachmentRows || []) {
    const key = `${row.platformSlug}:${String(row.username || "").toLowerCase()}`;
    map.set(key, { ...row, source: row.source || "attachment" });
  }

  for (const row of textRows || []) {
    const key = `${row.platformSlug}:${String(row.username || "").toLowerCase()}`;
    if (map.has(key)) continue;
    map.set(key, row);
  }

  return [...map.values()];
}
