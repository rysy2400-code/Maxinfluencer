import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  pickCandidatesForExecution,
  markCandidatePicked,
} from "../db/campaign-candidates-dao.js";
import { enqueueFirstOutreach } from "../agents/influencer-agent.js";

/**
 * 执行侧心跳：
 * - 按照 tiktok_campaign.influencers_per_day，为 running 的 campaign 每天自动「拉 N 位红人」进入执行表
 * - 本版本不真正「找红人」，只预留一个候选池接口 TODO
 * - 真正的红人搜索 & 触达，由后续接入 InfluencerAgent 完成
 */

/**
 * 获取所有正在运行的 campaign（status = 'running'），返回 { id, influencersPerDay }
 */
async function getRunningCampaigns() {
  const rows = await queryTikTok(
    "SELECT id, influencers_per_day FROM tiktok_campaign WHERE status = 'running'"
  );
  return rows.map((r) => ({
    id: r.id,
    influencersPerDay: Number(r.influencers_per_day || 0) || 0,
  }));
}

/**
 * 统计某个 campaign 当前可用的候选红人数量（建议联系且尚未被消费）
 */
async function countAvailableCandidates(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
      AND should_contact = 1
      AND picked_at IS NULL
  `,
    [campaignId]
  );
  return rows && rows[0] ? Number(rows[0].n || 0) : 0;
}

/**
 * 统计某个 campaign 今天已经新增了多少执行行（用于 daily quota）
 */
async function countTodayEnqueued(campaignId, now) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_campaign_execution
    WHERE campaign_id = ?
      AND DATE(created_at) = DATE(?)
  `,
    [campaignId, now]
  );
  return rows && rows[0] ? Number(rows[0].n || 0) : 0;
}

/**
 * 为某个 campaign 入队一条搜索补货任务（如果当前已有 pending/processing 则不重复入队）。
 */
async function enqueueSearchTaskIfNeeded(campaignId, campaign, needed) {
  if (!needed || needed <= 0) return;

  const available = await countAvailableCandidates(campaignId);
  if (available >= needed) {
    return;
  }

  const existingRows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ?
      AND status IN ('pending','processing')
  `,
    [campaignId]
  );
  const existing = existingRows && existingRows[0] ? Number(existingRows[0].n || 0) : 0;
  if (existing > 0) {
    return;
  }

  const maxBatch = Math.max(needed * 2, (campaign.influencersPerDay || 0) * 2, 10);
  const payload = {
    trigger: "execution_heartbeat",
    needed,
    available,
    targetBatchSize: maxBatch,
    createdAt: new Date().toISOString(),
  };

  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_search_task (
      campaign_id,
      priority,
      payload,
      status
    ) VALUES (?, ?, ?, 'pending')
  `,
    [campaignId, 100, JSON.stringify(payload)]
  );

  console.log(
    `[ExecutionHeartbeat] Campaign ${campaignId} 候选不足（available=${available}, needed=${needed}），已入队搜索任务。`
  );
}

/**
 * 占位版：从「候选红人池」里为某个 campaign 取 N 个红人。
 * 当前版本：从 tiktok_campaign_influencer_candidates 中挑选 should_contact=1 且尚未 picked 的红人，
 * 并确保未重复进入 tiktok_campaign_execution。
 *
 * @returns {Promise<Array<{ id: string, snapshot: object }>>}
 */
async function pickInfluencerCandidates(campaignId, limit) {
  if (!limit || limit <= 0) return [];
  const picked = await pickCandidatesForExecution(campaignId, limit);
  return picked.map((r) => ({
    id: r.influencerId,
    snapshot: r.snapshot || {},
    matchScore: r.matchScore ?? null,
  }));
}

/**
 * 为某个 campaign 执行一次「拉新人」逻辑：
 * - 读取 influencersPerDay
 * - 估算今天还需要补充多少新人（当前版本使用「总执行行 < influencersPerDay」的粗略规则）
 * - 调用候选池接口 pickInfluencerCandidates（占位）获取红人
 * - 将这些红人插入 tiktok_campaign_execution，并将 stage 置为 pending_quote
 * - 预留与 InfluencerAgent 协作的 TODO：发送 DM/邮件，并在回调时更新 stage
 */
async function runExecutionForCampaign(campaign, now) {
  const { id: campaignId, influencersPerDay } = campaign;
  if (!influencersPerDay || influencersPerDay <= 0) {
    return;
  }

  // daily quota：今天还需要补齐多少新人
  const todayCount = await countTodayEnqueued(campaignId, now);
  const needed = Math.max(influencersPerDay - todayCount, 0);
  if (needed <= 0) {
    return;
  }

  // 若当前候选不足以支撑今日 quota，则入队搜索任务（由 Scraper Worker 异步消费）
  await enqueueSearchTaskIfNeeded(campaignId, campaign, needed);

  const candidates = await pickInfluencerCandidates(campaignId, needed);
  if (!candidates || candidates.length === 0) {
    console.log(
      `[ExecutionHeartbeat] Campaign ${campaignId} 今日无需新增红人或候选池为空。`
    );
    return;
  }

  console.log(
    `[ExecutionHeartbeat] Campaign ${campaignId} 将新增 ${candidates.length} 位红人进入执行表。`
  );

  for (const cand of candidates) {
    const influencerId = cand.id;
    const snapshot =
      cand.snapshot && typeof cand.snapshot === "object"
        ? JSON.stringify(cand.snapshot)
        : null;

    const insertResult = await queryTikTok(
      `
      INSERT IGNORE INTO tiktok_campaign_execution (campaign_id, influencer_id, influencer_snapshot, stage, last_event)
      VALUES (?, ?, ?, 'pending_quote', ?)
    `,
      [
        campaignId,
        influencerId,
        snapshot,
        JSON.stringify({
          createdBy: "execution-heartbeat",
          createdAt: now.toISOString(),
          note: "自动加入执行队列，待联系红人报价。",
          matchScore: cand.matchScore ?? undefined,
        }),
      ]
    );

    const affected = typeof insertResult?.affectedRows === "number" ? insertResult.affectedRows : 0;
    if (affected > 0) {
      // 标记该候选已被消费，避免下一次心跳重复挑选
      await markCandidatePicked(campaignId, influencerId, now);

      // 调用 InfluencerAgent，向该红人发送首轮邮件（MVP）
      try {
        await enqueueFirstOutreach({
          campaignId,
          influencerId,
          snapshot: cand.snapshot,
        });
      } catch (err) {
        console.error(
          `[ExecutionHeartbeat] 调用 InfluencerAgent.enqueueFirstOutreach 失败 (campaign=${campaignId}, influencer=${influencerId}):`,
          err
        );
      }
    }
  }
}

/**
 * 执行侧心跳主入口：
 * - 遍历所有 running 的 campaign
 * - 对每个 campaign 执行一次 runExecutionForCampaign
 *
 * @param {Date} now
 */
export async function runExecutionHeartbeatTick(now = new Date()) {
  console.log("[ExecutionHeartbeat] 心跳开始。", now.toISOString());

  const campaigns = await getRunningCampaigns();
  if (!campaigns || campaigns.length === 0) {
    console.log("[ExecutionHeartbeat] 当前没有 running 状态的 campaign。");
    return;
  }

  for (const c of campaigns) {
    try {
      await runExecutionForCampaign(c, now);
    } catch (e) {
      console.error(
        `[ExecutionHeartbeat] 处理 Campaign ${c.id} 时出错:`,
        e
      );
    }
  }

  console.log("[ExecutionHeartbeat] 心跳结束。");
}

