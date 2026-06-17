import fs from "fs";
import path from "path";
import { validateBillingReadyForInvoice } from "./validate-billing-ready.js";
import {
  ensureInvoiceDir,
  formatInvoiceDateHkt,
  formatInvoiceNo,
  getInvoicedRechargeLedgerIds,
  getInvoicedConsumptionPeriods,
  insertInvoice,
  nextInvoiceSeq,
  periodBoundsFromYyyymm,
  periodYyyymmFromDate,
  updateInvoiceEmailStatus,
} from "./invoice-dao.js";
import {
  getConsumptionLedgerRows,
  getRechargeLedgerRow,
} from "./invoice-eligible.js";
import { renderInvoicePdf } from "./invoice-pdf.js";
import { sendInvoiceEmail } from "./invoice-email.js";
import { BILLING_ISSUER } from "./issuer-config.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} advertiserId
 * @param {number} ledgerId
 */
async function buildRechargeLineItems(advertiserId, ledgerId) {
  const row = await getRechargeLedgerRow(advertiserId, ledgerId);
  if (!row) throw new Error("充值记录不存在");
  const amount = num(row.amount);
  return {
    row,
    lineItems: [
      {
        campaignName: "Prepaid top-up",
        influencerName: "—",
        influencerFee: null,
        platformFee: null,
        total: amount,
      },
    ],
    amountUsd: amount,
    relatedLedgerIds: [Number(row.id)],
  };
}

/**
 * @param {number} advertiserId
 * @param {string} periodYyyymm
 */
async function buildConsumptionLineItems(advertiserId, periodYyyymm) {
  const rows = await getConsumptionLedgerRows(advertiserId, periodYyyymm);
  if (!rows.length) throw new Error("该月份没有消费记录");

  let amountUsd = 0;
  const lineItems = rows.map((row) => {
    const influencerFee = Math.abs(num(row.influencer_amount));
    const platformFee = Math.abs(num(row.platform_fee_amount));
    const total = Math.abs(num(row.amount)) || influencerFee + platformFee;
    amountUsd += total;
    return {
      campaignName: row.campaign_name || "—",
      influencerName: row.influencer_display_name || "—",
      influencerFee,
      platformFee,
      total,
    };
  });

  return {
    lineItems,
    amountUsd,
    relatedLedgerIds: rows.map((r) => Number(r.id)),
    periodBounds: periodBoundsFromYyyymm(periodYyyymm),
  };
}

/**
 * @param {{
 *   advertiserId: number,
 *   userId: number | null,
 *   type: 'recharge' | 'monthly_consumption',
 *   ledgerId?: number,
 *   periodYyyymm?: string,
 * }} opts
 */
export async function requestInvoice(opts) {
  const ready = await validateBillingReadyForInvoice(opts.advertiserId);
  if (!ready.ok) {
    return { ok: false, error: ready.error };
  }

  const invoiceDate = formatInvoiceDateHkt();
  let invoiceType = opts.type;
  let prefix = "M";
  let periodYyyymm = "";
  let lineItems = [];
  let amountUsd = 0;
  let relatedLedgerIds = [];
  let periodStart = null;
  let periodEnd = null;

  if (invoiceType === "recharge") {
    prefix = "R";
    const ledgerId = Number(opts.ledgerId);
    if (!Number.isFinite(ledgerId) || ledgerId <= 0) {
      return { ok: false, error: "请选择一笔充值记录" };
    }
    const invoiced = await getInvoicedRechargeLedgerIds(opts.advertiserId);
    if (invoiced.has(ledgerId)) {
      return { ok: false, error: "该充值记录已开过发票" };
    }
    const built = await buildRechargeLineItems(opts.advertiserId, ledgerId);
    lineItems = built.lineItems;
    amountUsd = built.amountUsd;
    relatedLedgerIds = built.relatedLedgerIds;
    periodYyyymm = periodYyyymmFromDate(new Date(built.row.created_at));
    periodStart = formatInvoiceDateHkt(new Date(built.row.created_at));
    periodEnd = periodStart;
  } else if (invoiceType === "monthly_consumption") {
    prefix = "M";
    periodYyyymm = String(opts.periodYyyymm || "").replace(/\D/g, "").slice(0, 6);
    if (periodYyyymm.length !== 6) {
      return { ok: false, error: "请选择有效的消费月份" };
    }
    const invoicedPeriods = await getInvoicedConsumptionPeriods(opts.advertiserId);
    if (invoicedPeriods.has(periodYyyymm)) {
      return { ok: false, error: "该月份已开过发票" };
    }
    const built = await buildConsumptionLineItems(opts.advertiserId, periodYyyymm);
    lineItems = built.lineItems;
    amountUsd = built.amountUsd;
    relatedLedgerIds = built.relatedLedgerIds;
    periodStart = built.periodBounds.periodStart;
    periodEnd = built.periodBounds.periodEnd;
  } else {
    return { ok: false, error: "无效的发票类型" };
  }

  const seq = await nextInvoiceSeq(opts.advertiserId, invoiceType, periodYyyymm);
  const invoiceNo = formatInvoiceNo(prefix, periodYyyymm, seq);

  const pdfBytes = await renderInvoicePdf({
    invoiceNo,
    invoiceDate,
    billTo: ready.profile,
    lineItems,
    grandTotal: amountUsd,
  });

  ensureInvoiceDir(opts.advertiserId);
  const storageKey = path.join("storage", "invoices", String(opts.advertiserId), `${invoiceNo}.pdf`);
  const absPath = path.join(process.cwd(), storageKey);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, pdfBytes);

  const issuedAt = new Date();
  const invoiceId = await insertInvoice({
    advertiserId: opts.advertiserId,
    invoiceNo,
    invoiceType,
    documentTitle: BILLING_ISSUER.documentTitle,
    periodYyyymm,
    seq,
    periodStart,
    periodEnd,
    amountUsd,
    lineItems,
    pdfStorageKey: storageKey,
    status: "issued",
    relatedLedgerIds,
    relatedTopUpId: null,
    issuedAt,
    createdByUserId: opts.userId,
  });

  let emailSent = false;
  let emailError = null;
  try {
    await sendInvoiceEmail({
      notifyEmails: ready.notifyEmails,
      companyName: ready.profile.companyLegalName,
      invoiceNo,
      amountUsd,
      pdfBytes,
    });
    emailSent = true;
    await updateInvoiceEmailStatus(invoiceId, {
      emailSentAt: new Date(),
      emailError: null,
      status: "issued",
    });
  } catch (e) {
    emailError = e.message || "邮件发送失败";
    await updateInvoiceEmailStatus(invoiceId, {
      emailSentAt: null,
      emailError,
      status: "issued_email_failed",
    });
  }

  return {
    ok: true,
    invoice: {
      id: invoiceId,
      invoiceNo,
      invoiceType,
      amountUsd,
      issuedAt,
      emailSent,
      emailError,
    },
  };
}
