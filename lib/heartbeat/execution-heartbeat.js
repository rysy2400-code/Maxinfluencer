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
const KEYWORD_HISTORY_DAYS = Math.max(1, Number(process.env.EXECUTION_KEYWORD_HISTORY_DAYS || 14) || 14);
const KEYWORD_MAIN_GENERATE_COUNT = Math.max(4, Number(process.env.EXECUTION_KEYWORD_MAIN_GENERATE_COUNT || 12) || 12);
const KEYWORD_EXCLUDE_RUN_LIMIT = Math.max(10, Number(process.env.EXECUTION_KEYWORD_EXCLUDE_RUN_LIMIT || 100) || 100);
const KEYWORD_EXPLORATION_RATIO = Math.min(
  0.8,
  Math.max(0, Number(process.env.EXECUTION_KEYWORD_EXPLORATION_RATIO || 0.3) || 0.3)
);
const KEYWORD_BUCKET_TARGETS = Object.freeze({
  product: 3,
  category: 3,
  competitor: 2,
  influencer_audience: 2,
  target_audience: 2,
});
const KEYWORD_MIN_REQUIRED = Math.max(1, Number(process.env.EXECUTION_KEYWORD_MIN_REQUIRED || 1) || 1);
const KEYWORD_MAX_REFILL_ROUNDS = Math.max(0, Number(process.env.EXECUTION_KEYWORD_MAX_REFILL_ROUNDS || 1) || 1);

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
  const recommended = Number(row.analyze_recommended_count || 0);
  const enrich = Number(row.enrich_success_count || 0);
  const fail = Number(row.fail_count || 0);
  const matchRate = enrich > 0 ? recommended / enrich : 0;
  return matchRate * 10 + enrich * 0.05 - fail * 0.2;
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
           SUM(analyze_recommended_count) AS sumRecommended,
           SUM(enrich_success_count) AS sumEnrich,
           SUM(fail_count) AS sumFail,
           COUNT(*) AS runs
    FROM tiktok_keyword_run_result
    WHERE campaign_id = ?
      AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY keyword
  `,
    [campaignId, KEYWORD_HISTORY_DAYS]
  );

  return (rows || [])
    .map((r) => {
      const sumRecommended = Number(r.sumRecommended || 0);
      const sumEnrich = Number(r.sumEnrich || 0);
      const sumFail = Number(r.sumFail || 0);
      const runs = Number(r.runs || 0);
      const matchRate = sumEnrich > 0 ? sumRecommended / sumEnrich : 0;
      const qualityScore = calcKeywordScore({
        analyze_recommended_count: sumRecommended,
        enrich_success_count: sumEnrich,
        fail_count: sumFail,
      });
      return {
        keyword: r.keyword,
        sumRecommended,
        sumEnrich,
        sumFail,
        runs,
        matchRate,
        qualityScore,
      };
    })
    .sort((a, b) => b.qualityScore - a.qualityScore);
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

function normalizeKeyword(keyword) {
  return String(keyword || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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
    const key = normalizeKeyword(keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, keyword });
  }
  return result;
}

function getForbiddenBrandTerms(campaign) {
  const terms = new Set();
  const productInfo = campaign?.productInfo || {};
  const add = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (!s) return;
    terms.add(s);
  };
  add(productInfo.brandName);
  add(productInfo.brand);
  if (Array.isArray(productInfo.brandAliases)) {
    for (const x of productInfo.brandAliases) add(x);
  }
  return Array.from(terms);
}

function buildHistoryPatterns(history = []) {
  const ranked = [...history];
  const top = ranked.slice(0, 10).map((x) => ({
    keyword: x.keyword,
    matchRate: Number(x.matchRate || 0),
    qualityScore: Number(x.qualityScore || 0),
    runs: Number(x.runs || 0),
  }));
  const avoid = ranked
    .filter((x) => Number(x.matchRate || 0) < 0.15 || Number(x.sumFail || 0) > 0)
    .slice(0, 10)
    .map((x) => ({
      keyword: x.keyword,
      matchRate: Number(x.matchRate || 0),
      sumFail: Number(x.sumFail || 0),
      runs: Number(x.runs || 0),
    }));
  return { top, avoid };
}

function normalizeLlmKeywordItems(rawItems = [], fallbackType = "new") {
  return uniqueKeywords(
    (rawItems || [])
      .map((item) => {
        if (typeof item === "string") {
          return { keyword: item, keywordType: fallbackType };
        }
        if (!item || typeof item !== "object") return null;
        const keyword = String(item.keyword || "").trim();
        if (!keyword) return null;
        const isExploration = Boolean(item.is_exploration);
        return {
          keyword,
          keywordType: isExploration ? "variant" : "new",
        };
      })
      .filter(Boolean)
  );
}

async function planKeywords(campaign, slots, existingRunKeywords) {
  const history = await getKeywordHistory(campaign.id);
  const { top: historyTopPatterns, avoid: historyAvoidPatterns } = buildHistoryPatterns(history);
  const excludeKeywordsRun = Array.from(existingRunKeywords || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, KEYWORD_EXCLUDE_RUN_LIMIT);
  const forbiddenBrandTerms = getForbiddenBrandTerms(campaign);

  const generated = [];
  for (let round = 0; round <= KEYWORD_MAX_REFILL_ROUNDS; round += 1) {
    if (generated.length >= KEYWORD_MAIN_GENERATE_COUNT) break;
    if (round > 0 && generated.length >= KEYWORD_MIN_REQUIRED) break;

    const remaining = Math.max(1, KEYWORD_MAIN_GENERATE_COUNT - generated.length);
    const llm = await generateSearchKeywords({
      productInfo: campaign.productInfo,
      campaignInfo: campaign.campaignInfo,
      influencerProfile: campaign.influencerProfile,
      userMessage: round === 0 ? "" : `Refill round ${round}: provide ${remaining} additional non-duplicate keywords only.`,
      excludeKeywordsRun: [...excludeKeywordsRun, ...generated.map((x) => x.keyword)].slice(
        0,
        KEYWORD_EXCLUDE_RUN_LIMIT
      ),
      historyTopPatterns,
      historyAvoidPatterns,
      mainGenerateCount: remaining,
      bucketTargets: KEYWORD_BUCKET_TARGETS,
      explorationRatio: KEYWORD_EXPLORATION_RATIO,
      forbiddenBrandTerms,
    });

    const llmItemsRaw = Array.isArray(llm?.search_query_items)
      ? llm.search_query_items
      : (llm?.search_queries || []).map((keyword) => ({ keyword, is_exploration: false }));
    const llmItems = normalizeLlmKeywordItems(llmItemsRaw, round === 0 ? "new" : "fallback");

    for (const item of llmItems) {
      const key = normalizeKeyword(item.keyword);
      if (!key || existingRunKeywords.has(key)) continue;
      generated.push(item);
      existingRunKeywords.add(key);
      if (generated.length >= KEYWORD_MAIN_GENERATE_COUNT) break;
    }
  }

  if (generated.length === 0) {
    const fallback = `${campaign.productInfo?.productType || "product"} influencer`;
    const key = normalizeKeyword(fallback);
    if (!existingRunKeywords.has(key)) {
      generated.push({ keyword: fallback, keywordType: "fallback" });
      existingRunKeywords.add(key);
    }
  }

  return uniqueKeywords(generated).slice(0, Math.max(KEYWORD_MIN_REQUIRED, slots));
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
  const existingKeywords = await getExistingRunKeywords(campaignId, runId);
  const plans = await planKeywords(campaign, slots, existingKeywords);
  const dedupedPlans = plans;

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
