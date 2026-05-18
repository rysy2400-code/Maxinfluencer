import { NextResponse } from "next/server";
import {
  buildExecutionStageXlsx,
  EXECUTION_EXPORT_STAGES,
} from "../../../../../lib/execution/export-execution-xlsx.js";

/**
 * GET /api/campaigns/[id]/execution-export?stage=contacted
 * stage: contacted | pendingPrice | pendingSample | pendingDraft | published
 */
export async function GET(req, { params }) {
  try {
    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const stage = searchParams.get("stage") || "";
    if (!EXECUTION_EXPORT_STAGES[stage]) {
      return NextResponse.json(
        {
          success: false,
          error: `无效的 stage，可选: ${Object.keys(EXECUTION_EXPORT_STAGES).join(", ")}`,
        },
        { status: 400 }
      );
    }

    const { buffer, filename } = await buildExecutionStageXlsx(campaignId, stage);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 404 }
      );
    }
    if (error.code === "INVALID_STAGE" || error.code === "STAGE_DISABLED") {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    console.error("[Campaign Execution Export] 导出失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "导出失败" },
      { status: 500 }
    );
  }
}
