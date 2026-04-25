import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  pickCandidatesForExecution,
  markCandidatePicked,
} from "../db/campaign-candidates-dao.js";
import { enqueueFirstOutreach } from "../agents/influencer-agent.js";
import { generateSearchKeywords } from "../tools/influencer-functions/generate-search-keywords.js";

const DEFAULT_MAX_PARALLEL = Math.max(
  1,
  Number(process.env.EXECUTION_MAX_PARALLEL_WORKERS || 3) || 3
);
const DEFAULT_TASK_BATCH_SIZE = Math.max(
  1,
  Number(process.env.EXECUTION_TASK_BATCH_SIZE || 20) || 20
);
const ONE_TASK_PER_TICK = String(process.env.EXECUTION_ONE_TASK_PER_TICK || "true").toLowerCase() !== "false";

function parseJsonOrObject(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function getTodayRunId(campaignId, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${campaignId}-${day}`;
}

function calcKeywordScore(row = {}) {
  const execution = Number(row.insert_execution_count || 0);
  const recommended = Number(row.analyze_recommended_count || 0);
  const enrich = Number(row.enrich_success_count || 0);
  const duplicate = Number(row.duplicate_count || 0);
  const fail = Number(row.fail_count || 0);
  return (
    execution * 0.5 +
    recommended * 0.2 +
    enrich * 0.2 -
    duplicate * 0.1 -
    fail * 0.1
  );
}

async function getRunningCampaigns() {
  const rows = await queryTikTok(
    `
    SELECT
      id,
      session_id AS sessionId,
      influencers_per_day AS influencersPerDay,
      product_info AS productInfo,
      campaign_info AS campaignInfo,
      influencer_profile AS influencerProfile
    FROM tiktok_campaign
    WHERE status = 'running'
  `,
    []
  );

  return (rows || []).map((r) => ({
    id: r.id,
    sessionId: r.sessionId || null,
    influencersPerDay: Number(r.influencersPerDay || 0) || 0,
    productInfo: parseJsonOrObject(r.productInfo) || {},
    campaignInfo: parseJsonOrObject(r.campaignInfo) || {},
    influencerProfile: parseJsonOrObject(r.influencerProfile) || {},
  }));
}

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

async function countTodayExecution(campaignId, now) {
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

async function countRunningSearchTasks(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ?
      AND status IN ('pending','processing')
  `,
    [campaignId]
  );
  return rows && rows[0] ? Number(rows[0].n || 0) : 0;
}

async function cancelPendingSearchTasks(campaignId) {
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET status = 'cancelled', updated_at = NOW()
    WHERE campaign_id = ?
      AND status = 'pending'
  `,
    [campaignId]
  );
}

async function getKeywordHistory(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT keyword,
           AVG(score) AS avgScore,
           SUM(insert_execution_count) AS sumExecution,
           SUM(fail_count) AS sumFail,
           COUNT(*) AS runs
    FROM tiktok_keyword_run_result
    WHERE campaign_id = ?
      AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY keyword
  `,
    [campaignId]
  );

  return (rows || [])
    .map((r) => ({
      keyword: r.keyword,
      avgScore: Number(r.avgScore || 0),
      sumExecution: Number(r.sumExecution || 0),
      sumFail: Number(r.sumFail || 0),
      runs: Number(r.runs || 0),
    }))
    .sort((a, b) => b.avgScore - a.avgScore);
}

async function getExistingRunKeywords(campaignId, runId) {
  const rows = await queryTikTok(
    `
    SELECT keyword
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ?
      AND run_id = ?
      AND keyword IS NOT NULL
  `,
    [campaignId, runId]
  );

  const set = new Set();
  for (const row of rows || []) {
    const kw = String(row.keyword || "").trim().toLowerCase();
    if (!kw) continue;
    set.add(kw);
  }
  return set;
}

function buildKeywordVariant(keyword) {
  const clean = String(keyword || "").trim();
  if (!clean) return "";
  return `${clean} review`;
}

function resolveTaskBatchSize(needed) {
  const testMode = String(process.env.EXECUTION_ONE_PER_TASK || "").toLowerCase();
  if (testMode === "1" || testMode === "true" || testMode === "yes" || testMode === "y") {
    return 1;
  }
  return DEFAULT_TASK_BATCH_SIZE;
}

function uniqueKeywords(list = []) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const keyword = String(item.keyword || "").trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, keyword });
  }
  return result;
}

async function planKeywords(campaign, slots) {
  const history = await getKeywordHistory(campaign.id);
  const llm = await generateSearchKeywords({
    productInfo: campaign.productInfo,
    campaignInfo: campaign.campaignInfo,
    influencerProfile: campaign.influencerProfile,
    userMessage: "",
  });

  const llmKeywords = (llm?.search_queries || []).map((k) => String(k).trim()).filter(Boolean);
  const topHistory = history.slice(0, Math.max(1, Math.floor(history.length * 0.3)));
  const midHistory = history.slice(
    Math.max(1, Math.floor(history.length * 0.3)),
    Math.max(1, Math.floor(history.length * 0.8))
  );

  const targetNew = Math.max(1, Math.round(slots * 0.7));
  const targetVariant = Math.max(0, Math.round(slots * 0.2));
  const targetTop = Math.max(0, slots - targetNew - targetVariant);

  const out = [];

  for (const kw of llmKeywords) {
    if (out.filter((x) => x.keywordType === "new").length >= targetNew) break;
    out.push({ keyword: kw, keywordType: "new" });
  }

  for (const row of midHistory) {
    if (out.filter((x) => x.keywordType === "variant").length >= targetVariant) break;
    const variant = buildKeywordVariant(row.keyword);
    if (variant) out.push({ keyword: variant, keywordType: "variant" });
  }

  for (const row of topHistory) {
    if (out.filter((x) => x.keywordType === "high_performer").length >= targetTop) break;
    out.push({ keyword: row.keyword, keywordType: "high_performer" });
  }

  // fallback
  while (out.length < slots) {
    const fallback = llmKeywords[out.length] || `${campaign.productInfo?.brandName || "tiktok"} creator`;
    out.push({ keyword: fallback, keywordType: "fallback" });
  }

  return uniqueKeywords(out).slice(0, slots);
}

async function enqueueSearchTask({ campaign, runId, needed, keywordPlan, priority = 100 }) {
  const payload = {
    trigger: "execution_controller",
    needed,
    targetBatchSize: resolveTaskBatchSize(needed),
    keyword: keywordPlan.keyword,
    keywordType: keywordPlan.keywordType,
    runId,
    createdAt: new Date().toISOString(),
  };

  await queryTikTok(
    `
    INSERT IGNORE INTO tiktok_influencer_search_task (
      campaign_id,
      session_id,
      run_id,
      keyword,
      keyword_type,
      priority,
      payload,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
    [
      campaign.id,
      campaign.sessionId,
      runId,
      keywordPlan.keyword,
      keywordPlan.keywordType,
      priority,
      JSON.stringify(payload),
    ]
  );
}

async function pickInfluencerCandidates(campaignId, limit) {
  if (!limit || limit <= 0) return [];
  const picked = await pickCandidatesForExecution(campaignId, limit);
  return picked.map((r) => ({
    id: r.influencerId,
    snapshot: r.snapshot || {},
    matchScore: r.matchScore ?? null,
  }));
}

async function fillExecutionFromCandidates(campaignId, needCount, now) {
  const candidates = await pickInfluencerCandidates(campaignId, needCount);
  if (!candidates.length) return 0;

  let inserted = 0;
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
      inserted += 1;
      await markCandidatePicked(campaignId, influencerId, now);
      try {
        await enqueueFirstOutreach({ campaignId, influencerId, snapshot: cand.snapshot });
      } catch (err) {
        console.error(
          `[ExecutionHeartbeat] 调用 InfluencerAgent.enqueueFirstOutreach 失败 (campaign=${campaignId}, influencer=${influencerId}):`,
          err
        );
      }
    }
  }

  return inserted;
}

async function runExecutionForCampaign(campaign, now) {
  const campaignId = campaign.id;
  const targetToday = Number(campaign.influencersPerDay || 0) || 0;
  if (targetToday <= 0) return;

  const todayCount = await countTodayExecution(campaignId, now);
  let gap = Math.max(targetToday - todayCount, 0);

  if (gap <= 0) {
    await cancelPendingSearchTasks(campaignId);
    console.log(`[ExecutionHeartbeat] Campaign ${campaignId} 今日目标已完成，停止新派单。`);
    return;
  }

  // 先把可用候选补进执行表
  const inserted = await fillExecutionFromCandidates(campaignId, gap, now);
  if (inserted > 0) {
    const refreshed = await countTodayExecution(campaignId, now);
    gap = Math.max(targetToday - refreshed, 0);
  }

  if (gap <= 0) {
    await cancelPendingSearchTasks(campaignId);
    console.log(`[ExecutionHeartbeat] Campaign ${campaignId} 候选补位后达标，停止新派单。`);
    return;
  }

  const runningTasks = await countRunningSearchTasks(campaignId);
  const slots = Math.max(0, DEFAULT_MAX_PARALLEL - runningTasks);
  if (slots <= 0) {
    console.log(`[ExecutionHeartbeat] Campaign ${campaignId} 当前任务并发已满（${runningTasks}/${DEFAULT_MAX_PARALLEL}）。`);
    return;
  }

  const runId = getTodayRunId(campaignId, now);
  const plans = await planKeywords(campaign, slots);
  const existingKeywords = await getExistingRunKeywords(campaignId, runId);
  const dedupedPlans = plans.filter((plan) => {
    const key = String(plan.keyword || "").trim().toLowerCase();
    return key && !existingKeywords.has(key);
  });

  if (dedupedPlans.length < plans.length) {
    console.log(
      `[ExecutionHeartbeat] Campaign ${campaignId} 跳过重复关键词 ${plans.length - dedupedPlans.length} 条（run_id=${runId}）。`
    );
  }

  const plansToDispatch = ONE_TASK_PER_TICK ? dedupedPlans.slice(0, 1) : dedupedPlans;
  for (const plan of plansToDispatch) {
    await enqueueSearchTask({
      campaign,
      runId,
      needed: gap,
      keywordPlan: plan,
      priority: 100,
    });
    existingKeywords.add(String(plan.keyword || "").trim().toLowerCase());
    console.log(
      `[ExecutionHeartbeat] Campaign ${campaignId} 派发任务: keyword=${plan.keyword} type=${plan.keywordType}`
    );
  }
}

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
      console.error(`[ExecutionHeartbeat] 处理 Campaign ${c.id} 时出错:`, e);
    }
  }

  console.log("[ExecutionHeartbeat] 心跳结束。");
}
