/**
 * Worker：消费 tiktok_advertiser_agent_event，作为 CampaignExecutionAgent 统一更新 campaign / execution 表。
 *
 * 职责（MVP）：
 * - 处理 InfluencerAgent 发来的「execution_update_suggested」类事件
 *   - 根据 payload 中的 campaignId / influencerId / newStage / flatFeeUSD / videoLink / shippingInfo
 *     更新 tiktok_campaign_execution 对应行，并在 last_event 中记录来源。
 *
 * 使用方式（示例）：
 *   node scripts/process-campaign-agent-events.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { appendBinMessageToSession } from "../lib/db/campaign-session-dao.js";

function parseJsonOrObject(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function fetchPendingCampaignAgentEvents(limit = 20) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const rows = await queryTikTok(
    `
    SELECT *
    FROM tiktok_advertiser_agent_event
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${n}
  `,
    []
  );
  return rows || [];
}

async function markCampaignAgentEventStatus(id, status, errorMessage = null) {
  await queryTikTok(
    `
    UPDATE tiktok_advertiser_agent_event
    SET status = ?, error_message = ?, updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, id]
  );
}

async function applyExecutionUpdateSuggested(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id;
  const influencerId = payload.influencerId || eventRow.influencer_id;
  const newStage = payload.newStage;

  if (!campaignId || !influencerId || !newStage) {
    throw new Error(
      "execution_update_suggested 缺少必要字段：campaignId / influencerId / newStage"
    );
  }

  let flatFee =
    typeof payload.flatFeeUSD === "number"
      ? payload.flatFeeUSD
      : payload.flatFeeUSD && !Number.isNaN(Number(payload.flatFeeUSD))
      ? Number(payload.flatFeeUSD)
      : null;

  let videoLink =
    typeof payload.videoLink === "string" && payload.videoLink.trim()
      ? payload.videoLink.trim()
      : null;

  let shippingInfo =
    payload.shippingInfo && typeof payload.shippingInfo === "object"
      ? payload.shippingInfo
      : null;

  const emailEvent = payload.emailEvent || {};

  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET stage = ?,
        flat_fee = COALESCE(?, flat_fee),
        video_link = COALESCE(?, video_link),
        shipping_info = COALESCE(?, shipping_info),
        last_event = JSON_MERGE_PRESERVE(
          COALESCE(last_event, JSON_OBJECT()),
          JSON_OBJECT(
            'campaignAgentDecision',
            JSON_OBJECT(
              'updatedAt', ?,
              'campaignId', ?,
              'influencerId', ?,
              'sourceEventId', ?,
              'sourceEventType', ?,
              'emailEvent', ?,
              'note', ?,
              'flatFeeUSD', ?,
              'videoLink', ?,
              'shippingInfo', ?
            )
          )
        )
    WHERE campaign_id = ? AND influencer_id = ?
  `,
    [
      newStage,
      flatFee,
      videoLink,
      shippingInfo ? JSON.stringify(shippingInfo) : null,
      new Date().toISOString(),
      campaignId,
      influencerId,
      eventRow.id,
      eventRow.event_type,
      JSON.stringify(emailEvent || {}),
      payload.note || "",
      flatFee,
      videoLink,
      shippingInfo ? JSON.stringify(shippingInfo) : null,
      campaignId,
      influencerId,
    ]
  );
}

/**
 * 处理 creator_replied_special_request：红人回复特殊请求。
 * 当 specialRequestStatus === "resolved" 时：
 * - 更新 tiktok_campaign_execution.last_event 记录结论
 * - 若配置了 BRAND_NOTIFICATION_EMAIL，发邮件告知品牌方好消息
 */
async function applyCreatorRepliedSpecialRequest(eventRow, payload) {
  const campaignId = payload.campaignId || eventRow.campaign_id;
  const influencerId = payload.influencerId || eventRow.influencer_id;
  const specialRequestId = payload.specialRequestId || null;
  const specialRequestStatus = payload.specialRequestStatus || "pending_brand";
  const creatorMessage = payload.creatorMessage || "";
  const note = payload.note || "";

  if (!campaignId || !influencerId) {
    throw new Error(
      "creator_replied_special_request 缺少 campaignId 或 influencerId"
    );
  }

  const summary = {
    type: "special_request_resolved",
    specialRequestId,
    specialRequestStatus,
    creatorMessage,
    note,
    resolvedAt: new Date().toISOString(),
    sourceEventId: eventRow.id,
  };

  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET last_event = JSON_MERGE_PRESERVE(
          COALESCE(last_event, JSON_OBJECT()),
          JSON_OBJECT(
            'specialRequestResolved',
            ?
          )
        )
    WHERE campaign_id = ? AND influencer_id = ?
  `,
    [JSON.stringify(summary), campaignId, influencerId]
  );

  // 红人同意时，向该 campaign 关联的 session 追加一条 Bin 消息，品牌方在前端聊天框可见
  if (specialRequestStatus === "resolved") {
    try {
      const rows = await queryTikTok(
        "SELECT session_id FROM tiktok_campaign WHERE id = ? LIMIT 1",
        [campaignId]
      );
      const sessionId = rows?.[0]?.session_id || null;
      if (sessionId) {
        const content = `【特殊请求已达成一致】\n\n红人已同意本轮特殊请求。\n\n红人回复：${creatorMessage}\n\n执行侧摘要：${note}\n\n执行表已更新，可在 Campaign 执行详情中查看。`;
        const result = await appendBinMessageToSession(sessionId, content);
        if (!result.success) {
          console.warn(
            "[ProcessCampaignAgentEvents] 追加 Bin 消息到 session 失败:",
            result.message
          );
        }
      }
    } catch (err) {
      console.error(
        "[ProcessCampaignAgentEvents] 通知品牌方（追加 session 消息）失败:",
        err?.message || err
      );
    }
  }
}

async function processCampaignAgentEvent(eventRow) {
  await markCampaignAgentEventStatus(eventRow.id, "processing", null);

  const payload = parseJsonOrObject(eventRow.payload) || {};
  const type = eventRow.event_type || payload.type || "generic";

  // 当前版本只处理 InfluencerAgent 发来的「execution_update_suggested」类事件
  if (type === "execution_update_suggested") {
    await applyExecutionUpdateSuggested(eventRow, payload);
    await markCampaignAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  if (type === "creator_replied_special_request") {
    await applyCreatorRepliedSpecialRequest(eventRow, payload);
    await markCampaignAgentEventStatus(eventRow.id, "succeeded", null);
    return;
  }

  // 其它类型暂时跳过，由后续扩展
  await markCampaignAgentEventStatus(
    eventRow.id,
    "skipped",
    `未识别的 event_type：${type}`
  );
}

async function main() {
  const events = await fetchPendingCampaignAgentEvents(20);
  if (!events.length) {
    console.log("[ProcessCampaignAgentEvents] 当前没有 pending 事件。");
    return;
  }

  console.log(
    `[ProcessCampaignAgentEvents] 准备处理 ${events.length} 条 pending 事件。`
  );

  for (const ev of events) {
    try {
      await processCampaignAgentEvent(ev);
    } catch (err) {
      console.error(
        "[ProcessCampaignAgentEvents] 处理事件时出现未捕获错误:",
        err
      );
      await markCampaignAgentEventStatus(
        ev.id,
        "failed",
        `未捕获错误: ${err?.message || String(err)}`
      );
    }
  }
}

main()
  .then(() => {
    console.log("[ProcessCampaignAgentEvents] 本次处理完成。");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[ProcessCampaignAgentEvents] 运行出错:", err);
    process.exit(1);
  });

