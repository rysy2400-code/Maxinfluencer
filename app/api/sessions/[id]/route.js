import { NextResponse } from "next/server";
import {
  getCampaignSessionById,
  updateCampaignSession,
  deleteCampaignSession,
} from "../../../../lib/db/campaign-session-dao.js";
import {
  softDeleteCampaignBySessionId,
  softDeleteCampaignById,
} from "../../../../lib/db/campaign-dao.js";

/**
 * GET /api/sessions/[id]
 * 根据 ID 获取单个 Campaign Session
 */
export async function GET(req, { params }) {
  try {
    const { id } = params;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          error: "缺少会话 ID",
        },
        { status: 400 }
      );
    }

    const session = await getCampaignSessionById(id);

    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: "会话不存在",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      session,
    });
  } catch (error) {
    console.error("[Sessions API] 获取会话失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "获取会话失败",
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/sessions/[id]
 * 更新 Campaign Session
 * Body:
 *   - title: string（可选）
 *   - status: 'draft' | 'published'（可选）
 *   - messages: Array（可选）
 *   - context: Object（可选）
 */
export async function PUT(req, { params }) {
  try {
    const { id } = params;
    const body = await req.json();
    const { title, status, messages, context } = body;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          error: "缺少会话 ID",
        },
        { status: 400 }
      );
    }

    // 构建更新对象（只包含提供的字段）
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (status !== undefined) updates.status = status;
    if (messages !== undefined) {
      if (!Array.isArray(messages)) {
        return NextResponse.json(
          {
            success: false,
            error: "messages 必须是数组",
          },
          { status: 400 }
        );
      }
      updates.messages = messages;
    }
    if (context !== undefined) updates.context = context;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "没有提供要更新的字段",
        },
        { status: 400 }
      );
    }

    const result = await updateCampaignSession(id, updates);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.message || "更新会话失败",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      session: result.session,
    });
  } catch (error) {
    console.error("[Sessions API] 更新会话失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "更新会话失败",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sessions/[id]
 * 删除 Campaign Session
 */
export async function DELETE(req, { params }) {
  try {
    const { id } = params;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          error: "缺少会话 ID",
        },
        { status: 400 }
      );
    }

    const session = await getCampaignSessionById(id);
    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: "会话不存在",
        },
        { status: 404 }
      );
    }

    let result;
    // 草稿：物理删除；已发布：软删除关联 campaign（不可恢复）
    if (session.status === "published") {
      result = await softDeleteCampaignBySessionId(id, {
        deletedBy: "user",
        deleteReason: "用户在前端删除已发布 campaign",
      });
      // 历史数据：仅当按 session 查不到行时再按 context.campaignId 补删（避免无谓多一次 DB）
      if (
        !result.success &&
        typeof result.message === "string" &&
        result.message.includes("未找到关联的已发布 campaign") &&
        session.context?.campaignId
      ) {
        const byCampaignId = await softDeleteCampaignById(session.context.campaignId, {
          deletedBy: "user",
          deleteReason: "用户在前端删除已发布 campaign（按 context.campaignId 补删）",
        });
        if (byCampaignId.success) {
          result = byCampaignId;
        }
      }
      // 侧栏「已发布」会话在 DB 中无对应 tiktok_campaign 行时，仍允许从列表移除会话
      const orphan =
        !result.success &&
        typeof result.message === "string" &&
        (result.message.includes("未找到关联的已发布 campaign") ||
          result.message.includes("未找到该 campaign"));
      if (orphan) {
        result = await deleteCampaignSession(id);
      }
    } else {
      result = await deleteCampaignSession(id);
    }

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.message || "删除会话失败",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error("[Sessions API] 删除会话失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "删除会话失败",
      },
      { status: 500 }
    );
  }
}

