import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  pickCandidatesForExecution,
  markCandidatePicked,
} from "../db/campaign-candidates-dao.js";
import { enqueueFirstOutreach } from "../agents/influencer-agent.js";
import { getInfluencerById } from "../db/influencer-dao.js";
import { assessBusinessProfileForCampaign } from "../influencer/business-profile.js";
import { generateSearchKeywords } from "../tools/influencer-functions/generate-search-keywords.js";
import {
  getPromptKeywordSignals,
  normalizeSignalMatchKey,
} from "../db/campaign-keyword-signals-dao.js";
import {
  platformPayloadSlug,
  resolveCampaignPlatforms,
} from "../influencer/resolve-campaign-platforms.js";
import { filterKeywordSignalsForSearch } from "../influencer/extract-keyword-signals.js";
import { skipsSearchDispatch } from "../campaign/campaign-status.js";

const DEFAULT_MAX_PARALLEL = Math.max(
  1,
  Number(process.env.EXECUTION_MAX_PARALLEL_WORKERS || 100) || 100
);
const DEFAULT_TASK_BATCH_SIZE = Math.max(
  1,
  Number(process.env.EXECUTION_TASK_BATCH_SIZE || 20) || 20
);
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

/**
 * 轻量并发限制器（等价 p-limit 的 min 子集）。
 *
 * 不使用 p-limit：其 v5 在 Next.js webpack 打包时无法解析 Node 内置
 * `#async_hooks`，会导致 web 机 next build 失败。此处自实现，Node 与
 * webpack 环境均可运行。
 */
function createConcurrencyLimiter(max) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const queue = [];

  const next = () => {
    active -= 1;
    if (queue.length > 0) {
      const run = queue.shift();
      run();
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active += 1;
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              resolve(value);
              next();
            },
            (err) => {
              reject(err);
              next();
            }
          );
      };
      if (active < limit) {
        run();
      } else {
        queue.push(run);
      }
    });
}

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
      keyword_strategy AS keywordStrategy,
      product_info AS productInfo,
      campaign_info AS campaignInfo,
      influencer_profile AS influencerProfile,
      start_date AS startDate,
      end_date AS endDate,
      status,
      created_at AS createdAt
    FROM tiktok_campaign
    WHERE status IN ('running', 'running_passive')
    ORDER BY session_id, created_at DESC
  `,
    []
  );

  /** 一会话只调度一条 running campaign（created_at 最新） */
  const bySession = new Map();
  for (const r of rows || []) {
    const sessionId = r.sessionId || null;
    if (!sessionId) continue;
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, r);
    }
  }

  const skipped = (rows || []).length - bySession.size;
  if (skipped > 0) {
    console.warn(
      `[ExecutionHeartbeat] 同一 session 存在多条 running campaign，已跳过 ${skipped} 条旧记录（仅调度最新一条）`
    );
  }

  return Array.from(bySession.values()).map((r) => ({
    id: r.id,
    sessionId: r.sessionId || null,
    influencersPerDay: Number(r.influencersPerDay || 0) || 0,
    keywordStrategy: typeof r.keywordStrategy === "string" ? r.keywordStrategy.trim() : null,
    productInfo: parseJsonOrObject(r.productInfo) || {},
    campaignInfo: parseJsonOrObject(r.campaignInfo) || {},
    influencerProfile: parseJsonOrObject(r.influencerProfile) || {},
    startDate: r.startDate || null,
    endDate: r.endDate || null,
    status: r.status || "running",
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

async function countRunningSearchTasks(campaignId, platformSlug = null) {
  const params = [campaignId];
  let platformClause = "";
  if (platformSlug) {
    platformClause = " AND platform = ?";
    params.push(platformSlug);
  }
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ?
      AND status IN ('pending','processing')
      ${platformClause}
  `,
    params
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
    const key = normalizeKeyword(row.keyword);
    if (!key) continue;
    set.add(key);
    const signalKey = normalizeSignalMatchKey(row.keyword);
    if (signalKey) set.add(signalKey);
  }
  return set;
}

function normalizeKeyword(keyword) {
  return String(keyword || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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

function buildExcludeKeywordSet(existingRunKeywords, history = []) {
  const set = new Set();
  for (const kw of existingRunKeywords || []) {
    const key = normalizeKeyword(kw);
    if (key) set.add(key);
  }
  for (const row of history || []) {
    const key = normalizeKeyword(row.keyword);
    if (key) set.add(key);
  }
  return set;
}

function isKeywordExcluded(keyword, excludeSet) {
  const raw = String(keyword || "").trim().toLowerCase();
  if (!raw) return true;
  if (excludeSet.has(raw)) return true;
  const normalized = normalizeKeyword(keyword);
  if (normalized && excludeSet.has(normalized)) return true;
  const signalKey = normalizeSignalMatchKey(keyword);
  if (signalKey && excludeSet.has(signalKey)) return true;
  return false;
}

function summarizeSignalDrops(dropped = []) {
  const counts = new Map();
  for (const item of dropped || []) {
    const reason = item.filter_reason || "unknown";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
}

function filterPromptSignals(signals = [], excludeSet, meta = {}) {
  const excluded = [];
  const candidates = [];

  for (const s of signals || []) {
    const value = String(s.signal_value || s.signalValue || "").trim();
    if (!value) continue;
    if (isKeywordExcluded(value, excludeSet)) {
      excluded.push({
        ...s,
        signal_value: value,
        filter_reason: "excluded_by_run_or_history",
      });
      continue;
    }
    candidates.push(s);
  }

  const filtered = filterKeywordSignalsForSearch(candidates);
  const dropped = [...excluded, ...filtered.dropped];
  if (dropped.length > 0) {
    const prefix = meta.campaignId
      ? `[ExecutionHeartbeat] campaign=${meta.campaignId} platform=${meta.platform || "-"}`
      : "[ExecutionHeartbeat]";
    console.warn(
      `${prefix} 过滤 keyword signals ${dropped.length}/${signals.length}: ${summarizeSignalDrops(dropped)}`
    );
    console.warn(
      `${prefix} signal filter samples: ` +
        dropped
          .slice(0, 15)
          .map((s) => `${s.signal_value || s.signalValue}:${s.filter_reason}`)
          .join(", ")
    );
  }

  return filtered.kept;
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
        const reasonText = String(item.reason || "").trim();
        return {
          keyword,
          keywordType: isExploration ? "variant" : "new",
          reasonText,
        };
      })
      .filter(Boolean)
  );
}

async function planKeywords(campaign, existingRunKeywords, targetPlatform = null) {
  const history = await getKeywordHistory(campaign.id);
  const { top: historyTopPatterns, avoid: historyAvoidPatterns } = buildHistoryPatterns(history);
  const excludeSet = buildExcludeKeywordSet(existingRunKeywords, history);
  const excludeKeywordsRun = Array.from(excludeSet)
    .slice(0, KEYWORD_EXCLUDE_RUN_LIMIT);
  const forbiddenBrandTerms = getForbiddenBrandTerms(campaign);

  const platformSlug = targetPlatform || "tiktok";
  const rawSignals = await getPromptKeywordSignals(campaign.id, platformSlug);
  const keywordSignals = filterPromptSignals(rawSignals, excludeSet, {
    campaignId: campaign.id,
    platform: platformSlug,
  });
  const batchGenerateCount = Math.max(KEYWORD_MAIN_GENERATE_COUNT, keywordSignals.length);

  const generated = [];
  for (let round = 0; round <= KEYWORD_MAX_REFILL_ROUNDS; round += 1) {
    if (generated.length >= batchGenerateCount) break;
    if (round > 0 && generated.length >= KEYWORD_MIN_REQUIRED) break;

    const remaining = Math.max(1, batchGenerateCount - generated.length);
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
      keywordStrategy: campaign.keywordStrategy || "",
      targetPlatform,
      keywordSignals: round === 0 ? keywordSignals : [],
    });

    const llmItemsRaw = Array.isArray(llm?.search_query_items)
      ? llm.search_query_items
      : (llm?.search_queries || []).map((keyword) => ({ keyword, is_exploration: false }));
    const llmItems = normalizeLlmKeywordItems(llmItemsRaw, round === 0 ? "new" : "fallback");

    for (const item of llmItems) {
      const key = normalizeKeyword(item.keyword);
      if (!key || isKeywordExcluded(item.keyword, excludeSet)) continue;
      generated.push(item);
      existingRunKeywords.add(key);
      excludeSet.add(key);
      const signalKey = normalizeSignalMatchKey(item.keyword);
      if (signalKey) excludeSet.add(signalKey);
      if (generated.length >= batchGenerateCount) break;
    }
  }

  if (generated.length === 0) {
    const productName = String(campaign.productInfo?.productName || "").trim();
    if (productName) {
      const key = normalizeKeyword(productName);
      if (!existingRunKeywords.has(key)) {
        generated.push({
          keyword: productName,
          keywordType: "fallback",
          reasonText: "基于当前产品名称补充探索关键词。",
        });
        existingRunKeywords.add(key);
      }
    }
  }

  return uniqueKeywords(generated).slice(0, batchGenerateCount);
}

async function enqueueSearchTask({
  campaign,
  runId,
  needed,
  keywordPlan,
  platform = "tiktok",
  priority = 100,
}) {
  const keywordReason =
    String(keywordPlan.reasonText || "").trim() ||
    (campaign.keywordStrategy
      ? "基于你设置的关键词策略，本轮优先搜索该关键词。"
      : keywordPlan.keywordType === "high_performer"
      ? "该方向近期表现稳定，因此继续扩展同类关键词。"
      : keywordPlan.keywordType === "variant"
      ? "该关键词用于探索相邻方向，提升匹配红人覆盖。"
      : "该关键词与 campaign 的目标受众方向更贴合。");
  const payload = {
    trigger: "execution_controller",
    platform,
    needed,
    targetBatchSize: DEFAULT_TASK_BATCH_SIZE,
    keyword: keywordPlan.keyword,
    keywordType: keywordPlan.keywordType,
    keywordReason,
    runId,
    createdAt: new Date().toISOString(),
  };

  const platformSlug = String(platform || "tiktok").trim().toLowerCase() || "tiktok";

  await queryTikTok(
    `
    INSERT IGNORE INTO tiktok_influencer_search_task (
      campaign_id,
      session_id,
      run_id,
      keyword,
      keyword_type,
      platform,
      priority,
      payload,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
    [
      campaign.id,
      campaign.sessionId,
      runId,
      keywordPlan.keyword,
      keywordPlan.keywordType,
      platformSlug,
      priority,
      JSON.stringify(payload),
    ]
  );
}

async function pickInfluencerCandidates(campaignId, limit) {
  if (!limit || limit <= 0) return [];
  const picked = await pickCandidatesForExecution(campaignId, limit);
  return picked.map((r) => ({
    id: r.tiktokUsername,
    platformInfluencerId: r.platformInfluencerId || null,
    snapshot: r.snapshot || {},
    matchScore: r.matchScore ?? null,
    source: r.source || "web_search",
  }));
}

async function fillExecutionFromCandidates(campaign, needCount, now) {
  const campaignId = campaign.id;
  const candidates = await pickInfluencerCandidates(campaignId, needCount);
  if (!candidates.length) return 0;

  let inserted = 0;
  for (const cand of candidates) {
    const tiktokUsername = cand.id;
    const platformInfluencerId = cand.platformInfluencerId || null;
    const snapshot =
      cand.snapshot && typeof cand.snapshot === "object"
        ? JSON.stringify(cand.snapshot)
        : null;

    let profileDecision = { decision: "normal_outreach", reason: "missing_platform_id" };
    if (platformInfluencerId) {
      try {
        const influencer = await getInfluencerById(platformInfluencerId);
        if (influencer) {
          profileDecision = await assessBusinessProfileForCampaign({
            influencer,
            campaign,
            now,
          });
        }
      } catch (err) {
        console.warn(
          `[ExecutionHeartbeat] 商务档案判断失败，降级为正常邀约 (campaign=${campaignId}, influencer=${tiktokUsername}):`,
          err?.message || err
        );
      }
    }

    if (profileDecision.decision === "skip") {
      await markCandidatePicked(campaignId, tiktokUsername, now);
      console.log(
        `[ExecutionHeartbeat] 商务档案明确冲突，跳过红人 (campaign=${campaignId}, influencer=${tiktokUsername}, reason=${profileDecision.reason})`
      );
      continue;
    }

    const isSystemQuote = profileDecision.decision === "system_quote";
    const stage = isSystemQuote ? "quote_submitted" : "pending_quote";
    const source = isSystemQuote
      ? "algorithm_recommendation"
      : cand.source || "web_search";
    const quoteNegotiation = isSystemQuote
      ? JSON.stringify([{
          role: "system",
          amount: profileDecision.suggestedPriceUsd,
          currency: "USD",
          reason: profileDecision.deliveryNoteChinese || null,
          type: "system_suggested_quote",
          source: "business_profile",
          at: now.toISOString(),
        }])
      : null;
    const lastEvent = {
      createdBy: "execution-heartbeat",
      createdAt: now.toISOString(),
      note: isSystemQuote
        ? "系统根据红人商务档案生成建议价，尚未联系红人。"
        : "自动加入执行队列，待联系红人报价。",
      matchScore: cand.matchScore ?? undefined,
      ...(isSystemQuote
        ? {
            systemQuote: {
              baseRateUsd: profileDecision.baseRateUsd,
              quantityMultiplier: profileDecision.quantityMultiplier,
              suggestedPriceUsd: profileDecision.suggestedPriceUsd,
              deliveryNote: profileDecision.deliveryNoteChinese || null,
              evidence: profileDecision.evidence || null,
              latestEmailAt: profileDecision.latestEmailAt,
              markupRate: 0.3,
              rounding: "ceil_to_10_usd",
            },
          }
        : {}),
    };

    const insertResult = await queryTikTok(
      `
      INSERT IGNORE INTO tiktok_campaign_execution
        (campaign_id, tiktok_username, influencer_id, influencer_snapshot, source, stage,
         flat_fee, currency, quote_negotiation, quote_origin, last_event)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)
    `,
      [
        campaignId,
        tiktokUsername,
        platformInfluencerId,
        snapshot,
        source,
        stage,
        isSystemQuote ? profileDecision.suggestedPriceUsd : null,
        quoteNegotiation,
        isSystemQuote ? "commerce_profile_estimate" : null,
        JSON.stringify(lastEvent),
      ]
    );

    const affected = typeof insertResult?.affectedRows === "number" ? insertResult.affectedRows : 0;
    if (affected > 0) {
      inserted += 1;
      await markCandidatePicked(campaignId, tiktokUsername, now);
      if (!isSystemQuote) try {
        await enqueueFirstOutreach({
          campaignId,
          tiktokUsername,
          platformInfluencerId: cand.platformInfluencerId || null,
          snapshot: cand.snapshot,
        });
      } catch (err) {
        console.error(
          `[ExecutionHeartbeat] 调用 InfluencerAgent.enqueueFirstOutreach 失败 (campaign=${campaignId}, influencer=${tiktokUsername}):`,
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
  const inserted = await fillExecutionFromCandidates(campaign, gap, now);
  if (inserted > 0) {
    const refreshed = await countTodayExecution(campaignId, now);
    gap = Math.max(targetToday - refreshed, 0);
  }

  if (gap <= 0) {
    await cancelPendingSearchTasks(campaignId);
    console.log(`[ExecutionHeartbeat] Campaign ${campaignId} 候选补位后达标，停止新派单。`);
    return;
  }

  if (skipsSearchDispatch(campaign.status)) {
    console.log(
      `[ExecutionHeartbeat] Campaign ${campaignId} 为名单模式（running_passive），不派发搜索任务；候选不足时请用户导入名单。`
    );
    return;
  }

  const runId = getTodayRunId(campaignId, now);
  const existingKeywords = await getExistingRunKeywords(campaignId, runId);
  const campaignPlatforms = resolveCampaignPlatforms(campaign.campaignInfo);
  const dispatchPlatformSlugs = campaignPlatforms.map((p) => platformPayloadSlug(p));

  // 门控为平台级：仅当该平台自身无 pending/processing 任务时才补货，其它平台的 backlog
  // 不再阻塞本平台。已清空平台的关键词规划改为并行生成（受 DEFAULT_MAX_PARALLEL 限制），
  // 每个平台内部的 refill 轮次仍保持串行（依赖上一轮结果去重）；规划完成后统一入队，
  // 由 DB 唯一键 uk_campaign_run_keyword_platform + INSERT IGNORE 兜底防重。
  const planTargets = [];
  for (const platformSlug of dispatchPlatformSlugs) {
    const runningTasks = await countRunningSearchTasks(campaignId, platformSlug);
    if (runningTasks > 0) {
      console.log(
        `[ExecutionHeartbeat] Campaign ${campaignId} 平台 ${platformSlug} 仍有 ${runningTasks} 个搜索任务 pending/processing，跳过该平台关键词规划。`
      );
      continue;
    }
    planTargets.push(platformSlug);
  }

  if (planTargets.length === 0) return;

  await dispatchPlatformKeywordTasks({
    campaign,
    runId,
    needed: gap,
    existingKeywords,
    planTargets,
  });
}

/**
 * 并行规划各平台关键词并统一入队。
 *
 * - 各平台使用独立快照规划，避免并行时共享 Set 的读竞争；平台内 refill 仍串行去重。
 * - 规划完成后按平台统一去重，避免同一平台重复关键词（跨平台同词允许，由 DB 唯一键
 *   uk_campaign_run_keyword_platform + INSERT IGNORE 兜底）。
 * - 单个平台规划失败只跳过该平台，不影响其它平台派单。
 *
 * 依赖通过参数注入，便于单元测试（默认使用真实 planKeywords / enqueueSearchTask）。
 */
export async function dispatchPlatformKeywordTasks({
  campaign,
  runId,
  needed,
  existingKeywords,
  planTargets,
  maxParallel = DEFAULT_MAX_PARALLEL,
  planPlatform = planKeywords,
  enqueue = enqueueSearchTask,
} = {}) {
  if (!planTargets || planTargets.length === 0) {
    return { enqueued: 0, failed: 0 };
  }

  const limit = createConcurrencyLimiter(Math.max(1, Number(maxParallel) || 1));
  const settled = await Promise.allSettled(
    planTargets.map((platformSlug) =>
      limit(async () => ({
        platformSlug,
        plans: await planPlatform(
          campaign,
          new Set(existingKeywords || []),
          platformSlug
        ),
      }))
    )
  );

  const enqueuedPerPlatform = new Map();
  let enqueued = 0;
  let failed = 0;
  for (const item of settled) {
    if (item.status === "rejected") {
      failed += 1;
      console.error(
        `[ExecutionHeartbeat] Campaign ${campaign?.id} 平台关键词规划失败（已跳过该平台）:`,
        item.reason?.message || item.reason
      );
      continue;
    }

    const { platformSlug, plans } = item.value;
    let seen = enqueuedPerPlatform.get(platformSlug);
    if (!seen) {
      seen = new Set();
      enqueuedPerPlatform.set(platformSlug, seen);
    }
    for (const plan of plans) {
      const planKey = normalizeKeyword(plan.keyword);
      if (seen.has(planKey)) continue;
      seen.add(planKey);

      await enqueue({
        campaign,
        runId,
        needed,
        keywordPlan: plan,
        platform: platformSlug,
        priority: 100,
      });
      enqueued += 1;
      console.log(
        `[ExecutionHeartbeat] Campaign ${campaign?.id} 派发任务: platform=${platformSlug} keyword=${plan.keyword} type=${plan.keywordType}`
      );
      if (planKey) existingKeywords?.add(planKey);
      const planSignalKey = normalizeSignalMatchKey(plan.keyword);
      if (planSignalKey) existingKeywords?.add(planSignalKey);
    }
  }

  return { enqueued, failed };
}

export async function runExecutionForCampaignById(campaignId, now = new Date()) {
  const rows = await queryTikTok(
    `
    SELECT
      id,
      session_id AS sessionId,
      influencers_per_day AS influencersPerDay,
      keyword_strategy AS keywordStrategy,
      product_info AS productInfo,
      campaign_info AS campaignInfo,
      influencer_profile AS influencerProfile,
      status
    FROM tiktok_campaign
    WHERE id = ?
    LIMIT 1
  `,
    [campaignId]
  );
  if (!rows?.length) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  const r = rows[0];
  const campaign = {
    id: r.id,
    sessionId: r.sessionId || null,
    influencersPerDay: Number(r.influencersPerDay || 0) || 0,
    keywordStrategy: typeof r.keywordStrategy === "string" ? r.keywordStrategy.trim() : null,
    productInfo: parseJsonOrObject(r.productInfo) || {},
    campaignInfo: parseJsonOrObject(r.campaignInfo) || {},
    influencerProfile: parseJsonOrObject(r.influencerProfile) || {},
    status: r.status || "running",
  };
  await runExecutionForCampaign(campaign, now);
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
