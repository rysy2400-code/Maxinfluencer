/** @typedef {'top_up' | 'quote_approve' | 'adjustment'} LedgerType */

export const LEDGER_TYPE_LABELS = {
  top_up: "充值",
  quote_approve: "消费",
  adjustment: "调整",
};

/** @param {unknown} type */
export function ledgerTypeLabel(type) {
  const key = String(type || "");
  return LEDGER_TYPE_LABELS[key] || key || "—";
}
