/**
 * 将 duplicate campaign 的业务数据合并到 canonical campaign，并软删旧行。
 */
import tiktokPool, { queryTikTok } from "./mysql-tiktok.js";

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

function ts(v) {
  if (v == null) return 0;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * @param {string} canonicalId
 * @param {string} oldId
 * @param {{ dryRun?: boolean }} [options]
 */
export async function mergeCampaignInto(canonicalId, oldId, options = {}) {
  const dryRun = Boolean(options.dryRun);
  if (!canonicalId || !oldId || canonicalId === oldId) {
    throw new Error("canonicalId 与 oldId 必填且不能相同");
  }

  const stats = {
    canonicalId,
    oldId,
    dryRun,
    candidates: { moved: 0, merged: 0, deleted: 0 },
    execution: { moved: 0, merged: 0, deleted: 0 },
    searchTasks: { moved: 0, cancelled: 0, deleted: 0 },
    keywordRuns: { moved: 0, deleted: 0 },
    reportConfig: { dropped: 0 },
    specialRequests: { moved: 0 },
    emailEvents: { moved: 0 },
    conversationMessages: { moved: 0 },
    oldCampaignSoftDeleted: false,
  };

  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();

    const [campRows] = await conn.execute(
      `SELECT id, session_id, status FROM tiktok_campaign WHERE id IN (?, ?)`,
      [canonicalId, oldId]
    );
    if (!campRows?.length || campRows.length < 2) {
      throw new Error("canonical 或 old campaign 不存在");
    }
    const canonicalRow = campRows.find((r) => r.id === canonicalId);
    const oldRow = campRows.find((r) => r.id === oldId);
    if (!canonicalRow || !oldRow) {
      throw new Error("campaign 行未找到");
    }
    if (canonicalRow.session_id !== oldRow.session_id) {
      throw new Error(
        `session_id 不一致: canonical=${canonicalRow.session_id} old=${oldRow.session_id}`
      );
    }

    // —— candidates ——
    const [oldCands] = await conn.execute(
      `SELECT * FROM tiktok_campaign_influencer_candidates WHERE campaign_id = ?`,
      [oldId]
    );
    for (const row of oldCands || []) {
      const [exist] = await conn.execute(
        `SELECT id, analyzed_at, match_score FROM tiktok_campaign_influencer_candidates
         WHERE campaign_id = ? AND tiktok_username = ? LIMIT 1`,
        [canonicalId, row.tiktok_username]
      );
      if (!exist?.length) {
        if (!dryRun) {
          await conn.execute(
            `UPDATE tiktok_campaign_influencer_candidates SET campaign_id = ? WHERE id = ?`,
            [canonicalId, row.id]
          );
        }
        stats.candidates.moved += 1;
      } else {
        const keepCanonical =
          ts(exist[0].analyzed_at) >= ts(row.analyzed_at) &&
          Number(exist[0].match_score || 0) >= Number(row.match_score || 0);
        if (!dryRun) {
          if (!keepCanonical) {
            await conn.execute(
              `UPDATE tiktok_campaign_influencer_candidates SET
                 campaign_id = ?, influencer_id = ?, influencer_snapshot = ?,
                 match_score = ?, should_contact = ?, analysis_summary = ?,
                 match_analysis = ?, email = ?, has_email = ?, analyzed_at = ?, updated_at = NOW()
               WHERE id = ?`,
              [
                canonicalId,
                row.influencer_id,
                row.influencer_snapshot,
                row.match_score,
                row.should_contact,
                row.analysis_summary,
                row.match_analysis,
                row.email,
                row.has_email,
                row.analyzed_at,
                exist[0].id,
              ]
            );
          }
          await conn.execute(
            `DELETE FROM tiktok_campaign_influencer_candidates WHERE id = ?`,
            [row.id]
          );
        }
        stats.candidates.merged += 1;
        stats.candidates.deleted += 1;
      }
    }

    // —— execution ——
    const [oldExec] = await conn.execute(
      `SELECT * FROM tiktok_campaign_execution WHERE campaign_id = ?`,
      [oldId]
    );
    for (const row of oldExec || []) {
      const [exist] = await conn.execute(
        `SELECT id, created_at FROM tiktok_campaign_execution
         WHERE campaign_id = ? AND tiktok_username = ? LIMIT 1`,
        [canonicalId, row.tiktok_username]
      );
      if (!exist?.length) {
        if (!dryRun) {
          await conn.execute(
            `UPDATE tiktok_campaign_execution SET campaign_id = ? WHERE id = ?`,
            [canonicalId, row.id]
          );
        }
        stats.execution.moved += 1;
      } else {
        if (!dryRun) {
          await conn.execute(`DELETE FROM tiktok_campaign_execution WHERE id = ?`, [row.id]);
        }
        stats.execution.deleted += 1;
      }
    }

    // —— search tasks: cancel pending/processing on old, then move ——
    if (!dryRun) {
      await conn.execute(
        `UPDATE tiktok_influencer_search_task
         SET status = 'cancelled',
             error_message = CONCAT(COALESCE(error_message,''), ' [merged into ', ?, ']'),
             updated_at = NOW()
         WHERE campaign_id = ? AND status IN ('pending','processing')`,
        [canonicalId, oldId]
      );
    }
    const [cancelled] = await conn.execute(
      `SELECT COUNT(*) AS n FROM tiktok_influencer_search_task
       WHERE campaign_id = ? AND status = 'cancelled' AND error_message LIKE ?`,
      [oldId, `%merged into ${canonicalId}%`]
    );
    stats.searchTasks.cancelled = Number(cancelled?.[0]?.n || 0);

    const [oldTasks] = await conn.execute(
      `SELECT id, run_id, keyword FROM tiktok_influencer_search_task WHERE campaign_id = ?`,
      [oldId]
    );
    for (const task of oldTasks || []) {
      const [conflict] = await conn.execute(
        `SELECT id FROM tiktok_influencer_search_task
         WHERE campaign_id = ? AND run_id = ? AND keyword = ? LIMIT 1`,
        [canonicalId, task.run_id, task.keyword]
      );
      if (!conflict?.length) {
        if (!dryRun) {
          await conn.execute(
            `UPDATE tiktok_influencer_search_task SET campaign_id = ? WHERE id = ?`,
            [canonicalId, task.id]
          );
        }
        stats.searchTasks.moved += 1;
      } else {
        if (!dryRun) {
          await conn.execute(`DELETE FROM tiktok_influencer_search_task WHERE id = ?`, [task.id]);
        }
        stats.searchTasks.deleted += 1;
      }
    }

    // —— keyword run results ——
    const [oldRuns] = await conn.execute(
      `SELECT id, run_id, keyword FROM tiktok_keyword_run_result WHERE campaign_id = ?`,
      [oldId]
    );
    for (const run of oldRuns || []) {
      const [conflict] = await conn.execute(
        `SELECT id FROM tiktok_keyword_run_result
         WHERE campaign_id = ? AND run_id = ? AND keyword = ? LIMIT 1`,
        [canonicalId, run.run_id, run.keyword]
      );
      if (!conflict?.length) {
        if (!dryRun) {
          await conn.execute(
            `UPDATE tiktok_keyword_run_result SET campaign_id = ? WHERE id = ?`,
            [canonicalId, run.id]
          );
        }
        stats.keywordRuns.moved += 1;
      } else {
        if (!dryRun) {
          await conn.execute(`DELETE FROM tiktok_keyword_run_result WHERE id = ?`, [run.id]);
        }
        stats.keywordRuns.deleted += 1;
      }
    }

    // —— report config: canonical 优先，删 old ——
    const [oldCfg] = await conn.execute(
      `SELECT campaign_id FROM tiktok_campaign_report_config WHERE campaign_id = ?`,
      [oldId]
    );
    if (oldCfg?.length) {
      if (!dryRun) {
        await conn.execute(
          `DELETE FROM tiktok_campaign_report_config WHERE campaign_id = ?`,
          [oldId]
        );
      }
      stats.reportConfig.dropped = 1;
    }

    // —— optional tables (may not exist) ——
    const optionalCounts = [
      { key: "specialRequests", table: "influencer_special_requests" },
      { key: "emailEvents", table: "tiktok_influencer_email_events" },
      { key: "conversationMessages", table: "tiktok_influencer_conversation_messages" },
    ];
    for (const { key, table } of optionalCounts) {
      try {
        const [cntRows] = await conn.execute(
          `SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`,
          [oldId]
        );
        const n = Number(cntRows?.[0]?.n || 0);
        if (!dryRun && n > 0) {
          await conn.execute(
            `UPDATE ${table} SET campaign_id = ? WHERE campaign_id = ?`,
            [canonicalId, oldId]
          );
        }
        stats[key] = { moved: n };
      } catch (e) {
        if (e.code === "ER_NO_SUCH_TABLE" || e.code === "ER_BAD_FIELD_ERROR") {
          stats[key] = { skipped: true };
        } else {
          throw e;
        }
      }
    }

    // —— soft-delete old campaign ——
    if (!dryRun) {
      await conn.execute(
        `UPDATE tiktok_campaign
         SET status = 'deleted',
             deleted_at = NOW(),
             deleted_by = 'system',
             delete_reason = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [`merged_into:${canonicalId}`, oldId]
      );
    }
    stats.oldCampaignSoftDeleted = !dryRun;

    if (dryRun) {
      await conn.rollback();
    } else {
      await conn.commit();
    }
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return stats;
}

/**
 * 按 session 解析 canonical（context.campaignId 或最新非 deleted）与待合并的 old 列表。
 */
export async function findDuplicateCampaignsForSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;

  const sessionRows = await queryTikTok(
    `SELECT id, context FROM tiktok_campaign_sessions WHERE id = ? LIMIT 1`,
    [sid]
  );
  const ctx = parseJson(sessionRows?.[0]?.context) || {};
  const contextCampaignId = ctx.campaignId ? String(ctx.campaignId).trim() : null;

  const campRows = await queryTikTok(
    `SELECT id, created_at, status FROM tiktok_campaign
     WHERE session_id = ? AND status <> 'deleted'
     ORDER BY created_at DESC`,
    [sid]
  );
  if (!campRows?.length) return null;

  let canonicalId = contextCampaignId;
  if (canonicalId && !campRows.some((r) => r.id === canonicalId)) {
    canonicalId = campRows[0].id;
  }
  if (!canonicalId) canonicalId = campRows[0].id;

  const oldIds = campRows.map((r) => r.id).filter((id) => id !== canonicalId);
  return { sessionId: sid, canonicalId, oldIds, campaigns: campRows };
}

export async function listSessionsWithDuplicateCampaigns() {
  const rows = await queryTikTok(
    `
    SELECT session_id, COUNT(*) AS n, GROUP_CONCAT(id ORDER BY created_at DESC) AS ids
    FROM tiktok_campaign
    WHERE status <> 'deleted'
    GROUP BY session_id
    HAVING COUNT(*) > 1
    `
  );
  return (rows || []).map((r) => ({
    sessionId: r.session_id,
    count: Number(r.n || 0),
    campaignIds: String(r.ids || "").split(",").filter(Boolean),
  }));
}
