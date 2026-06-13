import XLSX from "xlsx";
import { parseProfileUrl, normalizePlatformSlugInput } from "./parse-profile-url.js";

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

/**
 * @param {Buffer} buffer
 * @param {{ maxRows?: number }} [options]
 * @returns {{
 *   rows: Array<{ profileUrl: string, email: string|null, platform: string|null, username: string, platformSlug: string }>,
 *   parseErrors: Array<{ row: number, reason: string }>,
 *   totalRawRows: number
 * }}
 */
export function parseInfluencerListXlsx(buffer, options = {}) {
  const maxRows = Math.min(10000, Math.max(1, Number(options.maxRows || 10000)));
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames?.[0];
  if (!sheetName) {
    return { rows: [], parseErrors: [{ row: 0, reason: "Excel 无工作表" }], totalRawRows: 0 };
  }
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!matrix.length) {
    return { rows: [], parseErrors: [{ row: 0, reason: "工作表为空" }], totalRawRows: 0 };
  }

  const headers = matrix[0];
  const urlCol = findColumnIndex(headers, URL_HEADER_HINTS);
  if (urlCol < 0) {
    return {
      rows: [],
      parseErrors: [{ row: 1, reason: "未找到主页链接列（需包含 link/url/主页链接 等表头）" }],
      totalRawRows: 0,
    };
  }
  const emailCol = findColumnIndex(headers, EMAIL_HEADER_HINTS);
  const platformCol = findColumnIndex(headers, PLATFORM_HEADER_HINTS);

  const rows = [];
  const parseErrors = [];
  const seenHandles = new Set();

  for (let r = 1; r < matrix.length && rows.length < maxRows; r++) {
    const line = matrix[r];
    if (!line || !line.length) continue;
    const rawUrl = String(line[urlCol] || "").trim();
    if (!rawUrl) continue;

    const parsed = parseProfileUrl(rawUrl);
    if (!parsed) {
      parseErrors.push({ row: r + 1, reason: `无法解析主页链接: ${rawUrl.slice(0, 80)}` });
      continue;
    }

    const platformRaw = platformCol >= 0 ? String(line[platformCol] || "").trim() : "";
    const platformSlug = normalizePlatformSlugInput(platformRaw) || parsed.platformSlug;
    const platform =
      platformSlug === "instagram"
        ? "Instagram"
        : platformSlug === "youtube"
          ? "YouTube"
          : "TikTok";

    const emailRaw = emailCol >= 0 ? String(line[emailCol] || "").trim() : "";
    const email = emailRaw && emailRaw.includes("@") ? emailRaw.toLowerCase() : null;

    const key = `${platformSlug}:${parsed.username.toLowerCase()}`;
    if (seenHandles.has(key)) continue;
    seenHandles.add(key);

    rows.push({
      profileUrl: parsed.profileUrl,
      username: parsed.username,
      platformSlug,
      platform,
      email,
    });
  }

  return {
    rows,
    parseErrors,
    totalRawRows: matrix.length - 1,
  };
}
