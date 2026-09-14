/**
 * 红人侧沟通条目计数（未读提示用）
 *
 * 未读判定需要「该红人有没有新沟通记录」，而沟通记录来自
 * quote_negotiation + last_event.deliverablesTimeline + last_event.shippingTimeline。
 * 直接读 JSON 做判定对每次 1 分钟轮询来说太重，因此在写入侧维护两个累加计数：
 *
 *   infl_event_seq：含寄样条目 —— 用于 tab 徽标 / campaign 红人数
 *   infl_card_seq ：不含寄样条目 —— 用于卡片红色数字
 *                  （方案约定：「待寄送样品」的红人卡片不显示标识）
 *
 * 计数只累加增量、不回填历史：上线时已有的沟通记录不会被判成未读。
 */

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function asArray(value) {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(value) ? value : [];
}

function countByRole(list) {
  return list.filter((entry) => entry && entry.role === "influencer").length;
}

/**
 * @param {{ quoteNegotiation?: unknown, lastEvent?: unknown }} snapshot
 * @returns {{ eventSeq: number, cardSeq: number }}
 */
export function countInfluencerEntries(snapshot = {}) {
  const quotes = asArray(snapshot.quoteNegotiation);
  const lastEvent = parseMaybeJson(snapshot.lastEvent) || {};
  const deliverables = asArray(lastEvent.deliverablesTimeline);
  const shipping = asArray(lastEvent.shippingTimeline);

  const quoteCount = countByRole(quotes);
  const deliverableCount = countByRole(deliverables);
  const shippingCount = countByRole(shipping);

  return {
    eventSeq: quoteCount + deliverableCount + shippingCount,
    cardSeq: quoteCount + deliverableCount,
  };
}

/**
 * 本次写入新增的红人侧条目数（只增不减，负数夹到 0）。
 * @param {{ quoteNegotiation?: unknown, lastEvent?: unknown }} prev
 * @param {{ quoteNegotiation?: unknown, lastEvent?: unknown }} next
 */
export function influencerEntryDelta(prev, next) {
  const before = countInfluencerEntries(prev || {});
  const after = countInfluencerEntries(next || {});
  return {
    eventDelta: Math.max(0, after.eventSeq - before.eventSeq),
    cardDelta: Math.max(0, after.cardSeq - before.cardSeq),
  };
}
