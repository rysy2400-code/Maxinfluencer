/**
 * CampaignExecutionAgent 在用户同意特殊请求时需要的合同上下文：
 * - 最新未闭合的 creator_replied_special_request
 * - 对应红人当前合同版本、Additional Terms、sectionOverrides 和已批准条款
 */
import { queryTikTok } from "../db/mysql-tiktok.js";
import { getExecutionRow } from "../db/campaign-dao.js";

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

function contractKnownSpecialRequestIds(lastEvent) {
  return new Set(
    (Array.isArray(lastEvent?.contractAppliedUpdates)
      ? lastEvent.contractAppliedUpdates
      : []
    )
      .map((item) => item?.sourceSpecialRequestId)
      .filter(Boolean)
  );
}

/**
 * @param {string} campaignId
 * @param {{ limit?: number }} [opts]
 */
export async function loadLatestPendingSpecialRequestContexts(
  campaignId,
  { limit = 5 } = {}
) {
  const cid = String(campaignId || "").trim();
  if (!cid) return [];
  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, influencer_id, payload, created_at, updated_at
    FROM tiktok_advertiser_agent_event
    WHERE campaign_id = ?
      AND event_type = 'creator_replied_special_request'
      AND status = 'succeeded'
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.specialRequestStatus')) = 'pending_brand'
    ORDER BY id DESC
    LIMIT ?
  `,
    [cid, n * 4]
  );

  const latestByInfluencer = new Map();
  for (const row of rows || []) {
    const payload = parseJson(row.payload) || {};
    const handle = String(
      payload.tiktokUsername ||
        payload.influencerId ||
        row.influencer_id ||
        ""
    )
      .replace(/^@/, "")
      .trim();
    if (!handle || latestByInfluencer.has(handle.toLowerCase())) continue;
    const execution = await getExecutionRow(cid, handle).catch(() => null);
    const lastEvent = execution?.lastEvent || {};
    const appliedIds = contractKnownSpecialRequestIds(lastEvent);
    if (
      payload.specialRequestId &&
      appliedIds.has(String(payload.specialRequestId))
    ) {
      continue;
    }
    latestByInfluencer.set(handle.toLowerCase(), {
      eventId: row.id,
      specialRequestId: payload.specialRequestId || null,
      influencerId: handle,
      platformInfluencerId:
        payload.platformInfluencerId || row.influencer_id || null,
      requestType: payload.requestType || null,
      clarificationType: payload.clarificationType || null,
      creatorMessage: payload.creatorMessage || "",
      note: payload.note || "",
      sourceMessageId: payload.sourceMessageId || null,
      at: row.updated_at || row.created_at || null,
      currentContract: {
        exists: Boolean(execution),
        stage: execution?.stage || null,
        flatFee: execution?.flat_fee ?? null,
        currency: execution?.currency || null,
        commissionPercent: execution?.commission_percent ?? null,
        contractRevision: lastEvent.contractRevision ?? null,
        approvedTerms: lastEvent.approvedTerms || null,
        contractAdditionalTerms: lastEvent.contractAdditionalTerms || [],
        contractSectionOverrides:
          lastEvent.contractSectionOverrides || {},
        quoteOptions: lastEvent.quoteOptions || [],
        selectedQuoteOptionId: lastEvent.selectedQuoteOptionId || null,
        contentBrief: lastEvent.contentBrief || null,
      },
    });
    if (latestByInfluencer.size >= n) break;
  }
  return [...latestByInfluencer.values()];
}

export function findLatestPendingSpecialRequestContext(
  contexts,
  influencerId = null
) {
  const list = Array.isArray(contexts) ? contexts : [];
  const handle = String(influencerId || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  if (!handle) return list[0] || null;
  return (
    list.find((item) => String(item?.influencerId || "").toLowerCase() === handle) ||
    null
  );
}
