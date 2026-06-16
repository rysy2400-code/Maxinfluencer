import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";
import {
  platformFromPayloadSlug,
  workNoteInfluencerLibraryLabel,
} from "../../../../../lib/influencer/resolve-campaign-platforms.js";

function mapTaskStatusToNoteStatus(taskStatus) {
  if (taskStatus === "failed" || taskStatus === "cancelled") return "failed";
  if (taskStatus === "succeeded") return "finished";
  return "started";
}

function numOrNull(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /api/campaigns/[id]/work-notes?limit=50
 * 返回执行阶段关键词任务的简版工作笔记历史（用于进入页面后的历史回放）。
 */
export async function GET(req, { params }) {
  try {
    const campaignId = params?.id;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const limitRaw = Number(searchParams.get("limit") || 50);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

    const rows = await queryTikTok(
      `
      SELECT
        t.id AS taskId,
        t.keyword AS keyword,
        COALESCE(t.started_at, t.created_at) AS noteTime,
        t.status AS taskStatus,
        JSON_UNQUOTE(JSON_EXTRACT(t.payload, '$.keywordReason')) AS keywordReason,
        COALESCE(
          NULLIF(t.platform, ''),
          JSON_UNQUOTE(JSON_EXTRACT(t.payload, '$.platform'))
        ) AS taskPlatform,
        t.progress_search_found_count AS searchFoundCount,
        t.progress_profile_browsed_count AS profileBrowsedCount,
        t.progress_analyzed_count AS analyzedCount,
        t.progress_recommended_count AS recommendedCount,
        t.progress_contactable_count AS contactableCount,
        t.progress_skip_country_unknown_count AS skipCountryUnknownCount,
        t.progress_skip_country_mismatch_count AS skipCountryMismatchCount
      FROM tiktok_influencer_search_task t
      WHERE t.campaign_id = ?
      ORDER BY COALESCE(t.started_at, t.created_at) DESC, t.id DESC
      LIMIT ${limit}
    `,
      [campaignId]
    );

    const notes = (rows || [])
      .map((r) => {
        const taskIdRaw = r.taskId ?? r.taskid ?? r.TASK_ID;
        const keywordRaw = r.keyword ?? r.KEYWORD ?? "";
        const noteTimeRaw = r.noteTime ?? r.notetime ?? r.NOTE_TIME;
        const taskStatusRaw = r.taskStatus ?? r.taskstatus ?? r.TASK_STATUS;
        const keywordReasonRaw = r.keywordReason ?? r.keywordreason ?? r.KEYWORD_REASON;
        const taskPlatformRaw = r.taskPlatform ?? r.taskplatform ?? r.TASK_PLATFORM;
        const platformSlug =
          typeof taskPlatformRaw === "string" && taskPlatformRaw.trim()
            ? taskPlatformRaw.trim().toLowerCase()
            : null;
        return {
          taskId: taskIdRaw != null ? Number(taskIdRaw) : null,
          time: noteTimeRaw ? new Date(noteTimeRaw).toISOString() : null,
          keyword: String(keywordRaw || ""),
          platform: platformSlug,
          platformLabel: platformSlug ? platformFromPayloadSlug(platformSlug) : null,
          libraryLabel: workNoteInfluencerLibraryLabel(platformSlug),
          reasonText:
            (typeof keywordReasonRaw === "string" && keywordReasonRaw.trim()) ||
            "该关键词与当前 campaign 的目标受众方向更贴合。",
          searchFoundCount: numOrNull(
            r.searchFoundCount ?? r.searchfoundcount ?? r.SEARCH_FOUND_COUNT
          ),
          profileBrowsedCount: numOrNull(
            r.profileBrowsedCount ?? r.profilebrowsedcount ?? r.PROFILE_BROWSED_COUNT
          ),
          analyzedCount: numOrNull(
            r.analyzedCount ?? r.analyzedcount ?? r.ANALYZED_COUNT
          ),
          recommendedCount: numOrNull(
            r.recommendedCount ?? r.recommendedcount ?? r.RECOMMENDED_COUNT
          ),
          contactableCount: numOrNull(
            r.contactableCount ?? r.contactablecount ?? r.CONTACTABLE_COUNT
          ),
          skipCountryUnknownCount: numOrNull(
            r.skipCountryUnknownCount ??
              r.skipcountryunknowncount ??
              r.SKIP_COUNTRY_UNKNOWN_COUNT
          ),
          skipCountryMismatchCount: numOrNull(
            r.skipCountryMismatchCount ??
              r.skipcountrymismatchcount ??
              r.SKIP_COUNTRY_MISMATCH_COUNT
          ),
          status: mapTaskStatusToNoteStatus(taskStatusRaw),
        };
      })
      .filter((x) => x.keyword);

    return NextResponse.json({
      success: true,
      campaignId,
      notes,
    });
  } catch (error) {
    console.error("[Campaign WorkNotes API] 获取工作笔记失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取工作笔记失败" },
      { status: 500 }
    );
  }
}
