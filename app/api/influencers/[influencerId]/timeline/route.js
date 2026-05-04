import { NextResponse } from "next/server";
import { decodeCursor } from "../../../../../lib/utils/cursor.js";
import { listTimelineEvents } from "../../../../../lib/db/influencer-timeline-dao.js";

function parseLimit(raw, fallback = 30, max = 100) {
  const n = Number(raw || fallback);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export async function GET(req, { params }) {
  try {
    const influencerId = params?.influencerId;
    if (!influencerId) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const cursor = searchParams.get("cursor");
    const limit = parseLimit(searchParams.get("limit"), 30, 100);
    const campaignId = searchParams.get("campaignId") || null;
    const eventTypes = searchParams.get("eventTypes") || null;
    const debug = searchParams.get("debug") === "1";

    if (cursor && !decodeCursor(cursor)) {
      return NextResponse.json(
        { success: false, error: "cursor 非法" },
        { status: 400 }
      );
    }

    const result = await listTimelineEvents({
      influencerId,
      cursor,
      limit,
      campaignId,
      eventTypes,
      debug,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("[Influencer Timeline API] 获取时间线失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取时间线失败" },
      { status: 500 }
    );
  }
}

