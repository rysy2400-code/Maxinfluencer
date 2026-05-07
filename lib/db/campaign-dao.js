/**
 * Campaign 表 DAO（已发布 campaign）
 *
 * 目前实现基于：
 * - tiktok_campaign：Campaign 配置与 4 大板块快照 + 关键标量字段
 * - tiktok_campaign_execution：按红人维度的执行状态
 */
import { queryTikTok } from "./mysql-tiktok.js";
import {
  buildNormalizedInfluencerSnapshot,
  resolveTiktokUsername,
} from "./campaign-candidates-dao.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "./campaign-execution-keys.js";

function normalizePrimaryValue(v) {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** 安全解析 JSON：若已是对象则直接返回，避免 mysql2 已解析的 JSON 列被二次 parse 报错 */
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

function normalizeExecutionCurrency(c) {
  const s = String(c || "")
    .trim()
    .toUpperCase()
    .slice(0, 8);
  return s || "USD";
}

function parseQuoteNegotiationColumn(raw) {
  const o = parseJson(raw);
  return Array.isArray(o) ? o : [];
}

export async function createCampaign(data) {
  const id = data.id;
  const sessionId = data.sessionId;
  const productInfo = data.productInfo || null;
  const campaignInfo = data.campaignInfo || null;
  const influencerProfile = data.influencerProfile || null;
  const influencers = Array.isArray(data.influencers) ? data.influencers : [];
  const contentScript = data.contentScript || null;
  const influencersPerDay = data.influencersPerDay ?? 5;
  const keywordStrategy = typeof data.keywordStrategy === "string" ? data.keywordStrategy.trim() : null;

  const platform = normalizePrimaryValue(campaignInfo?.platform) || "tiktok";
  const region = normalizePrimaryValue(campaignInfo?.region) || "US";
  const budget =
    campaignInfo && typeof campaignInfo.budget === "number"
      ? campaignInfo.budget
      : null;
  const commission =
    campaignInfo && typeof campaignInfo.commission === "number"
      ? campaignInfo.commission
      : null;

  const recommendedInfluencersPayload =
    influencers.length > 0
      ? influencers
          .map((inf) => {
            if (!inf || typeof inf !== "object") return null;
            const handle = resolveTiktokUsername(inf);
            if (!handle) return null;
            return {
              id: handle,
              ...buildNormalizedInfluencerSnapshot(inf, {}),
            };
          })
          .filter(Boolean)
      : [];

  const sql = `
    INSERT INTO tiktok_campaign (
      id, session_id,
      platform, region, start_date, end_date, budget, commission,
      product_info, campaign_info, influencer_profile, content_script,
      recommended_influencers,
      keyword_strategy, influencers_per_day, status
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
  `;
  await queryTikTok(sql, [
    id,
    sessionId,
    platform,
    region,
    budget,
    commission,
    productInfo ? JSON.stringify(productInfo) : null,
    campaignInfo ? JSON.stringify(campaignInfo) : null,
    influencerProfile ? JSON.stringify(influencerProfile) : null,
    contentScript ? JSON.stringify(contentScript) : null,
    recommendedInfluencersPayload.length > 0
      ? JSON.stringify(recommendedInfluencersPayload)
      : null,
    keywordStrategy || null,
    influencersPerDay,
  ]);

  return { id, sessionId };
}

export async function getCampaignById(campaignId) {
  const sql = `SELECT * FROM tiktok_campaign WHERE id = ?`;
  const rows = await queryTikTok(sql, [campaignId]);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];

  const execRows = await queryTikTok(
    `SELECT * FROM tiktok_campaign_execution WHERE campaign_id = ?`,
    [campaignId]
  );

  const influencers = execRows.map((row) => {
    const base = parseJson(row.influencer_snapshot) || {};
    return {
      id: row.tiktok_username,
      platformInfluencerId: row.influencer_id || null,
      stage: row.stage,
      ...base,
    };
  });

  return {
    id: r.id,
    sessionId: r.session_id,
    productInfo: parseJson(r.product_info),
    campaignInfo: parseJson(r.campaign_info),
    influencerProfile: parseJson(r.influencer_profile),
    influencers,
    recommendedInfluencers: parseJson(r.recommended_influencers) || [],
    contentScript: parseJson(r.content_script),
    keywordStrategy: r.keyword_strategy || null,
    status: r.status,
    influencersPerDay: r.influencers_per_day ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CAMPAIGN_UPDATE_KEYS = {
  status: "status",
  influencersPerDay: "influencers_per_day",
  recommendedInfluencers: "recommended_influencers",
  productInfo: "product_info",
  campaignInfo: "campaign_info",
  influencerProfile: "influencer_profile",
  contentScript: "content_script",
  keywordStrategy: "keyword_strategy",
  deletedAt: "deleted_at",
  deletedBy: "deleted_by",
  deleteReason: "delete_reason",
};

export async function updateCampaign(campaignId, updates) {
  const setClauses = [];
  const values = [];
  for (const [k, v] of Object.entries(updates)) {
    const col = CAMPAIGN_UPDATE_KEYS[k];
    if (!col) continue;
    setClauses.push(`${col} = ?`);
    values.push(
      typeof v === "object" && v !== null && !(v instanceof Date)
        ? JSON.stringify(v)
        : v
    );
  }
  if (setClauses.length === 0) return;
  values.push(campaignId);
  const sql = `UPDATE tiktok_campaign SET ${setClauses.join(
    ", "
  )} WHERE id = ?`;
  await queryTikTok(sql, values);
}

/** 红人执行阶段分组用 */
const STAGE_PENDING_QUOTE = "pending_quote";
const STAGE_QUOTE_SUBMITTED = "quote_submitted";
const STAGE_QUOTE_REJECTED = "quote_rejected";
const STAGE_PENDING_SAMPLE = "pending_sample";
const STAGE_PENDING_DRAFT = "pending_draft";
const STAGE_PUBLISHED = "published";

export async function getCampaignExecutionStatus(campaignId) {
  const c = await getCampaignById(campaignId);
  if (!c) return null;

  // 是否需要寄样：从产品信息中读取，若明确为 false 则认为不寄样；否则默认视为需要寄样
  const needSample =
    c.productInfo && typeof c.productInfo.needSample === "boolean"
      ? c.productInfo.needSample
      : true;

  const execRows = await queryTikTok(
    `SELECT * FROM tiktok_campaign_execution WHERE campaign_id = ?`,
    [campaignId]
  );

  const contacted = [];
  const pendingPrice = [];
  const pendingSample = [];
  const pendingDraft = [];
  const published = [];

  execRows.forEach((row) => {
    const id = row.tiktok_username;
    const base = parseJson(row.influencer_snapshot) || {};
    const lastEvent = parseJson(row.last_event) || {};
    const name = base.name || id;
    const stage = row.stage || STAGE_PENDING_QUOTE;
    const executionShippingInfo = parseJson(row.shipping_info);
    const executionVideoDraft = parseJson(row.video_draft);
    const quoteNeg = parseJson(row.quote_negotiation);
    const item = {
      id,
      platformInfluencerId: row.influencer_id || null,
      name,
      stage,
      flatFeeUsd:
        row.flat_fee != null && !Number.isNaN(Number(row.flat_fee))
          ? Number(row.flat_fee)
          : null,
      executionVideoLink: row.video_link || null,
      executionShippingInfo,
      executionVideoDraft,
      ...base,
      ...lastEvent,
      currency: row.currency ? String(row.currency).toUpperCase() : "USD",
      quoteNegotiation: Array.isArray(quoteNeg) ? quoteNeg : [],
    };

    if (stage === STAGE_PENDING_QUOTE) {
      contacted.push(item);
    } else if (
      stage === STAGE_QUOTE_SUBMITTED ||
      stage === STAGE_QUOTE_REJECTED
    ) {
      pendingPrice.push(item);
    } else if (stage === STAGE_PENDING_SAMPLE) {
      pendingSample.push(item);
    } else if (stage === "draft_submitted" || stage === STAGE_PENDING_DRAFT) {
      pendingDraft.push(item);
    } else if (stage === STAGE_PUBLISHED) {
      published.push(item);
    } else {
      contacted.push(item);
    }
  });

  return {
    campaignId: c.id,
    status: c.status,
    influencersPerDay: c.influencersPerDay,
    needSample,
    columns: {
      contacted,
      pendingPrice,
      pendingSample,
      pendingDraft,
      published,
    },
    contactedCount: contacted.length,
    repliedCount: 0,
    publishedCount: published.length,
    recentEvents: [],
  };
}

/**
 * 获取单条执行记录（含 last_event）
 */
export async function getExecutionRow(campaignId, influencerId) {
  const rows = await queryTikTok(
    `SELECT * FROM tiktok_campaign_execution WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  const lastEvent = parseJson(r.last_event) || {};
  return { ...r, lastEvent };
}

/**
 * 更新红人执行阶段及 last_event，可选追加 quote_negotiation 并更新 flat_fee / currency
 * @param {string} campaignId
 * @param {string} influencerId
 * @param {{
 *   stage?: string,
 *   lastEvent?: object,
 *   quoteAppend?: {
 *     role?: string,
 *     amount?: number | null,
 *     currency?: string,
 *     reason?: string | null,
 *     type?: string | null,
 *     source?: string,
 *     at?: string
 *   }
 * }} updates
 */
export async function updateExecutionStage(campaignId, influencerId, updates) {
  const { stage, lastEvent, quoteAppend } = updates;
  if (!stage && !quoteAppend && (lastEvent === undefined || lastEvent === null)) {
    return;
  }

  const rows = await queryTikTok(
    `
    SELECT last_event, flat_fee, currency, quote_negotiation
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (!rows || rows.length === 0) return;

  const row = rows[0];
  let merged = parseJson(row.last_event) || {};
  if (lastEvent && typeof lastEvent === "object") {
    merged = { ...merged, ...lastEvent };
  }

  let nextFlat = row.flat_fee;
  let nextCurrency = normalizeExecutionCurrency(row.currency);
  let negotiation = parseQuoteNegotiationColumn(row.quote_negotiation);

  if (quoteAppend && typeof quoteAppend === "object") {
    const entryCurrency = normalizeExecutionCurrency(
      quoteAppend.currency ?? nextCurrency
    );
    const amt =
      quoteAppend.amount != null && Number.isFinite(Number(quoteAppend.amount))
        ? Number(quoteAppend.amount)
        : null;
    const entry = {
      role: quoteAppend.role || "advertiser",
      amount: amt,
      currency: entryCurrency,
      reason:
        typeof quoteAppend.reason === "string"
          ? quoteAppend.reason.trim() || null
          : null,
      type: quoteAppend.type || null,
      at: quoteAppend.at || new Date().toISOString(),
      source: quoteAppend.source || "patch_execution",
    };
    negotiation = [...negotiation, entry];
    if (amt != null) {
      nextFlat = amt;
      nextCurrency = entryCurrency;
    }
  }

  const setClauses = [];
  const values = [];
  if (stage) {
    setClauses.push("stage = ?");
    values.push(stage);
  }
  if (lastEvent != null && typeof lastEvent === "object") {
    setClauses.push("last_event = ?");
    values.push(JSON.stringify(merged));
  }
  if (quoteAppend) {
    setClauses.push("flat_fee = ?");
    values.push(nextFlat);
    setClauses.push("currency = ?");
    values.push(nextCurrency);
    setClauses.push("quote_negotiation = ?");
    values.push(JSON.stringify(negotiation));
  }
  if (setClauses.length === 0) return;
  values.push(campaignId, ...paramsExecutionCreatorMatch(influencerId));
  await queryTikTok(
    `UPDATE tiktok_campaign_execution SET ${setClauses.join(", ")} WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    values
  );
}

/**
 * 通过 session_id 软删除已发布 Campaign（不可恢复）
 * 仅更新 tiktok_campaign，不物理删除明细数据。
 * 同一 session 若历史上有多条关联行，会一并标记为 deleted。
 */
/**
 * 从执行行读取与主档一致的平台 influencer_id（TikTok userId）。
 * @param {string} campaignId
 * @param {string} tiktokUsername handle，无 @
 * @returns {Promise<string|null>}
 */
export async function getExecutionPlatformInfluencerId(campaignId, tiktokUsername) {
  if (!campaignId || tiktokUsername == null) return null;
  const h = String(tiktokUsername).replace(/^@/, "").trim();
  if (!h) return null;
  const rows = await queryTikTok(
    `
    SELECT influencer_id
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND tiktok_username = ?
    LIMIT 1
  `,
    [campaignId, h]
  );
  const v = rows?.[0]?.influencer_id;
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

export async function softDeleteCampaignBySessionId(
  sessionId,
  { deletedBy = "user", deleteReason = "用户删除已发布 campaign" } = {}
) {
  if (!sessionId) {
    return { success: false, message: "sessionId 不能为空" };
  }

  const rows = await queryTikTok(
    `SELECT id, status FROM tiktok_campaign WHERE session_id = ?`,
    [sessionId]
  );
  if (!rows || rows.length === 0) {
    return { success: false, message: "未找到关联的已发布 campaign" };
  }

  const active = rows.filter((r) => r.status !== "deleted");
  if (active.length === 0) {
    return { success: true, campaignId: rows[0].id, message: "campaign 已是删除状态" };
  }

  await queryTikTok(
    `UPDATE tiktok_campaign
     SET status = 'deleted',
         deleted_at = NOW(),
         deleted_by = ?,
         delete_reason = ?,
         updated_at = NOW()
     WHERE session_id = ? AND status <> 'deleted'`,
    [deletedBy, deleteReason, sessionId]
  );

  return { success: true, campaignId: active[0].id, message: "campaign 已软删除" };
}
