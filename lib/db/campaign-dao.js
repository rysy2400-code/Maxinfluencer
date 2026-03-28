/**
 * Campaign 表 DAO（已发布 campaign）
 *
 * 目前实现基于：
 * - tiktok_campaign：Campaign 配置与 4 大板块快照 + 关键标量字段
 * - tiktok_campaign_execution：按红人维度的执行状态
 */
import { queryTikTok } from "./mysql-tiktok.js";

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

export async function createCampaign(data) {
  const id = data.id;
  const sessionId = data.sessionId;
  const productInfo = data.productInfo || null;
  const campaignInfo = data.campaignInfo || null;
  const influencerProfile = data.influencerProfile || null;
  const influencers = Array.isArray(data.influencers) ? data.influencers : [];
  const contentScript = data.contentScript || null;
  const influencersPerDay = data.influencersPerDay ?? 5;

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

  const sql = `
    INSERT INTO tiktok_campaign (
      id, session_id,
      platform, region, start_date, end_date, budget, commission,
      product_info, campaign_info, influencer_profile, content_script,
      influencers_per_day, status
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'running')
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
    influencersPerDay,
  ]);

  // 初始化每个红人的执行行（如有）
  for (const inf of influencers) {
    const influencerId =
      inf.id || inf.username || inf.handle || inf.name || String(inf);
    const snapshot =
      typeof inf === "object" && inf !== null ? JSON.stringify(inf) : null;
    await queryTikTok(
      `
      INSERT INTO tiktok_campaign_execution (campaign_id, influencer_id, influencer_snapshot, stage)
      VALUES (?, ?, ?, 'pending_quote')
    `,
      [id, influencerId, snapshot]
    );
  }

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
    return { id: row.influencer_id, stage: row.stage, ...base };
  });

  return {
    id: r.id,
    sessionId: r.session_id,
    productInfo: parseJson(r.product_info),
    campaignInfo: parseJson(r.campaign_info),
    influencerProfile: parseJson(r.influencer_profile),
    influencers,
    contentScript: parseJson(r.content_script),
    status: r.status,
    influencersPerDay: r.influencers_per_day ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CAMPAIGN_UPDATE_KEYS = {
  status: "status",
  influencersPerDay: "influencers_per_day",
  productInfo: "product_info",
  campaignInfo: "campaign_info",
  influencerProfile: "influencer_profile",
  contentScript: "content_script",
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

/** 红人执行阶段：待审核价格 / 待寄样品 / 待审核草稿 / 已发布视频 */
const STAGE_PENDING_PRICE = "pending_quote";
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

  const pendingPrice = [];
  const pendingSample = [];
  const pendingDraft = [];
  const published = [];

  execRows.forEach((row) => {
    const id = row.influencer_id;
    const base = parseJson(row.influencer_snapshot) || {};
    const lastEvent = parseJson(row.last_event) || {};
    const name = base.name || id;
    const stage = row.stage || STAGE_PENDING_PRICE;
    const item = { id, name, stage, ...base, ...lastEvent };

    if (stage === "quote_submitted" || stage === STAGE_PENDING_PRICE) {
      pendingPrice.push(item);
    } else if (stage === STAGE_PENDING_SAMPLE || stage === "sample_sent") {
      pendingSample.push(item);
    } else if (stage === "draft_submitted" || stage === STAGE_PENDING_DRAFT) {
      pendingDraft.push(item);
    } else if (stage === STAGE_PUBLISHED) {
      published.push(item);
    } else {
      pendingPrice.push(item);
    }
  });

  return {
    campaignId: c.id,
    status: c.status,
    influencersPerDay: c.influencersPerDay,
    needSample,
    columns: {
      pendingPrice,
      pendingSample,
      pendingDraft,
      published,
    },
    contactedCount: 0,
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
    `SELECT * FROM tiktok_campaign_execution WHERE campaign_id = ? AND influencer_id = ?`,
    [campaignId, influencerId]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  const lastEvent = parseJson(r.last_event) || {};
  return { ...r, lastEvent };
}

/**
 * 更新红人执行阶段及 last_event
 * @param {string} campaignId
 * @param {string} influencerId
 * @param {{ stage?: string, lastEvent?: object }} updates - stage 为新阶段，lastEvent 会合并到现有 last_event
 */
export async function updateExecutionStage(campaignId, influencerId, updates) {
  const { stage, lastEvent } = updates;
  if (!stage && !lastEvent) return;

  const rows = await queryTikTok(
    `SELECT last_event FROM tiktok_campaign_execution WHERE campaign_id = ? AND influencer_id = ?`,
    [campaignId, influencerId]
  );
  if (!rows || rows.length === 0) return;

  let merged = parseJson(rows[0].last_event) || {};
  if (lastEvent && typeof lastEvent === "object") {
    merged = { ...merged, ...lastEvent };
  }

  const setClauses = [];
  const values = [];
  if (stage) {
    setClauses.push("stage = ?");
    values.push(stage);
  }
  if (Object.keys(merged).length > 0 || lastEvent) {
    setClauses.push("last_event = ?");
    values.push(JSON.stringify(merged));
  }
  if (setClauses.length === 0) return;
  values.push(campaignId, influencerId);
  await queryTikTok(
    `UPDATE tiktok_campaign_execution SET ${setClauses.join(", ")} WHERE campaign_id = ? AND influencer_id = ?`,
    values
  );
}
