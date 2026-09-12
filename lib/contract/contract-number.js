/**
 * 合同编号：BIN-<YYYYMMDD>-<HANDLE>[-R<n>]
 * 例：首版 BIN-20260910-SHINWAMYSTERY；第 2 版 BIN-20260910-SHINWAMYSTERY-R2
 *
 * 选择该格式的原因：无需额外建表即可保证「同一红人同一天同一份合同」幂等，
 * 且从编号本身可反查红人 handle。若后续需要严格流水号（-0001），再引入合同表。
 */

/** @param {Date} [date] */
export function formatContractDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** @param {Date} [date] */
export function formatContractDateCompact(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** 生成时间戳后缀（保留历史版本用），例：20260910-144233 */
export function formatTimestampCompact(date = new Date()) {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${formatContractDateCompact(date)}-${hh}${mi}${ss}`;
}

/**
 * @param {{ handle: string, date?: Date, revision?: number }} opts
 */
export function buildContractNo({ handle, date = new Date(), revision = 1 }) {
  const slug = String(handle || "")
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toUpperCase();
  const base = `BIN-${formatContractDateCompact(date)}-${slug || "CREATOR"}`;
  const rev = Number(revision);
  return Number.isFinite(rev) && rev >= 2 ? `${base}-R${Math.floor(rev)}` : base;
}
