import { enqueueInfluencerAgentEvent } from "../db/influencer-agent-event-dao.js";
import { resolveNeedSample } from "./need-sample.js";

const FOLLOWUP_ACTIONS = new Set([
  "approveQuote",
  "confirmShip",
  "approveDraft",
  "rejectDraft",
]);

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasShippingInfo(shippingInfo) {
  const info = parseJson(shippingInfo) || shippingInfo;
  if (!info || typeof info !== "object") return false;
  return Boolean(
    info.fullName ||
      info.name ||
      info.addressLine ||
      info.addressLine1 ||
      info.address ||
      info.phone ||
      info.telephone
  );
}

/**
 * 广告主 Portal 操作后，写入 Influencer Agent outbound 队列。
 * @param {{
 *   campaignId: string,
 *   influencerId: string,
 *   action: string,
 *   campaign?: object,
 *   executionRow?: object,
 *   payload?: object,
 * }} opts
 */
export async function enqueueAdvertiserExecutionFollowup({
  campaignId,
  influencerId,
  action,
  campaign,
  executionRow,
  payload = {},
}) {
  if (!FOLLOWUP_ACTIONS.has(action)) return null;

  const productInfo = campaign?.productInfo || {};
  const needSample = resolveNeedSample(productInfo);
  const lastEvent =
    executionRow?.lastEvent ||
    parseJson(executionRow?.last_event) ||
    {};
  const shippingInfo =
    executionRow?.shipping_info != null
      ? parseJson(executionRow.shipping_info) || executionRow.shipping_info
      : lastEvent.shippingAddress || null;

  const eventPayload = {
    type: "advertiser_execution_followup",
    campaignId,
    influencerId,
    tiktokUsername: executionRow?.tiktok_username || influencerId,
    platformInfluencerId: executionRow?.influencer_id || null,
    action,
    needSample,
    hasShippingInfo: hasShippingInfo(shippingInfo),
    flatFee:
      executionRow?.flat_fee != null ? Number(executionRow.flat_fee) : null,
    currency: executionRow?.currency || "USD",
    draftLink: lastEvent.draftLink || payload.draftLink || null,
    draftFeedback:
      payload.feedback ||
      payload.draftFeedback ||
      lastEvent.draftFeedback ||
      null,
    stage: executionRow?.stage || null,
    createdAt: new Date().toISOString(),
    source: payload.source || "advertiser_portal",
  };

  return enqueueInfluencerAgentEvent({
    influencerId: eventPayload.platformInfluencerId || influencerId,
    campaignId,
    eventType: "advertiser_execution_followup",
    payload: eventPayload,
  });
}
