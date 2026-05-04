import { NextResponse } from "next/server";
import { listActiveCampaignCards } from "../../../../../lib/db/influencer-timeline-dao.js";

function parseLimit(raw, fallback = 50, max = 200) {
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
    const limit = parseLimit(searchParams.get("limit"), 50, 200);
    const items = await listActiveCampaignCards({ influencerId, limit });
    return NextResponse.json({
      success: true,
      items,
      count: items.length,
    });
  } catch (error) {
    console.error("[Influencer Active Campaigns API] 获取失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取 active campaigns 失败" },
      { status: 500 }
    );
  }
}

