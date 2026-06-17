import { sendMail } from "../email/enterprise-mail-client.js";
import { getBillingOutboundAccount } from "./billing-mail.js";
import { BILLING_ISSUER } from "./issuer-config.js";

/**
 * @param {{
 *   notifyEmails: string[],
 *   companyName: string,
 *   invoiceNo: string,
 *   amountUsd: number,
 *   pdfBytes: Uint8Array,
 * }} opts
 */
export async function sendInvoiceEmail(opts) {
  const fromAccount = await getBillingOutboundAccount();
  if (!fromAccount) {
    throw new Error(
      `发件邮箱 ${BILLING_ISSUER.outboundEmail} 未在 op_contacts 配置 SMTP，无法发送发票邮件`
    );
  }

  const amount = Number(opts.amountUsd).toFixed(2);
  const subject = `[Maxin AI] Invoice ${opts.invoiceNo} – USD ${amount} – ${opts.companyName}`;
  const text = [
    "Dear Customer,",
    "",
    "Please find attached your invoice from Maxin AI Platform.",
    "",
    `Invoice No.: ${opts.invoiceNo}`,
    `Amount (USD): ${amount}`,
    "",
    "If you have any questions, please contact your Maxin AI account manager.",
    "",
    "Best regards,",
    "Maxin AI Platform",
    BILLING_ISSUER.companyName,
  ].join("\n");

  return sendMail({
    fromAccount,
    to: opts.notifyEmails.join(", "),
    subject,
    text,
    attachments: [
      {
        filename: `${opts.invoiceNo}.pdf`,
        contentType: "application/pdf",
        content: Buffer.from(opts.pdfBytes),
      },
    ],
  });
}
