/**
 * 把「发送合同邮件」排入 Influencer Agent 事件队列，由
 * scripts/process-influencer-agent-events.js 消费（生成/发送/落库都在 worker 内完成）。
 */
import { enqueueInfluencerAgentEvent } from "../db/influencer-agent-event-dao.js";

/**
 * @param {{
 *   campaignId: string,
 *   influencerHandle?: string|null,
 *   platformInfluencerId?: string|null,
 *   contract?: { contractNo: string, storageKey: string, absPath: string }|null,
 * }} opts
 */
export async function enqueueContractEmail({
  campaignId,
  influencerHandle = null,
  platformInfluencerId = null,
  contract = null,
}) {
  const cid = String(campaignId || "").trim();
  if (!cid) throw new Error("enqueueContractEmail 缺少 campaignId");

  const handle = String(influencerHandle || "")
    .replace(/^@/, "")
    .trim();
  const pid = platformInfluencerId != null ? String(platformInfluencerId).trim() : "";
  if (!handle && !pid) {
    throw new Error("enqueueContractEmail 需要 influencerHandle 或 platformInfluencerId");
  }

  const payload = {
    campaignId: cid,
    ...(handle ? { tiktokUsername: handle } : {}),
    ...(pid ? { platformInfluencerId: pid } : {}),
    // 可选：复用一份已生成（且人工确认过）的合同文件，避免发送时重新生成导致文本漂移
    ...(contract && (contract.absPath || contract.storageKey || contract.changeSummary)
      ? { contract }
      : {}),
  };

  const eventId = await enqueueInfluencerAgentEvent({
    influencerId: pid || null,
    campaignId: cid,
    eventType: "send_contract_email",
    payload,
  });
  return { eventId, payload };
}
