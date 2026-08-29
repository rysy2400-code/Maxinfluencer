import { enqueueInfluencerAgentEvent } from "../db/influencer-agent-event-dao.js";
import { resolveNeedSample } from "./need-sample.js";
import { resolveReusableShippingInfo } from "./shipping-info.js";
import { resolveAskShippingConfirmation } from "./followup-shipping-guard.js";

const FOLLOWUP_ACTIONS = new Set([
  "approveQuote",
  "confirmSystemQuote",
  "askSystemQuoteAtPrice",
  "rejectQuote",
  "submitQuote",
  "confirmShip",
  "approveDraft",
  "approveScript",
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

function buildCampaignContext(campaign) {
  const productInfo = campaign?.productInfo || {};
  const campaignInfo = campaign?.campaignInfo || {};
  return {
    brandName: productInfo.brandName || null,
    productName: productInfo.productName || null,
    productLink: productInfo.productLink || null,
    platform: campaignInfo.platform || null,
    deliverables: campaignInfo.deliverables || null,
  };
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
  const effectiveAction =
    action === "submitQuote" &&
    executionRow?.quote_origin === "commerce_profile_estimate"
      ? "askSystemQuoteAtPrice"
      : action === "approveDraft" && payload.kind === "script"
      ? "approveScript"
      : action;

  const productInfo = campaign?.productInfo || {};
  const needSample = resolveNeedSample(productInfo);
  const lastEvent =
    executionRow?.lastEvent ||
    parseJson(executionRow?.last_event) ||
    {};
  let shippingInfo =
    executionRow?.shipping_info != null
      ? parseJson(executionRow.shipping_info) || executionRow.shipping_info
      : lastEvent.shippingAddress || null;
  if (!hasShippingInfo(shippingInfo) && needSample) {
    shippingInfo = await resolveReusableShippingInfo(
      executionRow?.influencer_id || influencerId
    ).catch(() => null);
  }
  const shippingInfoObj = parseJson(shippingInfo) || null;
  const sampleSentAt = lastEvent.sampleSentAt || null;
  const shippingConfirmedAt =
    lastEvent.shippingConfirmedAt ||
    lastEvent.shippingAddressConfirmedAt ||
    shippingInfoObj?.lastConfirmedAt ||
    null;
  const askShippingConfirmation = resolveAskShippingConfirmation({
    action: effectiveAction,
    hasShippingInfo: hasShippingInfo(shippingInfo),
    sampleSentAt,
  });

  const eventPayload = {
    type: "advertiser_execution_followup",
    campaignId,
    influencerId,
    tiktokUsername: executionRow?.tiktok_username || influencerId,
    platformInfluencerId: executionRow?.influencer_id || null,
    action: effectiveAction,
    campaignContext: buildCampaignContext(campaign),
    needSample,
    hasShippingInfo: hasShippingInfo(shippingInfo),
    shippingInfo: shippingInfo || null,
    sampleSentAt,
    shippingConfirmedAt,
    askShippingConfirmation,
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
    contentBrief:
      payload.contentBrief ||
      parseJson(executionRow?.last_event)?.contentBrief ||
      executionRow?.lastEvent?.contentBrief ||
      null,
    createdAt: new Date().toISOString(),
    source: payload.source || "advertiser_portal",
  };

  if (action === "submitQuote") {
    const amt = Number(payload.amount);
    const counterCurrency = String(payload.currency || executionRow?.currency || "USD")
      .trim()
      .toUpperCase()
      .slice(0, 8);
    eventPayload.counterOffer =
      Number.isFinite(amt) && amt > 0
        ? { amount: amt, currency: counterCurrency || "USD" }
        : null;
    const reasonRaw =
      typeof payload.reason === "string"
        ? payload.reason.trim()
        : typeof payload.counterReason === "string"
          ? payload.counterReason.trim()
          : "";
    eventPayload.counterReason = reasonRaw ? reasonRaw.slice(0, 2000) : null;
  }

  return enqueueInfluencerAgentEvent({
    influencerId: eventPayload.platformInfluencerId || influencerId,
    campaignId,
    eventType: "advertiser_execution_followup",
    payload: eventPayload,
  });
}
