import {
  getBillingNotificationConfig,
  getBillingProfile,
} from "./billing-profile-dao.js";

/**
 * @param {number} advertiserId
 * @returns {Promise<{ ok: true, profile: object, notifyEmails: string[] } | { ok: false, error: string }>}
 */
export async function validateBillingReadyForInvoice(advertiserId) {
  const [profileRow, notifyConfig] = await Promise.all([
    getBillingProfile(advertiserId),
    getBillingNotificationConfig(advertiserId),
  ]);

  if (!profileRow) {
    return { ok: false, error: "请先填写并保存开票抬头" };
  }

  const missing = [];
  if (!String(profileRow.company_legal_name || "").trim()) missing.push("公司法定名称");
  if (!String(profileRow.company_address || "").trim()) missing.push("公司地址");
  if (!String(profileRow.contact_name || "").trim()) missing.push("联系人");
  if (!String(profileRow.contact_email || "").trim()) missing.push("联系邮箱");
  if (missing.length) {
    return { ok: false, error: `开票抬头不完整：${missing.join("、")}` };
  }

  const notifyEmails = notifyConfig.financeNotifyEmails || [];
  if (!notifyEmails.length) {
    return { ok: false, error: "请先在通知设置中保存至少一个财务通知邮箱" };
  }

  return {
    ok: true,
    profile: {
      companyLegalName: profileRow.company_legal_name,
      companyAddress: profileRow.company_address,
      contactName: profileRow.contact_name,
      contactEmail: profileRow.contact_email,
      taxId: profileRow.tax_id || "",
      country: profileRow.country || "",
    },
    notifyEmails,
  };
}
