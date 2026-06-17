import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

/** @returns {string} */
export function getInvoiceStorageDir(advertiserId) {
  return path.join(projectRoot, "storage", "invoices", String(advertiserId));
}

/** @param {string} storageKey */
export function resolveInvoicePdfPath(storageKey) {
  if (!storageKey) return null;
  const abs = path.join(projectRoot, storageKey);
  if (!abs.startsWith(path.join(projectRoot, "storage", "invoices"))) return null;
  return abs;
}

/**
 * @param {number} advertiserId
 * @param {'recharge' | 'monthly_consumption'} invoiceType
 * @param {string} periodYyyymm
 */
export async function nextInvoiceSeq(advertiserId, invoiceType, periodYyyymm) {
  const rows = await queryTikTok(
    `SELECT MAX(seq) AS max_seq FROM tiktok_advertiser_invoice
     WHERE advertiser_id = ? AND invoice_type = ? AND period_yyyymm = ?`,
    [advertiserId, invoiceType, periodYyyymm]
  );
  return (Number(rows?.[0]?.max_seq) || 0) + 1;
}

/**
 * @param {'R' | 'M'} prefix
 * @param {string} periodYyyymm
 * @param {number} seq
 */
export function formatInvoiceNo(prefix, periodYyyymm, seq) {
  return `GCG-${prefix}-${periodYyyymm}-${String(seq).padStart(4, "0")}`;
}

/**
 * @param {number} advertiserId
 */
export async function getInvoicedRechargeLedgerIds(advertiserId) {
  const rows = await queryTikTok(
    `SELECT related_ledger_ids FROM tiktok_advertiser_invoice
     WHERE advertiser_id = ? AND invoice_type = 'recharge'`,
    [advertiserId]
  );
  const ids = new Set();
  for (const row of rows || []) {
    parseJsonIds(row.related_ledger_ids).forEach((id) => ids.add(id));
  }
  return ids;
}

/**
 * @param {number} advertiserId
 * @returns {Promise<Set<string>>}
 */
export async function getInvoicedConsumptionPeriods(advertiserId) {
  const rows = await queryTikTok(
    `SELECT period_yyyymm FROM tiktok_advertiser_invoice
     WHERE advertiser_id = ? AND invoice_type = 'monthly_consumption'`,
    [advertiserId]
  );
  return new Set((rows || []).map((r) => String(r.period_yyyymm)));
}

/** @param {unknown} raw */
function parseJsonIds(raw) {
  if (Array.isArray(raw)) return raw.map((v) => Number(v)).filter(Number.isFinite);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => Number(v)).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {number} invoiceId
 * @param {number} advertiserId
 */
export async function getInvoiceById(invoiceId, advertiserId) {
  const rows = await queryTikTok(
    `SELECT * FROM tiktok_advertiser_invoice WHERE id = ? AND advertiser_id = ? LIMIT 1`,
    [invoiceId, advertiserId]
  );
  return rows?.[0] || null;
}

/**
 * @param {object} data
 */
export async function insertInvoice(data) {
  const result = await queryTikTok(
    `
    INSERT INTO tiktok_advertiser_invoice
      (advertiser_id, invoice_no, invoice_type, document_title, period_yyyymm, seq,
       period_start, period_end, amount_usd, line_items_json, pdf_storage_key,
       status, related_ledger_ids, related_top_up_id, issued_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      data.advertiserId,
      data.invoiceNo,
      data.invoiceType,
      data.documentTitle,
      data.periodYyyymm,
      data.seq,
      data.periodStart,
      data.periodEnd,
      data.amountUsd,
      JSON.stringify(data.lineItems || []),
      data.pdfStorageKey,
      data.status || "issued",
      JSON.stringify(data.relatedLedgerIds || []),
      data.relatedTopUpId || null,
      data.issuedAt,
      data.createdByUserId,
    ]
  );
  return result?.insertId;
}

/**
 * @param {number} invoiceId
 * @param {{ emailSentAt?: Date | null, emailError?: string | null, status?: string }} patch
 */
export async function updateInvoiceEmailStatus(invoiceId, patch) {
  const sets = [];
  const params = [];
  if (patch.emailSentAt !== undefined) {
    sets.push("email_sent_at = ?");
    params.push(patch.emailSentAt);
  }
  if (patch.emailError !== undefined) {
    sets.push("email_error = ?");
    params.push(patch.emailError);
  }
  if (patch.status) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (!sets.length) return;
  params.push(invoiceId);
  await queryTikTok(`UPDATE tiktok_advertiser_invoice SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** Ensure storage dir exists */
export function ensureInvoiceDir(advertiserId) {
  const dir = getInvoiceStorageDir(advertiserId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @returns {string} HKT YYYY-MM-DD */
export function formatInvoiceDateHkt(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** @returns {string} YYYYMM */
export function periodYyyymmFromDate(date = new Date()) {
  const s = formatInvoiceDateHkt(date);
  return s.slice(0, 4) + s.slice(5, 7);
}

/** @param {string} yyyymm */
export function periodBoundsFromYyyymm(yyyymm) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { periodStart: start, periodEnd: end };
}
