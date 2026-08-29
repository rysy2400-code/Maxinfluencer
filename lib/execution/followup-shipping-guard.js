/**
 * 广告主跟进邮件中「寄样地址确认」的统一判定与兜底拦截。
 *
 * 背景：此前只要红人有寄样地址（hasShippingInfo=true），所有动作的跟进邮件
 * 都会被强制要求展示地址并询问确认，导致样品已寄出、处于发布阶段的红人
 * 仍反复收到「确认寄样地址」的邮件（如 approveDraft / rejectDraft）。
 * 这里把「是否需要在本次邮件中确认地址」收敛为纯函数，便于测试与复用。
 * 规则：地址确认只发生在 approveQuote（复用旧地址时确认本次是否可用）；
 * confirmShip 只通知样品已寄出，不再展示或确认地址。
 */

/**
 * 邮件正文中可能合法提及寄样/发货的动作（发送前兜底放行名单）。
 * 注意：这是「可以提寄样」的范围，不代表「要确认地址」——地址确认仅 approveQuote。
 */
export const SHIPPING_MENTION_ACTIONS = new Set(["approveQuote", "confirmShip"]);

/**
 * 判定本次跟进邮件是否需要向红人确认寄样地址。
 * - approveQuote：仅在尚未寄样（sampleSentAt 为空）且已有地址时确认地址；
 * - 其余动作（confirmShip / approveScript / rejectDraft / approveDraft / 报价类等）：一律 false。
 *
 * @param {{ action: string, hasShippingInfo: boolean, sampleSentAt?: string|null }} opts
 */
export function resolveAskShippingConfirmation({ action, hasShippingInfo, sampleSentAt }) {
  if (action !== "approveQuote") return false;
  if (!hasShippingInfo) return false;
  return !sampleSentAt;
}

/** 邮件正文中不允许出现「确认收件地址」类表述。 */
const ADDRESS_CONFIRM_PATTERNS = [
  /\bconfirm.{0,60}(this )?(address|shipping)/i,
  /\b(address|shipping (details|info)).{0,40}(good to use|correct|right one|is good)/i,
];

/** 邮件正文中不允许出现「样品即将寄出」类表述。 */
const SHIPMENT_GOING_OUT_PATTERNS = [
  /\b(shipment|sample).{0,30}(about to|going out|ready to (go|send|ship)|is on its way)/i,
];

export function containsForbiddenAddressConfirm(body) {
  const text = String(body || "");
  return ADDRESS_CONFIRM_PATTERNS.some((re) => re.test(text));
}

export function containsForbiddenShippingConfirm(body) {
  const text = String(body || "");
  return ADDRESS_CONFIRM_PATTERNS.some((re) => re.test(text)) ||
    SHIPMENT_GOING_OUT_PATTERNS.some((re) => re.test(text));
}
