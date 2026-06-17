import { queryTikTok } from "../db/mysql-tiktok.js";

function parseJsonStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((e) => String(e || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map((e) => String(e || "").trim()).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {number} advertiserId
 */
export async function getBillingProfile(advertiserId) {
  const rows = await queryTikTok(
    `SELECT advertiser_id, company_legal_name, company_address, contact_name, contact_email,
            tax_id, country, updated_at
     FROM tiktok_advertiser_billing_profile WHERE advertiser_id = ? LIMIT 1`,
    [advertiserId]
  );
  return rows?.[0] || null;
}

/**
 * @param {number} advertiserId
 * @param {object} data
 * @param {number | null} updatedByUserId
 */
export async function upsertBillingProfile(advertiserId, data, updatedByUserId) {
  await queryTikTok(
    `
    INSERT INTO tiktok_advertiser_billing_profile
      (advertiser_id, company_legal_name, company_address, contact_name, contact_email, tax_id, country, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      company_legal_name = VALUES(company_legal_name),
      company_address = VALUES(company_address),
      contact_name = VALUES(contact_name),
      contact_email = VALUES(contact_email),
      tax_id = VALUES(tax_id),
      country = VALUES(country),
      updated_by_user_id = VALUES(updated_by_user_id)
  `,
    [
      advertiserId,
      data.companyLegalName,
      data.companyAddress,
      data.contactName,
      data.contactEmail,
      data.taxId || null,
      data.country || null,
      updatedByUserId,
    ]
  );
  return getBillingProfile(advertiserId);
}

/**
 * @param {number} advertiserId
 */
export async function getBillingNotificationConfig(advertiserId) {
  const rows = await queryTikTok(
    `SELECT finance_notify_emails, updated_at FROM tiktok_billing_notification_config WHERE advertiser_id = ? LIMIT 1`,
    [advertiserId]
  );
  const row = rows?.[0];
  if (!row) return { financeNotifyEmails: [] };
  const emails = parseJsonStringArray(row.finance_notify_emails);
  return { financeNotifyEmails: emails, updatedAt: row.updated_at };
}

/**
 * @param {number} advertiserId
 * @param {string[]} emails
 * @param {number | null} updatedByUserId
 */
export async function upsertBillingNotificationConfig(advertiserId, emails, updatedByUserId) {
  await queryTikTok(
    `
    INSERT INTO tiktok_billing_notification_config (advertiser_id, finance_notify_emails, updated_by_user_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      finance_notify_emails = VALUES(finance_notify_emails),
      updated_by_user_id = VALUES(updated_by_user_id)
  `,
    [advertiserId, JSON.stringify(emails), updatedByUserId]
  );
  return getBillingNotificationConfig(advertiserId);
}
