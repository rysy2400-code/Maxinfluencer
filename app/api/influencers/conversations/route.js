import { NextResponse } from "next/server";
import { listInfluencerConversations } from "../../../../lib/db/influencer-conversations-dao.js";

export const dynamic = "force-dynamic";

function decodeConversationsCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
    const obj = JSON.parse(raw);
    if (!obj || !obj.sortTime || obj.influencerId == null) return null;
    return obj;
  } catch {
    return null;
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") || null;
    const cursor = searchParams.get("cursor");
    const limit = searchParams.get("limit");

    if (cursor && !decodeConversationsCursor(cursor)) {
      return NextResponse.json(
        { success: false, error: "cursor 非法" },
        { status: 400 }
      );
    }

    const result = await listInfluencerConversations({
      q,
      cursor,
      limit: limit ? Number(limit) : 40,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("[Influencer Conversations API] 失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取会话列表失败" },
      { status: 500 }
    );
  }
}
