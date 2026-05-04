import { NextResponse } from "next/server";
import { AgentRouter } from "../../../lib/utils/agent-router.js";
import { getAuthenticatedAdvertiserUser } from "../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../lib/auth/session-access.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }

    const body = await req.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const rawContext = body.context || {};
    // 会话 ID 单独传参，避免写进 DB 的 context JSON；发布成功后会话需据此标记 published
    const sessionId = body.sessionId || rawContext.sessionId || null;
    if (sessionId) {
      const access = await assertUserCanAccessSession(sessionId, auth);
      if (!access.ok) {
        return NextResponse.json(
          { error: access.status === 403 ? "无权访问该会话" : "会话不存在" },
          { status: access.status }
        );
      }
    }
    const context = sessionId ? { ...rawContext, sessionId } : { ...rawContext };
    const stream = body.stream !== false; // 默认启用流式传输

    if (!messages.length) {
      return NextResponse.json(
        { error: "缺少消息内容" },
        {
          status: 400
        }
      );
    }

    // 如果启用流式传输，使用 SSE
    if (stream) {
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          let isClosed = false;
          
          const send = (data) => {
            // 检查流是否已关闭
            if (isClosed) {
              return; // 静默忽略，不抛出错误
            }
            
            try {
              const chunk = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
              controller.enqueue(chunk);
            } catch (error) {
              // 如果流已关闭，标记并忽略错误
              if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
                isClosed = true;
                console.warn('[Chat API] SSE 流已关闭，停止发送更新');
              } else {
                // 其他错误仍然记录
                console.error('[Chat API] 发送 SSE 数据失败:', error);
              }
            }
          };

          try {
            // 使用 Agent Router 处理消息，传入回调函数实时发送更新
            const router = new AgentRouter();
            const result = await router.process(messages, context, (payload) => {
              // 截图单独事件发送，避免大 base64 混在 thinking 里导致前端解析失败
              if (payload && payload.type === "screenshot") {
                send({ type: "screenshot", data: payload.data });
                return;
              }
              send({ type: "thinking", data: payload });
            });

            // 发送最终结果
            send({
              type: "complete",
              data: {
                reply: result.reply,
                context: result.context,
                thinking: result.thinking,
              },
            });

            isClosed = true;
            controller.close();
          } catch (error) {
            if (!isClosed) {
              try {
                send({
                  type: "error",
                  data: {
                    error: error.message,
                  },
                });
              } catch (sendError) {
                console.error('[Chat API] 发送错误消息失败:', sendError);
              }
            }
            isClosed = true;
            try {
              controller.close();
            } catch (closeError) {
              // 流可能已经关闭，忽略错误
            }
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } else {
      // 非流式传输（兼容旧版本）
      const router = new AgentRouter();
      const result = await router.process(messages, context);

      return NextResponse.json({
        reply: result.reply,
        context: result.context,
        thinking: result.thinking,
      });
    }
  } catch (err) {
    console.error("Chat API error", err);
    return NextResponse.json(
      { error: "服务器内部错误", details: err.message },
      {
        status: 500
      }
    );
  }
}