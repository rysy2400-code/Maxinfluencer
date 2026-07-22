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
  enrichCampaignInfoCountryFields,
  primaryRegionIsoFromCampaignInfo,
} from "../influencer/campaign-country-codes.js";
import {
  normalizeCampaignInfoPlatforms,
  primaryPlatformSlugFromCampaignInfo,
} from "../influencer/resolve-campaign-platforms.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "./campaign-execution-keys.js";
import { resolveNeedSample } from "../execution/need-sample.js";
import { parseQuoteNegotiation, resolveLatestInfluencerQuote } from "../execution/quote-resolution.js";
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
  return parseQuoteNegotiation(raw);
}

/** campaign_info JSON 落库前：平台 canonical + 国家 ISO 等 */
function prepareCampaignInfoForDb(campaignInfo) {
  if (campaignInfo == null) return null;
  return enrichCampaignInfoCountryFields(
    normalizeCampaignInfoPlatforms(campaignInfo)
  );
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

  const campaignInfoForDb = prepareCampaignInfoForDb(campaignInfo);
  const platform = primaryPlatformSlugFromCampaignInfo(campaignInfoForDb);
  const region = primaryRegionIsoFromCampaignInfo(campaignInfoForDb);
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
    campaignInfoForDb ? JSON.stringify(campaignInfoForDb) : null,
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

/**
 * 同一会话仅保留一条活跃 campaign：已存在则更新快照，否则 INSERT。
 * @returns {Promise<{ id: string, sessionId: string, reused: boolean }>}
 */
export async function upsertCampaignForSession(data) {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("upsertCampaignForSession 需要 sessionId");
  }

  const existing = await getCampaignBySessionId(sessionId);
  if (!existing) {
    const created = await createCampaign(data);
    return { ...created, reused: false };
  }

  const influencers = Array.isArray(data.influencers) ? data.influencers : [];
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
      : undefined;

  await updateCampaign(existing.id, {
    productInfo: data.productInfo ?? undefined,
    campaignInfo: data.campaignInfo ?? undefined,
    influencerProfile: data.influencerProfile ?? undefined,
    contentScript: data.contentScript ?? undefined,
    influencersPerDay: data.influencersPerDay ?? undefined,
    keywordStrategy: data.keywordStrategy ?? undefined,
    ...(recommendedInfluencersPayload !== undefined
      ? { recommendedInfluencers: recommendedInfluencersPayload }
      : {}),
    status: "running",
  });

  return { id: existing.id, sessionId, reused: true };
}

/**
 * 按会话 id 查关联的已发布 Campaign（排除软删）
 * @param {string} sessionId - tiktok_campaign_sessions.id
 * @returns {Promise<{ id: string, sessionId: string, status: string, influencersPerDay: number|null, createdAt: * }|null>}
 */
export async function getCampaignBySessionId(sessionId) {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) return null;

  const rows = await queryTikTok(
    `SELECT id, session_id, status, influencers_per_day, created_at
     FROM tiktok_campaign
     WHERE session_id = ? AND status <> 'deleted'
     ORDER BY created_at DESC
     LIMIT 1`,
    [sid]
  );
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    sessionId: r.session_id,
    status: r.status,
    influencersPerDay: r.influencers_per_day ?? null,
    createdAt: r.created_at,
  };
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
    statusBeforePause: r.status_before_pause ?? null,
    influencersPerDay: r.influencers_per_day ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CAMPAIGN_UPDATE_KEYS = {
  status: "status",
  statusBeforePause: "status_before_pause",
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
  const normalized = { ...updates };
  if (normalized.campaignInfo != null) {
    normalized.campaignInfo = prepareCampaignInfoForDb(normalized.campaignInfo);
  }

  const setClauses = [];
  const values = [];
  for (const [k, v] of Object.entries(normalized)) {
    const col = CAMPAIGN_UPDATE_KEYS[k];
    if (!col) continue;
    setClauses.push(`${col} = ?`);
    values.push(
      typeof v === "object" && v !== null && !(v instanceof Date)
        ? JSON.stringify(v)
        : v
    );
  }
  if (normalized.campaignInfo != null) {
    const ci = normalized.campaignInfo;
    setClauses.push("region = ?");
    values.push(primaryRegionIsoFromCampaignInfo(ci));
    setClauses.push("platform = ?");
    values.push(primaryPlatformSlugFromCampaignInfo(ci));
    if (ci.budget != null && typeof ci.budget === "number") {
      setClauses.push("budget = ?");
      values.push(ci.budget);
    }
    if (ci.commission != null && typeof ci.commission === "number") {
      setClauses.push("commission = ?");
      values.push(ci.commission);
    }
  }

  if (setClauses.length === 0) return;
  values.push(campaignId);
  const sql = `UPDATE tiktok_campaign SET ${setClauses.join(
    ", "
  )} WHERE id = ?`;
  await queryTikTok(sql, values);
}

/** 执行表 created_at → ISO，供排序与前端展示 */
function executionCreatedAtToIso(createdAt) {
  if (createdAt == null) return null;
  if (createdAt instanceof Date) return createdAt.toISOString();
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 对话表 event_time / sent_at：入库时用 UTC 墙钟写入 MySQL（见 influencer-conversation-dao toMysqlTimestamp）。
 * mysql2 在 +8 等时区会把该墙钟读成「本地时刻」，需还原为 UTC 再转 ISO，前端才能按北京时间展示正确。
 */
function businessTimeToUtcIso(at) {
  if (at == null) return null;
  if (at instanceof Date) {
    const y = at.getFullYear();
    const mo = at.getMonth();
    const d = at.getDate();
    const h = at.getHours();
    const mi = at.getMinutes();
    const s = at.getSeconds();
    const ms = at.getMilliseconds();
    return new Date(Date.UTC(y, mo, d, h, mi, s, ms)).toISOString();
  }
  const raw = String(at).trim();
  if (!raw) return null;
  if (/Z$/i.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const norm = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = new Date(`${norm}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 最新回复：邮件 inbound 与砍价记录中红人条目的较晚者 */
function resolveLastInboundReplyAt(emailAt, quoteNegotiation) {
  let bestIso = emailAt ? businessTimeToUtcIso(emailAt) : null;
  let bestMs = bestIso ? new Date(bestIso).getTime() : 0;
  if (!Array.isArray(quoteNegotiation)) return bestIso;
  for (const entry of quoteNegotiation) {
    if (entry?.role !== "influencer") continue;
    const iso = businessTimeToUtcIso(entry?.at);
    const ms = iso ? new Date(iso).getTime() : 0;
    if (ms > bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  }
  return bestMs > 0 ? bestIso : null;
}

/** 红人执行阶段分组用 */
const STAGE_PENDING_QUOTE = "pending_quote";
const STAGE_QUOTE_SUBMITTED = "quote_submitted";
const STAGE_QUOTE_REJECTED = "quote_rejected";
const STAGE_PENDING_SAMPLE = "pending_sample";
const STAGE_PENDING_DRAFT = "pending_draft";
const STAGE_PUBLISHED = "published";

/** campaign 下各执行红人最近一封红人来信（email_inbound）时间，key = tiktok_username */
async function loadLastInboundReplyAtByUsername(campaignId, usernames = null) {
  const normalizedUsernames = Array.isArray(usernames)
    ? usernames
        .map((u) => (u == null ? "" : String(u).trim()))
        .filter(Boolean)
    : null;
  const usernameFilter =
    normalizedUsernames && normalizedUsernames.length > 0
      ? `AND tiktok_username IN (${normalizedUsernames.map(() => "?").join(",")})`
      : "";
  const rows = await queryTikTok(
    `
    WITH execs AS (
      SELECT
        tiktok_username,
        influencer_id AS platform_influencer_id
      FROM tiktok_campaign_execution
      WHERE campaign_id = ?
        ${usernameFilter}
    ),
    inbound AS (
      SELECT
        e.tiktok_username,
        COALESCE(m.event_time, m.sent_at, m.created_at) AS last_inbound_at,
        ROW_NUMBER() OVER (
          PARTITION BY e.tiktok_username
          ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC
        ) AS rn
      FROM execs e
      INNER JOIN tiktok_influencer_conversation_messages m
        ON (
          (e.platform_influencer_id IS NOT NULL AND TRIM(e.platform_influencer_id) <> '' AND m.influencer_id = e.platform_influencer_id)
          OR m.influencer_id = e.tiktok_username
        )
      WHERE m.event_type = 'email_inbound'
    )
    SELECT tiktok_username, last_inbound_at
    FROM inbound
    WHERE rn = 1
    `,
    normalizedUsernames && normalizedUsernames.length > 0
      ? [campaignId, ...normalizedUsernames]
      : [campaignId]
  );
  const map = {};
  for (const r of rows || []) {
    const u = r.tiktok_username;
    if (!u) continue;
    const at = r.last_inbound_at;
    if (at == null) continue;
    const iso = businessTimeToUtcIso(at);
    if (iso) map[u] = iso;
  }
  return map;
}

const EXECUTION_STATUS_STAGE_MAP = {
  contacted: [STAGE_PENDING_QUOTE],
  pendingPrice: [STAGE_QUOTE_SUBMITTED, STAGE_QUOTE_REJECTED],
  pendingSample: [STAGE_PENDING_SAMPLE],
  pendingDraft: ["draft_submitted", STAGE_PENDING_DRAFT],
  published: [STAGE_PUBLISHED],
};

const EXECUTION_STATUS_COLUMN_KEYS = [
  "contacted",
  "pendingPrice",
  "pendingSample",
  "pendingDraft",
  "published",
];

function emptyExecutionColumns() {
  return {
    contacted: [],
    pendingPrice: [],
    pendingSample: [],
    pendingDraft: [],
    published: [],
  };
}

function normalizeExecutionStatusOptions(options = {}) {
  const stage =
    typeof options.stage === "string" &&
    EXECUTION_STATUS_STAGE_MAP[options.stage]
      ? options.stage
      : null;
  const limitNum = Number(options.limit);
  const offsetNum = Number(options.offset);
  return {
    stage,
    limit:
      Number.isFinite(limitNum) && limitNum > 0
        ? Math.min(Math.floor(limitNum), 100)
        : null,
    offset:
      Number.isFinite(offsetNum) && offsetNum > 0
        ? Math.floor(offsetNum)
        : 0,
  };
}

function resolveExecutionColumnFromStage(stage) {
  if (stage === STAGE_PENDING_QUOTE) return "contacted";
  if (stage === STAGE_QUOTE_SUBMITTED || stage === STAGE_QUOTE_REJECTED) {
    return "pendingPrice";
  }
  if (stage === STAGE_PENDING_SAMPLE) return "pendingSample";
  if (stage === "draft_submitted" || stage === STAGE_PENDING_DRAFT) {
    return "pendingDraft";
  }
  if (stage === STAGE_PUBLISHED) return "published";
  return "contacted";
}

export async function getCampaignExecutionStatus(campaignId, options = {}) {
  const c = await getCampaignById(campaignId);
  if (!c) return null;

  const needSample = resolveNeedSample(c.productInfo);
  const paging = normalizeExecutionStatusOptions(options);
  const columns = emptyExecutionColumns();

  const countSql = `
    SELECT
      SUM(CASE WHEN stage = ? OR stage IS NULL OR stage = '' THEN 1 ELSE 0 END) AS contacted,
      SUM(CASE WHEN stage IN (?, ?) THEN 1 ELSE 0 END) AS pendingPrice,
      SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingPricePending,
      SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingPriceRejected,
      SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingSample,
      SUM(CASE WHEN stage IN (?, ?) THEN 1 ELSE 0 END) AS pendingDraft,
      SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS published
    FROM tiktok_campaign_execution
    WHERE campaign_id = ?
  `;

  const rowWhere = ["campaign_id = ?"];
  const rowParams = [campaignId];
  if (paging.stage) {
    const stages = EXECUTION_STATUS_STAGE_MAP[paging.stage];
    if (paging.stage === "contacted") {
      rowWhere.push(
        `(stage IN (${stages.map(() => "?").join(",")}) OR stage IS NULL OR stage = '')`
      );
    } else {
      rowWhere.push(`stage IN (${stages.map(() => "?").join(",")})`);
    }
    rowParams.push(...stages);
  }
  const orderSql =
    paging.stage === "pendingPrice"
      ? `ORDER BY updated_at DESC, id DESC`
      : `ORDER BY created_at DESC, id DESC`;
  const limitSql = paging.limit != null ? `LIMIT ${paging.limit} OFFSET ${paging.offset}` : "";

  const [execRows, countRows, analyzedRows] = await Promise.all([
    queryTikTok(
      `
      SELECT *
      FROM tiktok_campaign_execution
      WHERE ${rowWhere.join(" AND ")}
      ${orderSql}
      ${limitSql}
      `,
      rowParams
    ),
    queryTikTok(countSql, [
      STAGE_PENDING_QUOTE,
      STAGE_QUOTE_SUBMITTED,
      STAGE_QUOTE_REJECTED,
      STAGE_QUOTE_SUBMITTED,
      STAGE_QUOTE_REJECTED,
      STAGE_PENDING_SAMPLE,
      "draft_submitted",
      STAGE_PENDING_DRAFT,
      STAGE_PUBLISHED,
      campaignId,
    ]),
    queryTikTok(
      `
      SELECT COUNT(*) AS total
      FROM tiktok_campaign_influencer_candidates
      WHERE campaign_id = ?
        AND match_analysis IS NOT NULL
    `,
      [campaignId]
    ),
  ]);

  const analyzedCount = Number(analyzedRows?.[0]?.total ?? analyzedRows?.[0]?.TOTAL ?? 0);
  const counts = countRows?.[0] || {};
  const totalByStage = {
    contacted: Number(counts.contacted || 0),
    pendingPrice: Number(counts.pendingPrice || 0),
    pendingPricePending: Number(
      counts.pendingPricePending ?? counts.pendingpricepending ?? 0
    ),
    pendingPriceRejected: Number(
      counts.pendingPriceRejected ?? counts.pendingpricerejected ?? 0
    ),
    pendingSample: Number(counts.pendingSample || 0),
    pendingDraft: Number(counts.pendingDraft || 0),
    published: Number(counts.published || 0),
  };
  const fetchedUsernames = (execRows || [])
    .map((row) => row?.tiktok_username)
    .filter(Boolean);
  const lastInboundReplyByUsername = await loadLastInboundReplyAtByUsername(
    campaignId,
    paging.limit != null ? fetchedUsernames : null
  );

  execRows.forEach((row) => {
    const id = row.tiktok_username;
    const base = parseJson(row.influencer_snapshot) || {};
    const lastEvent = parseJson(row.last_event) || {};
    const name = base.name || id;
    const stage = row.stage || STAGE_PENDING_QUOTE;
    const executionShippingInfo = parseJson(row.shipping_info);
    const executionVideoDraft = parseJson(row.video_draft);
    const quoteNeg = parseJson(row.quote_negotiation);
    const quoteNegotiation = Array.isArray(quoteNeg) ? quoteNeg : [];
    const effectiveInfluencerQuote = resolveLatestInfluencerQuote({
      quoteNegotiation,
      fallbackAmount: row.flat_fee,
      fallbackCurrency: row.currency,
    });
    const item = {
      id,
      platformInfluencerId: row.influencer_id || null,
      name,
      stage,
      source: row.source || "web_search",
      flatFeeUsd: effectiveInfluencerQuote?.amount ?? null,
      executionVideoLink: row.video_link || null,
      executionShippingInfo,
      executionVideoDraft,
      ...base,
      ...lastEvent,
      currency: effectiveInfluencerQuote?.currency || (row.currency ? String(row.currency).toUpperCase() : "USD"),
      quoteNegotiation,
      executionCreatedAt: executionCreatedAtToIso(row.created_at),
      lastInboundReplyAt: resolveLastInboundReplyAt(
        lastInboundReplyByUsername[id] || null,
        quoteNegotiation
      ),
    };

    columns[resolveExecutionColumnFromStage(stage)].push(item);
  });

  columns.contacted.sort((a, b) => {
    const ta = a.executionCreatedAt
      ? new Date(a.executionCreatedAt).getTime()
      : 0;
    const tb = b.executionCreatedAt
      ? new Date(b.executionCreatedAt).getTime()
      : 0;
    return tb - ta;
  });

  columns.pendingPrice.sort((a, b) => {
    const ta = a.lastInboundReplyAt
      ? new Date(a.lastInboundReplyAt).getTime()
      : 0;
    const tb = b.lastInboundReplyAt
      ? new Date(b.lastInboundReplyAt).getTime()
      : 0;
    return tb - ta;
  });

  return {
    campaignId: c.id,
    status: c.status,
    influencersPerDay: c.influencersPerDay,
    needSample,
    columns,
    totalByStage,
    page: {
      stage: paging.stage,
      limit: paging.limit,
      offset: paging.offset,
      hasMoreByStage: Object.fromEntries(
        EXECUTION_STATUS_COLUMN_KEYS.map((key) => [
          key,
          paging.stage === key && paging.limit != null
            ? paging.offset + columns[key].length < totalByStage[key]
            : false,
        ])
      ),
    },
    contactedCount: totalByStage.contacted,
    analyzedCount: Number.isFinite(analyzedCount) ? analyzedCount : 0,
    repliedCount: 0,
    publishedCount: totalByStage.published,
    recentEvents: [],
    lastInboundReplyByUsername,
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
 *     at?: string,
 *     updateFlatFee?: boolean
 *   }
 * }} updates
 */
export async function updateExecutionStage(campaignId, influencerId, updates) {
  const { stage, lastEvent, quoteAppend } = updates;
  if (!stage && !quoteAppend && (lastEvent === undefined || lastEvent === null)) {
    return null;
  }

  const rows = await queryTikTok(
    `
    SELECT last_event, flat_fee, currency, quote_negotiation
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (!rows || rows.length === 0) return null;

  const row = rows[0];
  let merged = parseJson(row.last_event) || {};
  if (lastEvent && typeof lastEvent === "object") {
    merged = { ...merged, ...lastEvent };
  }

  let nextFlat = row.flat_fee;
  let nextCurrency = normalizeExecutionCurrency(row.currency);
  let negotiation = parseQuoteNegotiationColumn(row.quote_negotiation);
  let appendedQuote = null;

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
    appendedQuote = entry;
    negotiation = [...negotiation, entry];
    if (amt != null && quoteAppend.updateFlatFee !== false) {
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
  if (quoteAppend && quoteAppend.updateFlatFee !== false) {
    setClauses.push("flat_fee = ?");
    values.push(nextFlat);
    setClauses.push("currency = ?");
    values.push(nextCurrency);
  }
  if (quoteAppend) {
    setClauses.push("quote_negotiation = ?");
    values.push(JSON.stringify(negotiation));
  }
  if (setClauses.length === 0) return null;
  values.push(campaignId, ...paramsExecutionCreatorMatch(influencerId));
  await queryTikTok(
    `UPDATE tiktok_campaign_execution SET ${setClauses.join(", ")} WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    values
  );
  return {
    quoteEntry: appendedQuote,
    flatFeeUsd:
      nextFlat != null && Number.isFinite(Number(nextFlat))
        ? Number(nextFlat)
        : null,
    currency: nextCurrency,
  };
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
