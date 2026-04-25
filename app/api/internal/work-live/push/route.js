import { NextResponse } from "next/server";
import { publishWorkLiveEvent } from "../../../../../lib/realtime/work-live-bus.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/internal/work-live/push
 * Worker 在无 REDIS_URL 时调用；需请求头 x-work-live-secret 与 WORK_LIVE_PUSH_SECRET 一致。
 * Body: { sessionId: string, event: { type, data? } }
 */
export async function POST(req) {
  try {
    const secret = req.headers.get("x-work-live-secret");
    const expected = process.env.WORK_LIVE_PUSH_SECRET;
    if (!expected || secret !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { sessionId, event } = body || {};

    if (!sessionId || !event || typeof event !== "object") {
      return NextResponse.json(
        { ok: false, error: "sessionId 与 event 必填" },
        { status: 400 }
      );
    }

    publishWorkLiveEvent(sessionId, event);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[work-live push]", error);
    return NextResponse.json(
      { ok: false, error: error.message || "push 失败" },
      { status: 500 }
    );
  }
}
