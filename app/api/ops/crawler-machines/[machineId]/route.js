import { NextResponse } from "next/server";
import { requireCrawlerOpsSuperAdmin } from "../../../../../lib/auth/require-crawler-ops-super-admin.js";
import { getCrawlerFleetSnapshot } from "../../../../../lib/db/crawler-fleet-ops-dao.js";
import { listCrawlerActions } from "../../../../../lib/db/crawler-ops-action-dao.js";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";

export const dynamic = "force-dynamic";

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function GET(req, { params }) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(req);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    const machineId = Number(params.machineId);
    const platform = new URL(req.url).searchParams.get("platform") || null;
    const snapshot = await getCrawlerFleetSnapshot();
    const machine = snapshot.machines.find(
      (item) => Number(item.id) === machineId && (!platform || item.platform === platform)
    );
    if (!machine) {
      return NextResponse.json({ success: false, error: "机器不存在" }, { status: 404 });
    }
    const [tasks, errorGroups, actions] = await Promise.all([
      queryTikTok(
        `SELECT id, campaign_id, keyword, status, error_message,
                progress_search_found_count, progress_profile_browsed_count,
                progress_analyzed_count, started_at, finished_at
         FROM tiktok_influencer_search_task
         WHERE worker_ip=? AND platform=?
         ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT 30`,
        [machine.ip, machine.platform]
      ),
      queryTikTok(
        `SELECT LEFT(SUBSTRING_INDEX(error_message, CHAR(10), 1), 180) AS reason,
                COUNT(*) AS count, MAX(finished_at) AS last_at
         FROM tiktok_influencer_search_task
         WHERE worker_ip=? AND platform=? AND status='failed'
           AND finished_at>=DATE_SUB(NOW(),INTERVAL 1 HOUR)
         GROUP BY reason ORDER BY count DESC LIMIT 10`,
        [machine.ip, machine.platform]
      ),
      listCrawlerActions(machineId, 30),
    ]);
    return NextResponse.json({
      success: true,
      machine,
      recentTasks: (tasks || []).map((task) => ({
        id: Number(task.id),
        campaignId: task.campaign_id || null,
        keyword: task.keyword || null,
        status: task.status,
        errorMessage: task.error_message || null,
        searchFoundCount: Number(task.progress_search_found_count || 0),
        profileBrowsedCount: Number(task.progress_profile_browsed_count || 0),
        analyzedCount: Number(task.progress_analyzed_count || 0),
        startedAt: toIso(task.started_at),
        finishedAt: toIso(task.finished_at),
      })),
      errorGroups: (errorGroups || []).map((row) => ({
        reason: row.reason || "未知错误",
        count: Number(row.count || 0),
        lastAt: toIso(row.last_at),
      })),
      actions,
    });
  } catch (error) {
    console.error("[ops/crawler-machine-detail]", error);
    return NextResponse.json(
      { success: false, error: error.message || "查询失败" },
      { status: 500 }
    );
  }
}
