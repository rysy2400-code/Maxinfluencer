import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";

function mapTaskStatusToNoteStatus(taskStatus) {
  if (taskStatus === "failed" || taskStatus === "cancelled") return "failed";
  if (taskStatus === "succeeded") return "finished";
  return "started";
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

    // 注意：部分 MySQL/MariaDB + mysql2 预处理下 `LIMIT ?` 会报 ER_WRONG_ARGUMENTS，
    // 导致接口 500、前端只能依赖 SSE 显示零星几条。此处 limit 已钳制为整数，直接拼接。
    const rows = await queryTikTok(
      `
      SELECT
        t.id AS taskId,
        t.keyword AS keyword,
        COALESCE(t.started_at, t.created_at) AS noteTime,
        t.status AS taskStatus,
        JSON_UNQUOTE(JSON_EXTRACT(t.payload, '$.keywordReason')) AS keywordReason,
        COALESCE(r1.enrich_success_count, r2.enrich_success_count) AS extractedCount,
        COALESCE(r1.analyze_recommended_count, r2.analyze_recommended_count) AS matchedCount
      FROM tiktok_influencer_search_task t
      LEFT JOIN tiktok_keyword_run_result r1
        ON r1.task_id = t.id
      LEFT JOIN tiktok_keyword_run_result r2
        ON r1.id IS NULL
       AND r2.campaign_id = t.campaign_id
       AND r2.run_id = t.run_id
       AND r2.keyword = t.keyword
      WHERE t.campaign_id = ?
      ORDER BY COALESCE(t.started_at, t.created_at) DESC, t.id DESC
      LIMIT ${limit}
    `,
      [campaignId]
    );

    // mysql2 行字段多为小写蛇形（与 AS 大小写无关），勿用 r.taskId 等驼峰否则全为 undefined，
    // 前端会退化为仅按 keyword 去重，同一关键词多轮任务会合并成一条（重登后只剩「最新」）。
    const notes = (rows || [])
      .map((r) => {
        const taskIdRaw = r.taskId ?? r.taskid ?? r.TASK_ID;
        const keywordRaw = r.keyword ?? r.KEYWORD ?? "";
        const noteTimeRaw = r.noteTime ?? r.notetime ?? r.NOTE_TIME;
        const taskStatusRaw = r.taskStatus ?? r.taskstatus ?? r.TASK_STATUS;
        const keywordReasonRaw = r.keywordReason ?? r.keywordreason ?? r.KEYWORD_REASON;
        const extractedRaw = r.extractedCount ?? r.extractedcount ?? r.EXTRACTED_COUNT;
        const matchedRaw = r.matchedCount ?? r.matchedcount ?? r.MATCHED_COUNT;
        return {
          taskId: taskIdRaw != null ? Number(taskIdRaw) : null,
          time: noteTimeRaw ? new Date(noteTimeRaw).toISOString() : null,
          keyword: String(keywordRaw || ""),
          reasonText:
            (typeof keywordReasonRaw === "string" && keywordReasonRaw.trim()) ||
            "该关键词与当前 campaign 的目标受众方向更贴合。",
          extractedCount:
            extractedRaw == null ? null : Number(extractedRaw || 0),
          matchedCount:
            matchedRaw == null ? null : Number(matchedRaw || 0),
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
