import { queryTikTok } from "./mysql-tiktok.js";

/**
 * 写入 tiktok_influencer_agent_event，由 process-influencer-agent-events.js 消费。
 * @param {{ influencerId?: string|null, campaignId?: string|null, eventType: string, payload: object }} opts
 * @returns {Promise<number|null>} 新事件 id
 */
export async function enqueueInfluencerAgentEvent({
  influencerId = null,
  campaignId = null,
  eventType,
  payload,
}) {
  if (!eventType) {
    throw new Error("enqueueInfluencerAgentEvent 缺少 eventType");
  }
  const result = await queryTikTok(
    `
    INSERT INTO tiktok_influencer_agent_event (
      influencer_id,
      campaign_id,
      event_type,
      payload,
      status
    ) VALUES (?, ?, ?, ?, 'pending')
  `,
    [
      influencerId != null ? String(influencerId) : null,
      campaignId != null ? String(campaignId) : null,
      eventType,
      JSON.stringify(payload || {}),
    ]
  );
  return result?.insertId ?? null;
}
