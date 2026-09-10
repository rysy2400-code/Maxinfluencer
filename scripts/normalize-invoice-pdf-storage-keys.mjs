#!/usr/bin/env node
/**
 * 回填 tiktok_advertiser_invoice.pdf_storage_key：
 * 把历史 Windows 反斜杠路径（storage\\invoices\\...）归一化成 POSIX 相对路径。
 *
 * 用法：
 *   node scripts/normalize-invoice-pdf-storage-keys.mjs          # 预览
 *   node scripts/normalize-invoice-pdf-storage-keys.mjs --apply  # 实际写入
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  normalizeInvoicePdfStorageKey,
  updateInvoicePdfStorageKey,
} from "../lib/billing/invoice-dao.js";

const apply = process.argv.includes("--apply");

const rows = await queryTikTok(
  `SELECT id, advertiser_id, invoice_no, pdf_storage_key
     FROM tiktok_advertiser_invoice
    WHERE pdf_storage_key IS NOT NULL AND pdf_storage_key <> ''
    ORDER BY id`
);

let changed = 0;
let skipped = 0;

for (const row of rows || []) {
  const normalized = normalizeInvoicePdfStorageKey(row.pdf_storage_key);
  if (!normalized) {
    console.warn(`[skip] #${row.id} 无法识别: ${JSON.stringify(row.pdf_storage_key)}`);
    skipped += 1;
    continue;
  }
  if (normalized === row.pdf_storage_key) continue;

  changed += 1;
  console.log(`[fix] #${row.id} ${row.invoice_no}\n      ${row.pdf_storage_key} -> ${normalized}`);
  if (apply) await updateInvoicePdfStorageKey(row.id, normalized);
}

console.log(
  `${apply ? "已写入" : "预览"}：需修正 ${changed} 条，跳过 ${skipped} 条，共扫描 ${rows?.length || 0} 条`
);
if (!apply && changed > 0) console.log("加 --apply 执行写入。");

process.exit(0);
