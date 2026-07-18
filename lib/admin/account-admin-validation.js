export function normalizeRequiredText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) return null;
  return text;
}

export function validateSixDigitPassword(value) {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

export function normalizeAccountRole(value) {
  return value === "company_admin" ? "company_admin" : value === "member" ? "member" : null;
}

export function normalizeUsdAmount(value) {
  const text = typeof value === "number" ? String(value) : String(value || "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isSafeInteger(Math.round(amount * 100)) || amount <= 0 || amount > 9999999999.99) {
    return null;
  }
  return amount.toFixed(2);
}

export function normalizeIsoDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

export function makeManualReference(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0").toUpperCase();
  return `MANUAL-${stamp}-${suffix}`;
}
