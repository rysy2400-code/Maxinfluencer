import { NextResponse } from "next/server";
import { subscribeWorkLive } from "../../../../../lib/realtime/work-live-bus.js";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../../../lib/auth/session-access.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sessions/[id]/work-live
 * SSE：事件形态与 /api/chat 一致 — { type: 'thinking', data } / { type: 'screenshot', data } / { type: 'ready'|'heartbeat' }。
 */
export async function GET(req, { params }) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const { id: sessionId } = params;

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: "缺少会话 ID" },
        { status: 400 }
      );
    }

    const access = await assertUserCanAccessSession(sessionId, auth);
    if (!access.ok) {
      return NextResponse.json(
        { success: false, error: access.status === 403 ? "无权访问该会话" : "会话不存在" },
        { status: access.status }
      );
    }

    const session = access.session;
    if (!session) {
      return NextResponse.json(
        { success: false, error: "会话不存在" },
        { status: 404 }
      );
    }

    if (session.status !== "published") {
      return NextResponse.json(
        { success: false, error: "仅已发布会话可订阅工作实况" },
        { status: 403 }
      );
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        const send = (obj) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
            );
          } catch {
            closed = true;
          }
        };

        send({ type: "ready", data: { sessionId } });

        const unsub = subscribeWorkLive(sessionId, (payload) => {
          try {
            const ev = JSON.parse(payload);
            send(ev);
          } catch {
            // ignore malformed
          }
        });

        const heartbeat = setInterval(() => {
          send({ type: "heartbeat", data: { t: Date.now() } });
        }, 25000);

        req.signal.addEventListener("abort", () => {
          closed = true;
          clearInterval(heartbeat);
          try {
            unsub();
          } catch {
            // ignore
          }
          try {
            controller.close();
          } catch {
            // ignore
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[work-live SSE]", error);
    return NextResponse.json(
      { success: false, error: error.message || "订阅失败" },
      { status: 500 }
    );
  }
}
