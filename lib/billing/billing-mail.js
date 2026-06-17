import { getAllOutboundAccounts } from "../email/enterprise-mail-client.js";
import { BILLING_ISSUER } from "./issuer-config.js";

function accountEmail(account) {
  return String(
    account?.email || account?.email_address || account?.username || account?.account || ""
  )
    .trim()
    .toLowerCase();
}

/** @returns {Promise<object | null>} op_contacts row with SMTP ready */
export async function getBillingOutboundAccount() {
  const target = BILLING_ISSUER.outboundEmail.trim().toLowerCase();
  const accounts = await getAllOutboundAccounts();
  return accounts.find((a) => accountEmail(a) === target) || null;
}
