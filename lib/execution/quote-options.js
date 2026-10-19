/**
 * 红人报价方案（quote options）。
 *
 * 卡片展示和品牌审批都只认当前有效方案：
 * - 红人新增或修改方案时，追加到当前有效方案集；
 * - 红人确认已有方案时，不新增行；
 * - 历史轮次保留在 quote_negotiation 和沟通记录中；
 * - 多方案未选择时，审批链路必须拒绝。
 */
import { normalizeDeliverables } from "./deliverables-resolution.js";
import { parseQuoteNegotiation } from "./quote-resolution.js";

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function textOrNull(value, max = 2000) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeAmount(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10000) / 10000;
}

function normalizeCommission(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10000) / 10000;
}

function normalizeCurrency(value, fallback = "USD") {
  const text = String(value || fallback || "USD").trim().toUpperCase().slice(0, 8);
  return text || "USD";
}

function deliverableSignature(deliverables) {
  const d = normalizeDeliverables(deliverables);
  if (!d) return "";
  return JSON.stringify({
    platforms: [...d.platforms].sort(),
    videoCount: d.videoCount,
    bioLinkDays: d.bioLinkDays,
    adCodeDays: d.adCodeDays,
    usageRightsDays: d.usageRightsDays,
    note: d.note,
  });
}

export function quoteOptionSignature(option) {
  if (!option) return "";
  return [
    String(option.role || "influencer"),
    normalizeAmount(option.amountUsd ?? option.amount ?? option.flatFeeUSD),
    normalizeCurrency(option.currency),
    normalizeCommission(option.commissionPercent),
    deliverableSignature(option.deliverables),
  ].join("|");
}

/**
 * 把 Agent 返回的单个方案归一化。
 * amountUsd / amount / flatFeeUSD 均可作为兼容输入。
 */
export function normalizeQuoteOption(raw, { index = 0, sourceEventId = null, sourceMessageId = null, quoteRoundId = null } = {}) {
  const input = parseMaybeJson(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const amountUsd = normalizeAmount(
    input.amountUsd ?? input.amount ?? input.flatFeeUSD ?? input.fixedFeeUsd
  );
  if (amountUsd == null) return null;

  const roundId =
    textOrNull(input.quoteRoundId, 128) ||
    textOrNull(quoteRoundId, 128) ||
    `QR-${sourceEventId != null ? String(sourceEventId) : Date.now()}`;
  const optionId =
    textOrNull(input.optionId, 128) ||
    `${roundId}-${String(index + 1).padStart(2, "0")}`;
  const deliverables = normalizeDeliverables(input.deliverables);

  return {
    optionId,
    quoteRoundId: roundId,
    optionLabel:
      textOrNull(input.optionLabel ?? input.label, 128) || `方案${index + 1}`,
    amountUsd,
    currency: normalizeCurrency(input.currency),
    commissionPercent: normalizeCommission(input.commissionPercent),
    deliverables: deliverables || null,
    reason: textOrNull(input.reason ?? input.note),
    sourceEventId:
      input.sourceEventId != null ? Number(input.sourceEventId) : sourceEventId,
    sourceMessageId:
      textOrNull(input.sourceMessageId, 512) ||
      textOrNull(sourceMessageId, 512),
    at:
      textOrNull(input.at ?? input.createdAt, 64) ||
      new Date().toISOString(),
  };
}

export function normalizeQuoteOptions(
  raw,
  { sourceEventId = null, sourceMessageId = null, quoteRoundId = null } = {}
) {
  if (!Array.isArray(raw)) return [];
  const roundId =
    textOrNull(quoteRoundId, 128) ||
    `QR-${sourceEventId != null ? String(sourceEventId) : Date.now()}`;
  const seen = new Set();
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const option = normalizeQuoteOption(raw[index], {
      index,
      sourceEventId,
      sourceMessageId,
      quoteRoundId: roundId,
    });
    if (!option) continue;
    const signature = quoteOptionSignature(option);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    out.push(option);
  }
  return out;
}

function normalizeExistingOption(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const amount = normalizeAmount(raw.amountUsd ?? raw.amount ?? raw.flatFeeUSD);
  if (amount == null) return null;
  return {
    optionId:
      textOrNull(raw.optionId, 128) ||
      `legacy-option-${String(index + 1).padStart(2, "0")}`,
    quoteRoundId: textOrNull(raw.quoteRoundId, 128) || "legacy-round",
    optionLabel:
      textOrNull(raw.optionLabel ?? raw.label, 128) || `方案${index + 1}`,
    amountUsd: amount,
    currency: normalizeCurrency(raw.currency),
    commissionPercent: normalizeCommission(raw.commissionPercent),
    deliverables: normalizeDeliverables(raw.deliverables) || null,
    reason: textOrNull(raw.reason ?? raw.note),
    sourceEventId:
      raw.sourceEventId != null && Number.isFinite(Number(raw.sourceEventId))
        ? Number(raw.sourceEventId)
        : null,
    sourceMessageId: textOrNull(raw.sourceMessageId, 512),
    at: textOrNull(raw.at, 64),
  };
}

function legacyOptionsFromRow(row, lastEvent) {
  const explicit = Array.isArray(lastEvent?.quoteOptions)
    ? lastEvent.quoteOptions
    : [];
  const normalizedExplicit = explicit
    .map((option, index) => normalizeExistingOption(option, index))
    .filter(Boolean);
  if (normalizedExplicit.length) return normalizedExplicit;

  const history = parseQuoteNegotiation(
    row?.quote_negotiation ?? row?.quoteNegotiation
  );
  const latestByOption = new Map();
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry?.role !== "influencer" || entry?.amount == null) continue;
    const normalized = normalizeExistingOption(entry, index);
    if (!normalized) continue;
    if (textOrNull(entry.optionId, 128)) {
      latestByOption.set(normalized.optionId, normalized);
    }
  }
  if (latestByOption.size) return [...latestByOption.values()];

  const latestInfluencer = [...history]
    .reverse()
    .find(
      (entry) =>
        entry?.role === "influencer" &&
        entry?.amount != null &&
        Number.isFinite(Number(entry.amount))
    );
  const fallbackAmount =
    latestInfluencer?.amount ?? row?.flat_fee ?? row?.flatFeeUsd ?? null;
  const amount = normalizeAmount(fallbackAmount);
  if (amount == null) return [];
  return [
    {
      optionId: "legacy-option-01",
      quoteRoundId: "legacy-round",
      optionLabel: "方案1",
      amountUsd: amount,
      currency: normalizeCurrency(
        latestInfluencer?.currency ?? row?.currency
      ),
      commissionPercent: normalizeCommission(
        row?.commission_percent ?? row?.commissionPercent
      ),
      deliverables: normalizeDeliverables(latestInfluencer?.deliverables),
      reason: textOrNull(latestInfluencer?.reason),
      sourceEventId:
        latestInfluencer?.sourceEventId != null
          ? Number(latestInfluencer.sourceEventId)
          : null,
      sourceMessageId: null,
      at: textOrNull(latestInfluencer?.at),
    },
  ];
}

export function resolveQuoteOptionsFromRow(row) {
  const lastEvent = parseMaybeJson(row?.last_event ?? row?.lastEvent) || {};
  return legacyOptionsFromRow(row, lastEvent);
}

export function resolveSelectedQuoteOptionFromRow(row) {
  const lastEvent = parseMaybeJson(row?.last_event ?? row?.lastEvent) || {};
  const options = resolveQuoteOptionsFromRow(row);
  if (!options.length) return null;
  const selectedId =
    textOrNull(lastEvent.selectedQuoteOptionId, 128) ||
    textOrNull(row?.selected_quote_option_id, 128);
  if (selectedId) {
    const selected = options.find((option) => option.optionId === selectedId);
    if (selected) return selected;
  }
  return options.length === 1 ? options[0] : null;
}

export function resolveDefaultSelectedQuoteOptionId(options) {
  return Array.isArray(options) && options.length === 1
    ? options[0].optionId
    : null;
}

/**
 * 合并当前方案集。默认保留已有方案并追加新方案；
 * 完全相同金额、币种、佣金和交付结果的重复方案会被忽略。
 */
export function mergeQuoteOptions(existingOptions, incomingOptions, { replace = false } = {}) {
  const existing = Array.isArray(existingOptions)
    ? existingOptions.map((option, index) => normalizeExistingOption(option, index)).filter(Boolean)
    : [];
  const incoming = Array.isArray(incomingOptions)
    ? incomingOptions.filter(Boolean)
    : [];
  if (replace) return incoming;

  const out = [...existing];
  const signatures = new Set(out.map(quoteOptionSignature));
  for (const option of incoming) {
    const signature = quoteOptionSignature(option);
    if (!signature || signatures.has(signature)) continue;
    signatures.add(signature);
    out.push(option);
  }
  return out;
}

export function commonOptionAmount(options) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!list.length) return null;
  const first = normalizeAmount(list[0].amountUsd);
  const currency = normalizeCurrency(list[0].currency);
  const commission = normalizeCommission(list[0].commissionPercent);
  const same = list.every(
    (option) =>
      normalizeAmount(option.amountUsd) === first &&
      normalizeCurrency(option.currency) === currency &&
      normalizeCommission(option.commissionPercent) === commission
  );
  return same ? list[0] : null;
}
