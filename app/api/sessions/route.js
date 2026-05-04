import { NextResponse } from "next/server";
import {
  createCampaignSession,
  getAllCampaignSessions,
} from "../../../lib/db/campaign-session-dao.js";
import { getAuthenticatedAdvertiserUser } from "../../../lib/auth/advertiser-auth-http.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions
 * 获取所有 Campaign Sessions 列表
 * Query params:
 *   - status: 'draft' | 'published' | null（全部）
 *   - limit: 数量限制（默认 50）
 */
export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") || null;
    const limit = parseInt(searchParams.get("limit") || "50", 10);

    const sessions = await getAllCampaignSessions({
      status,
      limit,
      includeMessages: false, // 列表只返回元数据，避免 messages/context 过大导致 DB/网络压力
      advertiserUserId: auth.advertiserUserId,
    });

    return NextResponse.json({
      success: true,
      sessions,
      count: sessions.length,
    });
  } catch (error) {
    console.error("[Sessions API] 获取会话列表失败:", error);
    
    // 如果是表不存在的错误，返回更友好的提示
    if (error.code === 'TABLE_NOT_EXISTS' || error.message?.includes('不存在')) {
      return NextResponse.json(
        {
          success: false,
          error: "数据库表未创建。请先执行: node scripts/create-table-direct.js",
          code: 'TABLE_NOT_EXISTS',
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || "获取会话列表失败",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sessions
 * 创建新的 Campaign Session
 * Body:
 *   - title: string（可选）
 *   - messages: Array（必填）
 *   - context: Object（可选）
 *   - status: 'draft' | 'published'（默认 'draft'）
 */
export async function POST(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const body = await req.json();
    const { title, messages, context, status } = body;

    // 验证必填字段
    if (!Array.isArray(messages)) {
      return NextResponse.json(
        {
          success: false,
          error: "messages 必须是数组",
        },
        { status: 400 }
      );
    }

    const result = await createCampaignSession({
      title,
      messages,
      context: context || {},
      status: status || "draft",
      advertiserUserId: auth.advertiserUserId,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.message || "创建会话失败",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      session: result.session,
    });
  } catch (error) {
    console.error("[Sessions API] 创建会话失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "创建会话失败",
      },
      { status: 500 }
    );
  }
}

