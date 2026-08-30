import { queryTikTok } from "./mysql-tiktok.js";
import { campaignStatusSidebarBucket } from "../campaign/campaign-status.js";

const SESSION_TABLE = "tiktok_campaign_sessions";

/** execution.stage 组内排序（小在前） */
export const EXECUTION_STAGE_ORDER = [
  "pending_quote",
  "quote_submitted",
  "quote_rejected",
  "pending_sample",
  "pending_script",
  "script_review",
  "video_review",
  "pending_video",
  "published",
];

function stageOrderIndex(stage) {
  const s = String(stage || "");
  const i = EXECUTION_STAGE_ORDER.indexOf(s);
  return i === -1 ? 999 : i;
}

function handoverOrderIndex(mode) {
  return mode === "assist" ? 0 : 1;
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

function mapInfluencerRow(r) {
  return {
    influencerId: String(r.resolved_influencer_id || r.exec_influencer_id),
    displayName: r.display_name || null,
    username: r.username || null,
    email: r.influencer_email || null,
    handoverMode: r.handover_mode || "auto",
    executionStage: r.execution_stage || "pending_quote",
    lastEventTime: r.last_event_time || null,
    lastPreview: {
      eventType: r.last_event_type || null,
      subject: r.last_subject || null,
      bodyText: r.last_body_text || null,
    },
  };
}

/** campaign 组内：先半托管/全托管，再 stage 序，再 last_event_time DESC */
function sortInfluencers(arr) {
  arr.sort((x, y) => {
    const hx = handoverOrderIndex(x.handoverMode);
    const hy = handoverOrderIndex(y.handoverMode);
    if (hx !== hy) return hx - hy;
    const sx = stageOrderIndex(x.executionStage);
    const sy = stageOrderIndex(y.executionStage);
    if (sx !== sy) return sx - sy;
    const tx = new Date(x.lastEventTime || 0).getTime();
    const ty = new Date(y.lastEventTime || 0).getTime();
    return ty - tx;
  });
  return arr;
}

/**
 * 按项目视图骨架：公司·账户 → running/paused/completed → campaign（含红人数）。
 * campaign 内的红人列表按需通过 listCampaignInfluencers 懒加载。
 * - 仅 published session；campaign.status in running,paused,completed；排除 deleted
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
          WHERE e0.campaign_id = c.id
            AND (
              IFNULL(e0.influencer_id,'') LIKE ?
              OR EXISTS (
                SELECT 1 FROM tiktok_influencer i0
                WHERE i0.influencer_id = e0.influencer_id
                  AND (IFNULL(i0.username,'') LIKE ? OR IFNULL(i0.display_name,'') LIKE ? OR IFNULL(i0.influencer_email,'') LIKE ?)
              )
              OR EXISTS (
                SELECT 1 FROM tiktok_influencer i0
                WHERE i0.username = e0.tiktok_username
                  AND (IFNULL(i0.username,'') LIKE ? OR IFNULL(i0.display_name,'') LIKE ? OR IFNULL(i0.influencer_email,'') LIKE ?)
              )
            )
        )
      )`
    : "";

  const paramsAccounts = [];
  if (decoded) {
    paramsAccounts.push(decoded.companyName, decoded.companyName, decoded.advertiserUsername);
  }
  if (like) {
    paramsAccounts.push(like, like, like, like, like, like, like, like, like, like, like);
  }

  const accountSql = `
    SELECT /*+ MAX_EXECUTION_TIME(30000) */ DISTINCT
      s.advertiser_user_id AS advertiser_user_id,
      IFNULL(a.name,'') AS company_name,
      IFNULL(u.username,'') AS advertiser_username
    FROM tiktok_campaign c
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
    LEFT JOIN tiktok_advertiser_user u ON u.id = s.advertiser_user_id
    LEFT JOIN tiktok_advertiser a ON a.id = u.advertiser_id
    WHERE c.status IN ('running','running_passive','paused','completed')
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

  /** campaign 骨架（含无 execution 的空 campaign）+ 每个 campaign 的红人数 */
  const campaignSql = `
    SELECT /*+ MAX_EXECUTION_TIME(30000) */
      s.advertiser_user_id AS advertiser_user_id,
      c.id AS campaign_id,
      c.status AS campaign_status,
      c.created_at AS campaign_created_at,
      JSON_UNQUOTE(JSON_EXTRACT(c.product_info, '$.brandName')) AS brand_name,
      JSON_UNQUOTE(JSON_EXTRACT(c.product_info, '$.productName')) AS product_name,
      COUNT(e.id) AS influencer_count
    FROM tiktok_campaign c
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
    LEFT JOIN tiktok_campaign_execution e ON e.campaign_id = c.id
    WHERE c.status IN ('running','running_passive','paused','completed')
      AND s.advertiser_user_id IS NOT NULL
      AND s.advertiser_user_id IN (${inPlaceholders})
    GROUP BY c.id, s.advertiser_user_id, c.status, c.created_at, c.product_info
    ORDER BY c.created_at ASC, c.id ASC
  `;

  const [campaignRows, orphans] = await Promise.all([
    queryTikTok(campaignSql, advIds),
    loadOrphanInfluencers({ like }).catch((error) => {
      // 孤儿列表只是补充视图；失败时降级为空，避免阻塞整个收件箱接口
      console.error("[Influencer Inbox By Project] 孤儿列表查询失败，降级为空:", error?.message);
      return [];
    }),
  ]);

  const accounts = assembleAccounts(pageAccounts, campaignRows);
  return {
    accounts,
    orphans,
    hasMoreAccounts,
    accountNextCursor,
  };
}

/**
 * 懒加载：单个 campaign 内的红人列表（含最新消息预览）。
 * q 非空时只返回匹配红人。
 */
export async function listCampaignInfluencers({ advertiserUserId, campaignId, q = null }) {
  const like = searchPattern(q);
  const params = [campaignId, advertiserUserId, campaignId];
  const searchSql = like
    ? `AND (
        IFNULL(e.influencer_id,'') LIKE ?
        OR IFNULL(i.username,'') LIKE ?
        OR IFNULL(i.display_name,'') LIKE ?
        OR IFNULL(i.influencer_email,'') LIKE ?
      )`
    : "";
  if (like) {
    params.push(like, like, like, like);
  }

  const sql = `
    WITH campaign_influencers AS (
      SELECT DISTINCT
        COALESCE(
          ri.influencer_id,
          ru.influencer_id,
          NULLIF(TRIM(e.influencer_id), '')
        ) AS influencer_id
      FROM tiktok_campaign_execution e
      LEFT JOIN tiktok_influencer ri ON ri.influencer_id = e.influencer_id
        AND e.influencer_id IS NOT NULL AND TRIM(e.influencer_id) <> ''
      LEFT JOIN tiktok_influencer ru ON ru.username = e.tiktok_username
        AND ri.influencer_id IS NULL
      WHERE e.campaign_id = ?
        AND COALESCE(ri.influencer_id, ru.influencer_id, NULLIF(TRIM(e.influencer_id), '')) IS NOT NULL
    ),
    latest AS (
      SELECT
        x.influencer_id,
        x.event_time AS last_event_time,
        x.id AS last_message_id
      FROM (
        SELECT
          m.influencer_id,
          m.event_time,
          m.id,
          ROW_NUMBER() OVER (
            PARTITION BY m.influencer_id
            ORDER BY m.event_time DESC, m.id DESC
          ) AS rn
        FROM tiktok_influencer_conversation_messages m
        WHERE m.influencer_id IN (SELECT influencer_id FROM campaign_influencers)
      ) x
      WHERE x.rn = 1
    )
    SELECT /*+ MAX_EXECUTION_TIME(30000) */
      e.stage AS execution_stage,
      e.influencer_id AS exec_influencer_id,
      COALESCE(i.influencer_id, iu.influencer_id) AS resolved_influencer_id,
      COALESCE(i.display_name, iu.display_name) AS display_name,
      COALESCE(i.username, iu.username) AS username,
      COALESCE(i.influencer_email, iu.influencer_email) AS influencer_email,
      COALESCE(i.handover_mode, iu.handover_mode) AS handover_mode,
      lm.last_event_time,
      msg.subject AS last_subject,
      LEFT(msg.body_text, 120) AS last_body_text,
      msg.event_type AS last_event_type
    FROM tiktok_campaign_execution e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
      AND c.status IN ('running','running_passive','paused','completed')
    INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
      AND s.advertiser_user_id = ?
    LEFT JOIN tiktok_influencer i ON i.influencer_id = e.influencer_id
      AND e.influencer_id IS NOT NULL AND TRIM(e.influencer_id) <> ''
    LEFT JOIN tiktok_influencer iu ON iu.username = e.tiktok_username
      AND i.influencer_id IS NULL
    LEFT JOIN latest lm ON lm.influencer_id = COALESCE(i.influencer_id, iu.influencer_id, NULLIF(TRIM(e.influencer_id), ''))
    LEFT JOIN tiktok_influencer_conversation_messages msg ON msg.id = lm.last_message_id
    WHERE e.campaign_id = ?
      ${searchSql}
  `;

  const rows = await queryTikTok(sql, params);
  const items = rows
    .map(mapInfluencerRow)
    .filter((x) => x.influencerId);
  sortInfluencers(items);
  return { influencers: items };
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

function assembleAccounts(pageAccounts, campaignRows) {
  const bucket = (status) => campaignStatusSidebarBucket(status);

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

  for (const row of campaignRows) {
    const aid = String(row.advertiser_user_id ?? "");
    const acc = accountMap.get(aid);
    if (!acc) continue;
    const b = bucket(row.campaign_status);
    if (!b) continue;
    const ck = campaignKey(aid, row.campaign_id);
    let c = campaignMap.get(ck);
    if (!c) {
      c = {
        campaignId: row.campaign_id,
        campaignStatus: row.campaign_status,
        campaignCreatedAt: row.campaign_created_at,
        brandProduct:
          brandProductLabel({
            brandName: row.brand_name || null,
            productName: row.product_name || null,
          }) || row.campaign_id,
        influencerCount: Number(row.influencer_count || 0),
      };
      campaignMap.set(ck, c);
      acc[b].campaigns.push(c);
    }
  }

  /** campaign 按创建时间排序 */
  for (const acc of accountMap.values()) {
    for (const st of ["running", "paused", "completed"]) {
      acc[st].campaigns.sort((a, b) => {
        const ta = new Date(a.campaignCreatedAt || 0).getTime();
        const tb = new Date(b.campaignCreatedAt || 0).getTime();
        return ta - tb;
      });
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
        x.influencer_id,
        x.event_time AS last_event_time,
        x.id AS last_message_id
      FROM (
        SELECT
          m.influencer_id,
          m.event_time,
          m.id,
          ROW_NUMBER() OVER (
            PARTITION BY m.influencer_id
            ORDER BY m.event_time DESC, m.id DESC
          ) AS rn
        FROM tiktok_influencer_conversation_messages m
        WHERE m.influencer_id > ''
      ) x
      WHERE x.rn = 1
    )
    SELECT /*+ MAX_EXECUTION_TIME(30000) */
      l.influencer_id,
      l.last_event_time,
      msg.subject AS last_subject,
      LEFT(msg.body_text, 120) AS last_body_text,
      msg.event_type AS last_event_type,
      i.display_name,
      i.username,
      i.influencer_email,
      i.handover_mode
    FROM latest l
    JOIN tiktok_influencer_conversation_messages msg ON msg.id = l.last_message_id
    LEFT JOIN tiktok_influencer i ON i.influencer_id = l.influencer_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM tiktok_campaign_execution e
        INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
          AND c.status IN ('running','running_passive','paused','completed')
        INNER JOIN ${SESSION_TABLE} s ON s.id = c.session_id AND s.status = 'published'
        WHERE e.influencer_id IS NOT NULL
          AND TRIM(e.influencer_id) <> ''
          AND e.influencer_id = l.influencer_id
      )
      ${searchSql}
    ORDER BY CASE WHEN i.handover_mode = 'assist' THEN 0 ELSE 1 END ASC,
             l.last_event_time DESC,
             l.influencer_id DESC
    LIMIT 200
  `;

  const rows = await queryTikTok(sql, params);
  return rows.map((r) => ({
    influencerId: r.influencer_id,
    displayName: r.display_name || null,
    username: r.username || null,
    email: r.influencer_email || null,
    handoverMode: r.handover_mode || "auto",
    lastEventTime: r.last_event_time,
    lastPreview: {
      eventType: r.last_event_type || null,
      subject: r.last_subject || null,
      bodyText: r.last_body_text || null,
    },
  }));
}
