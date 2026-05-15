import { queryTikTok } from "./mysql-tiktok.js";

const SESSION_TABLE = "tiktok_campaign_sessions";

/** execution.stage 组内排序（小在前） */
export const EXECUTION_STAGE_ORDER = [
  "pending_quote",
  "quote_submitted",
  "quote_rejected",
  "pending_sample",
  "pending_draft",
  "draft_submitted",
  "published",
];

function stageOrderIndex(stage) {
  const s = String(stage || "");
  const i = EXECUTION_STAGE_ORDER.indexOf(s);
  return i === -1 ? 999 : i;
}

function searchPattern(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  return `%${s.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function encodeAccountCursor({ companyName, advertiserUsername }) {
  return Buffer.from(
    JSON.stringify({
      companyName: String(companyName ?? ""),
      advertiserUsername: String(advertiserUsername ?? ""),
    }),
    "utf8"
  ).toString("base64url");
}

function decodeAccountCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
    const o = JSON.parse(raw);
    if (!o || typeof o.companyName !== "string" || typeof o.advertiserUsername !== "string") return null;
    return { companyName: o.companyName, advertiserUsername: o.advertiserUsername };
  } catch {
    return null;
  }
}

function brandProductLabel(productInfo) {
  if (!productInfo || typeof productInfo !== "object") return "";
  const brand = String(productInfo.brandName || "").trim();
  const product = String(productInfo.productName || "").trim();
  if (brand && product) return `${brand} · ${product}`;
  return brand || product || "";
}

function parseProductInfo(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 按项目视图：公司·账户 → running/paused/completed → campaign → execution 红人
 * - 仅 published session；campaign.status in running,paused,completed；排除 deleted
 * - 含无 execution 的空 campaign 分组
 * - orphans：有会话消息但不在任何 qualifying execution（按 influencer_id）中的红人
 */
export async function listInfluencerInboxByProject({
  q = null,
  accountCursor = null,
  accountLimit = 50,
} = {}) {
  const like = searchPattern(q);
  const decoded = decodeAccountCursor(accountCursor);
  const accLimit = Math.max(1, Math.min(100, Math.floor(Number(accountLimit) || 50)));

  const cursorSql = decoded
    ? `AND (
        IFNULL(a.name,'') > ?
        OR (IFNULL(a.name,'') = ? AND IFNULL(u.username,'') > ?)
      )`
    : "";

  const searchCampaignSql = like
    ? `AND (
        IFNULL(a.name,'') LIKE ?
        OR IFNULL(u.username,'') LIKE ?
        OR IFNULL(JSON_UNQUOTE(JSON_EXTRACT(c.product_info, '$.brandName')), '') LIKE ?
        OR IFNULL(JSON_UNQUOTE(JSON_EXTRACT(c.product_info, '$.productName')), '') LIKE ?
        OR EXISTS (
          SELECT 1 FROM tiktok_campaign_execution e0
          LEFT JOIN tiktok_influencer i0 ON (
            (e0.influencer_id IS NOT NULL AND TRIM(e0.influencer_id) <> '' AND i0.influencer_id = e0.influencer_id)
            OR ((e0.influencer_id IS NULL OR TRIM(e0.influencer_id) = '') AND i0.username = e0.tiktok_username)
          )
          WHERE e0.campaign_id = c.id AND (
            IFNULL(e0.influencer_id,'') LIKE ?
            OR IFNULL(i0.username,'') LIKE ?
            OR IFNULL(i0.display_name,'') LIKE ?
            OR IFNULL(i0.influencer_email,'') LIKE ?
          )
        )
      )`
    : "";

  const paramsAccounts = [];
  if (decoded) {
    paramsAccounts.push(decoded.companyName, decoded.companyName, decoded.advertiserUsername);
  }
  if (like) {
    paramsAccounts.push(like, like, like, like, like, like, like, like);
  }

  const accountSql = `
    SELECT DISTINCT
      s.advertiser_user_id AS advertiser_user_id,
      IFNULL(a.name,'') AS company_name,
      IFNULL(u.username,'') AS advertiser_username
    FROM tiktok_campaign c
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
    LEFT JOIN tiktok_advertiser_user u ON u.id = s.advertiser_user_id
    LEFT JOIN tiktok_advertiser a ON a.id = u.advertiser_id
    WHERE c.status IN ('running','paused','completed')
      AND s.advertiser_user_id IS NOT NULL
      ${cursorSql}
      ${searchCampaignSql}
    ORDER BY IFNULL(a.name,''), IFNULL(u.username,'')
    LIMIT ${accLimit + 1}
  `;

  const accountRows = await queryTikTok(accountSql, paramsAccounts);
  const hasMoreAccounts = accountRows.length > accLimit;
  const pageAccounts = hasMoreAccounts ? accountRows.slice(0, accLimit) : accountRows;
  const accountNextCursor =
    hasMoreAccounts && pageAccounts.length
      ? encodeAccountCursor({
          companyName: pageAccounts[pageAccounts.length - 1].company_name,
          advertiserUsername: pageAccounts[pageAccounts.length - 1].advertiser_username,
        })
      : null;

  if (!pageAccounts.length) {
    const orphansOnly = await loadOrphanInfluencers({ like });
    return {
      accounts: [],
      orphans: orphansOnly,
      hasMoreAccounts: false,
      accountNextCursor: null,
    };
  }

  const advIds = pageAccounts.map((r) => r.advertiser_user_id).filter((id) => id != null);
  if (!advIds.length) {
    const orphansOnly = await loadOrphanInfluencers({ like });
    return {
      accounts: pageAccounts.map((a) => buildEmptyAccount(a)),
      orphans: orphansOnly,
      hasMoreAccounts,
      accountNextCursor,
    };
  }

  const inPlaceholders = advIds.map(() => "?").join(",");

  /** 有 execution 的行 + 会话预览 */
  const execSql = `
    WITH latest AS (
      SELECT
        m.influencer_id,
        COALESCE(m.event_time, m.sent_at, m.created_at) AS last_event_time,
        m.subject AS last_subject,
        m.body_text AS last_body_text,
        m.event_type AS last_event_type,
        ROW_NUMBER() OVER (
          PARTITION BY m.influencer_id
          ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC
        ) AS rn
      FROM tiktok_influencer_conversation_messages m
    )
    SELECT
      s.advertiser_user_id AS advertiser_user_id,
      IFNULL(a.name,'') AS company_name,
      IFNULL(u.username,'') AS advertiser_username,
      c.id AS campaign_id,
      c.status AS campaign_status,
      c.created_at AS campaign_created_at,
      c.product_info AS product_info_raw,
      e.stage AS execution_stage,
      e.influencer_id AS exec_influencer_id,
      e.tiktok_username AS exec_tiktok_username,
      i.influencer_id AS resolved_influencer_id,
      i.display_name,
      i.username,
      i.influencer_email,
      i.handover_mode,
      lm.last_event_time,
      lm.last_subject,
      lm.last_body_text,
      lm.last_event_type
    FROM tiktok_campaign_execution e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
      AND c.status IN ('running','paused','completed')
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
    LEFT JOIN tiktok_advertiser_user u ON u.id = s.advertiser_user_id
    LEFT JOIN tiktok_advertiser a ON a.id = u.advertiser_id
    LEFT JOIN tiktok_influencer i ON (
      (e.influencer_id IS NOT NULL AND TRIM(e.influencer_id) <> '' AND i.influencer_id = e.influencer_id)
      OR ((e.influencer_id IS NULL OR TRIM(e.influencer_id) = '') AND i.username = e.tiktok_username)
    )
    LEFT JOIN latest lm ON lm.rn = 1 AND lm.influencer_id = i.influencer_id
    WHERE s.advertiser_user_id IS NOT NULL
      AND s.advertiser_user_id IN (${inPlaceholders})
    ORDER BY c.created_at ASC, c.id ASC
  `;

  const execRows = await queryTikTok(execSql, advIds);

  /** 无 execution 的 campaign（仍展示空分组） */
  const emptyParams = [...advIds];
  const emptySql = `
    SELECT
      s.advertiser_user_id AS advertiser_user_id,
      IFNULL(a.name,'') AS company_name,
      IFNULL(u.username,'') AS advertiser_username,
      c.id AS campaign_id,
      c.status AS campaign_status,
      c.created_at AS campaign_created_at,
      c.product_info AS product_info_raw
    FROM tiktok_campaign c
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
    LEFT JOIN tiktok_advertiser_user u ON u.id = s.advertiser_user_id
    LEFT JOIN tiktok_advertiser a ON a.id = u.advertiser_id
    WHERE c.status IN ('running','paused','completed')
      AND s.advertiser_user_id IS NOT NULL
      AND s.advertiser_user_id IN (${inPlaceholders})
      AND NOT EXISTS (
        SELECT 1 FROM tiktok_campaign_execution e2 WHERE e2.campaign_id = c.id
      )
      ${searchCampaignSql}
    ORDER BY c.created_at ASC, c.id ASC
  `;
  if (like) {
    emptyParams.push(like, like, like, like, like, like, like, like);
  }
  const emptyRows = await queryTikTok(emptySql, emptyParams);

  const orphans = await loadOrphanInfluencers({ like });

  const accounts = assembleAccounts(pageAccounts, execRows, emptyRows);
  return {
    accounts,
    orphans,
    hasMoreAccounts,
    accountNextCursor,
  };
}

function buildEmptyAccount(row) {
  return {
    advertiserUserId: row.advertiser_user_id,
    companyName: row.company_name || "",
    advertiserUsername: row.advertiser_username || "",
    running: { campaigns: [] },
    paused: { campaigns: [] },
    completed: { campaigns: [] },
  };
}

function assembleAccounts(pageAccounts, execRows, emptyRows) {
  const bucket = (status) => {
    if (status === "running") return "running";
    if (status === "paused") return "paused";
    if (status === "completed") return "completed";
    return null;
  };

  const accountMap = new Map();
  for (const a of pageAccounts) {
    const key = String(a.advertiser_user_id ?? "");
    accountMap.set(key, {
      advertiserUserId: a.advertiser_user_id,
      companyName: a.company_name || "",
      advertiserUsername: a.advertiser_username || "",
      running: { campaigns: [] },
      paused: { campaigns: [] },
      completed: { campaigns: [] },
    });
  }

  const campaignKey = (aid, cid) => `${aid}::${cid}`;
  const campaignMap = new Map();

  function ensureCampaign(row) {
    const aid = String(row.advertiser_user_id ?? "");
    const acc = accountMap.get(aid);
    if (!acc) return null;
    const b = bucket(row.campaign_status);
    if (!b) return null;
    const ck = campaignKey(aid, row.campaign_id);
    let c = campaignMap.get(ck);
    if (!c) {
      const pi = parseProductInfo(row.product_info_raw);
      c = {
        campaignId: row.campaign_id,
        campaignStatus: row.campaign_status,
        campaignCreatedAt: row.campaign_created_at,
        brandProduct: brandProductLabel(pi) || row.campaign_id,
        influencers: [],
      };
      campaignMap.set(ck, c);
      acc[b].campaigns.push(c);
    }
    return c;
  }

  for (const row of emptyRows) {
    ensureCampaign({
      ...row,
      product_info_raw: row.product_info_raw,
    });
  }

  for (const row of execRows) {
    const c = ensureCampaign(row);
    if (!c) continue;
    const infId = row.resolved_influencer_id || row.exec_influencer_id;
    if (!infId) continue;
    c.influencers.push({
      influencerId: String(infId),
      displayName: row.display_name || null,
      username: row.username || null,
      email: row.influencer_email || null,
      handoverMode: row.handover_mode || "assist",
      executionStage: row.execution_stage || "pending_quote",
      lastEventTime: row.last_event_time || null,
      lastPreview: {
        eventType: row.last_event_type || null,
        subject: row.last_subject || null,
        bodyText: row.last_body_text || null,
      },
    });
  }

  /** campaign 组内：先 stage 序，再 last_event_time DESC */
  for (const acc of accountMap.values()) {
    for (const st of ["running", "paused", "completed"]) {
      acc[st].campaigns.sort((a, b) => {
        const ta = new Date(a.campaignCreatedAt || 0).getTime();
        const tb = new Date(b.campaignCreatedAt || 0).getTime();
        return ta - tb;
      });
      for (const camp of acc[st].campaigns) {
        camp.influencers.sort((x, y) => {
          const sx = stageOrderIndex(x.executionStage);
          const sy = stageOrderIndex(y.executionStage);
          if (sx !== sy) return sx - sy;
          const tx = new Date(x.lastEventTime || 0).getTime();
          const ty = new Date(y.lastEventTime || 0).getTime();
          return ty - tx;
        });
      }
    }
  }

  return Array.from(accountMap.values());
}

async function loadOrphanInfluencers({ like }) {
  const searchSql = like
    ? `AND (
        l.influencer_id LIKE ?
        OR IFNULL(i.username, '') LIKE ?
        OR IFNULL(i.display_name, '') LIKE ?
        OR IFNULL(i.influencer_email, '') LIKE ?
      )`
    : "";

  const params = [];
  if (like) {
    params.push(like, like, like, like);
  }

  const sql = `
    WITH latest AS (
      SELECT
        m.influencer_id,
        COALESCE(m.event_time, m.sent_at, m.created_at) AS last_event_time,
        m.subject AS last_subject,
        m.body_text AS last_body_text,
        m.event_type AS last_event_type,
        ROW_NUMBER() OVER (
          PARTITION BY m.influencer_id
          ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC
        ) AS rn
      FROM tiktok_influencer_conversation_messages m
    )
    SELECT
      l.influencer_id,
      l.last_event_time,
      l.last_subject,
      l.last_body_text,
      l.last_event_type,
      i.display_name,
      i.username,
      i.influencer_email,
      i.handover_mode
    FROM latest l
    LEFT JOIN tiktok_influencer i ON i.influencer_id = l.influencer_id
    WHERE l.rn = 1
      AND NOT EXISTS (
        SELECT 1
        FROM tiktok_campaign_execution e
        INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
          AND c.status IN ('running','paused','completed')
        INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
        WHERE e.influencer_id IS NOT NULL
          AND TRIM(e.influencer_id) <> ''
          AND e.influencer_id = l.influencer_id
      )
      ${searchSql}
    ORDER BY l.last_event_time DESC, l.influencer_id DESC
    LIMIT 200
  `;

  const rows = await queryTikTok(sql, params);
  return rows.map((r) => ({
    influencerId: r.influencer_id,
    displayName: r.display_name || null,
    username: r.username || null,
    email: r.influencer_email || null,
    handoverMode: r.handover_mode || "assist",
    lastEventTime: r.last_event_time,
    lastPreview: {
      eventType: r.last_event_type || null,
      subject: r.last_subject || null,
      bodyText: r.last_body_text || null,
    },
  }));
}
